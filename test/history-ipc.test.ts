import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  controlAddress,
  HistoryControlServer,
  requestHistoryStart,
} from "../src/control/ipc.js";

/** A configured path comfortably past the 104-byte sun_path limit. */
function longSocketPath(root: string): string {
  return join(root, "a".repeat(120), "control.sock");
}

describe("history control IPC", () => {
  it("accepts a local start request and returns a job handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "wac-history-ipc-"));
    const path = join(root, "control.sock");
    const server = new HistoryControlServer(path, async (request) => ({
      jobId: `job-${request.chat}`,
      status: "queued",
      reused: false,
    }));
    await server.start();
    try {
      await expect(
        requestHistoryStart(path, {
          chat: "33600000000@s.whatsapp.net",
          since: 1_700_000_000,
        }),
      ).resolves.toMatchObject({ ok: true, status: "queued", reused: false });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a long configured path within the sun_path limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "wac-history-long-"));
    const configured = longSocketPath(root);
    const address = controlAddress(configured);

    expect(address).not.toBe(configured);
    if (process.platform === "win32") {
      expect(address.startsWith("\\\\.\\pipe\\")).toBe(true);
    } else {
      // The kernel truncates rather than rejecting, so the address we bind must
      // fit on its own; otherwise the socket silently lands somewhere else.
      expect(Buffer.byteLength(address, "utf8")).toBeLessThanOrEqual(100);
    }
    // Server and client both resolve through this function, so they agree.
    expect(controlAddress(configured)).toBe(address);
    await rm(root, { recursive: true, force: true });
  });

  it("serves and restarts on a path longer than sun_path", async () => {
    const root = await mkdtemp(join(tmpdir(), "wac-history-long-"));
    const path = longSocketPath(root);
    const handler = async () => ({
      jobId: "job-1",
      status: "queued",
      reused: false,
    });

    const server = new HistoryControlServer(path, handler);
    await server.start();
    try {
      await expect(
        requestHistoryStart(path, {
          chat: "33600000000@s.whatsapp.net",
          since: 1_700_000_000,
        }),
      ).resolves.toMatchObject({ ok: true, status: "queued" });
    } finally {
      await server.close();
    }

    // The truncated path is where an over-long socket used to be created, on
    // this installation as a stray file at the repo root.
    expect(existsSync(path.slice(0, 104))).toBe(false);

    // A second start must not trip over a leftover socket: this is the
    // EADDRINUSE-on-a-missing-file loop reported from the field.
    const restarted = new HistoryControlServer(path, handler);
    await restarted.start();
    try {
      await expect(
        requestHistoryStart(path, {
          chat: "33600000000@s.whatsapp.net",
          since: 1_700_000_000,
        }),
      ).resolves.toMatchObject({ ok: true, status: "queued" });
    } finally {
      await restarted.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
