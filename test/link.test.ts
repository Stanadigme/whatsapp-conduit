import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WASocket } from "baileys";
import type { ConnectionDeps } from "../src/baileys/connect.js";
import { requestPairingCode, runLink } from "../src/commands/link.js";
import { runInit } from "../src/commands/init.js";
import { buildStatusReport } from "../src/commands/status.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-link-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("pairing-code readiness", () => {
  it("waits for the WebSocket before requesting a code", async () => {
    let releaseReady!: () => void;
    const waitForSocketOpen = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReady = resolve;
        }),
    );
    const requestPairingCodeMock = vi.fn().mockResolvedValue("ABCD1234");
    const socket = {
      waitForSocketOpen,
      requestPairingCode: requestPairingCodeMock,
    };

    const result = requestPairingCode(socket, "49123456789");
    await Promise.resolve();

    expect(waitForSocketOpen).toHaveBeenCalledOnce();
    expect(requestPairingCodeMock).not.toHaveBeenCalled();

    releaseReady();
    await expect(result).resolves.toBe("ABCD1234");
    expect(requestPairingCodeMock).toHaveBeenCalledWith("49123456789");
  });

  it("does not request a code when the socket readiness wait fails", async () => {
    const requestPairingCodeMock = vi.fn();
    const socket = {
      waitForSocketOpen: vi.fn().mockRejectedValue(new Error("closed")),
      requestPairingCode: requestPairingCodeMock,
    };

    await expect(requestPairingCode(socket, "49123456789")).rejects.toThrow(
      "closed",
    );
    expect(requestPairingCodeMock).not.toHaveBeenCalled();
  });

  it("starts pairing only after Baileys emits the post-handshake QR event", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });

    const requestPairingCodeMock = vi.fn().mockResolvedValue("ABCD1234");
    const socket = {
      waitForSocketOpen: vi.fn(async () => undefined),
      requestPairingCode: requestPairingCodeMock,
    } as unknown as WASocket;

    const connectionFactory = ({ handlers }: ConnectionDeps) => ({
      async start(): Promise<void> {
        handlers.onSocket?.(socket);
        handlers.onConnecting?.();
        expect(requestPairingCodeMock).not.toHaveBeenCalled();
        handlers.onQr?.("opaque-qr-payload");
        await Promise.resolve();
        handlers.onOpen?.({ selfJid: "49123@s.whatsapp.net" });
      },
      stop(): void {},
    });

    await runLink(
      { configPath, phoneNumber: "49123456789" },
      { connectionFactory },
    );

    expect(requestPairingCodeMock).toHaveBeenCalledWith("49123456789");
  });

  it("cleans auth state when pairing fails after the readiness event", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });

    const requestPairingCodeMock = vi
      .fn()
      .mockRejectedValue({ output: { statusCode: 428 } });
    const socket = {
      waitForSocketOpen: vi.fn(async () => undefined),
      requestPairingCode: requestPairingCodeMock,
    } as unknown as WASocket;

    const connectionFactory = ({ handlers }: ConnectionDeps) => ({
      async start(): Promise<void> {
        handlers.onSocket?.(socket);
        handlers.onQr?.("opaque-qr-payload");
        await Promise.resolve();
      },
      stop(): void {},
    });

    await expect(
      runLink(
        { configPath, phoneNumber: "49123456789" },
        { connectionFactory },
      ),
    ).rejects.toThrow("status 428");
    expect(buildStatusReport(configPath).authLinked).toBe(false);
  });
});
