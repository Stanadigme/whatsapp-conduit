import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runRun } from "../src/commands/run.js";
import { requestDirectoryResync } from "../src/control/ipc.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import type { ConduitConnection } from "../src/baileys/connect.js";
import type { AuthState } from "../src/baileys/auth.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-run-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("runRun on the default (baileys) transport", () => {
  it("continues a linked socket without closing it until shutdown", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "resync_directory_on_connect: true",
        "resync_directory_on_connect: false",
      ),
    );
    const db = openDb(loadConfig(configPath).paths.sqlite, { migrate: true });
    const promote = vi.fn();
    const stop = vi.fn(async () => undefined);
    const release = vi.fn();
    const connection = {
      promote,
      stop,
      socket: () => ({ ev: { on: vi.fn() } }),
    } as unknown as ConduitConnection;
    const controller = new AbortController();
    const running = runRun(
      { configPath, signal: controller.signal },
      {
        connection,
        authState: {} as AuthState,
        sessionLock: { release },
        db,
      },
    );

    await vi.waitFor(() => expect(promote).toHaveBeenCalledOnce());
    expect(stop).not.toHaveBeenCalled();
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("waits for a dashboard pairing request without opening Baileys", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });
    const controller = new AbortController();
    const run = runRun({ configPath, signal: controller.signal });
    const { paths } = loadConfig(configPath);

    await vi.waitFor(async () => {
      await expect(requestDirectoryResync(paths.controlSocket)).rejects.toThrow(
        "awaiting an operator pairing request",
      );
    });

    // The beta-profile replay queue is opt-in: no key file, so ingestion has no
    // way to write a snapshot.
    expect(existsSync(paths.outboxKey)).toBe(false);

    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });

  it("creates the outbox key only when the queue is opted in", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "outbox:\n    enabled: false",
        "outbox:\n    enabled: true",
      ),
    );
    const { paths, persistence } = loadConfig(configPath);
    expect(persistence.outbox.enabled).toBe(true);
    const controller = new AbortController();
    const run = runRun({ configPath, signal: controller.signal });

    await vi.waitFor(() => expect(existsSync(paths.outboxKey)).toBe(true));

    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });
});
