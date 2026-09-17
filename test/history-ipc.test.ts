import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  controlAddress,
  HistoryControlServer,
  requestBaileysPairingStart,
  requestDirectoryResync,
  requestHistoryStart,
  requestMediaBackfillStatus,
  type HistoryStartRequest,
} from "../src/control/ipc.js";

/** A configured path comfortably past the 104-byte sun_path limit. */
function longSocketPath(root: string): string {
  return join(root, "a".repeat(120), "control.sock");
}

describe("history control IPC", () => {
  it("accepts a local start request and returns a job handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "wac-history-ipc-"));
    const path = join(root, "control.sock");
    const server = new HistoryControlServer(path, async (request) => {
      if (request.op === "directory.resync") {
        return { resynced: { contacts: 3, groups: 1 } };
      }
      if (request.op !== "history.start") {
        return { pairing: { status: "starting" } };
      }
      return { jobId: `job-${request.chat}`, status: "queued", reused: false };
    });
    await server.start();
    try {
      await expect(
        requestHistoryStart(path, {
          chat: "33600000000@s.whatsapp.net",
          since: 1_700_000_000,
        }),
      ).resolves.toMatchObject({ ok: true, status: "queued", reused: false });
      await expect(requestDirectoryResync(path)).resolves.toMatchObject({
        ok: true,
        resynced: { contacts: 3, groups: 1 },
      });
      await expect(requestBaileysPairingStart(path)).resolves.toMatchObject({
        ok: true,
        pairing: { status: "starting" },
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips an optional anchor to the handler, present and absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "wac-history-ipc-"));
    const path = join(root, "control.sock");
    let receivedAnchor: HistoryStartRequest["anchor"];
    const server = new HistoryControlServer(path, async (request) => {
      if (request.op !== "history.start") throw new Error("unexpected op");
      receivedAnchor = request.anchor;
      return { jobId: `job-${request.chat}`, status: "queued", reused: false };
    });
    await server.start();
    try {
      const anchor = {
        sender: "33600000000@s.whatsapp.net",
        id: "3EB0ABC123",
        timestamp: 1_700_000_500,
      };
      await expect(
        requestHistoryStart(path, {
          chat: "33600000000@s.whatsapp.net",
          since: 1_700_000_000,
          anchor,
        }),
      ).resolves.toMatchObject({ ok: true, status: "queued" });
      expect(receivedAnchor).toEqual(anchor);

      await expect(
        requestHistoryStart(path, {
          chat: "33600000000@s.whatsapp.net",
          since: 1_700_000_000,
        }),
      ).resolves.toMatchObject({ ok: true, status: "queued" });
      expect(receivedAnchor).toBeUndefined();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a history.start anchor with an empty sender or id", async () => {
    const root = await mkdtemp(join(tmpdir(), "wac-history-ipc-"));
    const path = join(root, "control.sock");
    const server = new HistoryControlServer(path, async () => ({
      jobId: "job-1",
      status: "queued",
      reused: false,
    }));
    await server.start();
    try {
      const address = controlAddress(path);
      const response = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(address);
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
        });
        socket.on("close", () => resolve(buffer));
        socket.on("error", reject);
        socket.on("connect", () => {
          socket.write(
            `${JSON.stringify({
              op: "history.start",
              requestId: "r1",
              chat: "33600000000@s.whatsapp.net",
              since: 1_700_000_000,
              anchor: { sender: "", id: "x", timestamp: 1 },
            })}\n`,
          );
        });
      });
      expect(JSON.parse(response)).toMatchObject({ ok: false });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a handler failure message back to the caller", async () => {
    const root = await mkdtemp(join(tmpdir(), "wac-history-ipc-"));
    const path = join(root, "control.sock");
    const server = new HistoryControlServer(path, async () => {
      throw new Error("not connected to WhatsApp");
    });
    await server.start();
    try {
      await expect(requestDirectoryResync(path)).rejects.toThrow(
        "not connected to WhatsApp",
      );
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads only media backfill progress, including an absent job", async () => {
    const root = await mkdtemp(join(tmpdir(), "wac-backfill-ipc-"));
    const path = join(root, "control.sock");
    const server = new HistoryControlServer(path, async (request) => {
      if (request.op !== "media-backfill.status") throw new Error("unexpected op");
      if (request.jobId === "other-account") throw new Error("access denied");
      return {
        mediaBackfill: request.jobId === "missing"
          ? null
          : {
              jobId: "job-1",
              status: "running",
              attachmentsFound: 2,
              attachmentsDownloaded: 1,
              attachmentsFailed: 0,
              createdAt: 1_700_000_000,
              startedAt: 1_700_000_001,
              updatedAt: 1_700_000_002,
              completedAt: null,
            },
      };
    });
    await server.start();
    try {
      const active = await requestMediaBackfillStatus(path);
      expect(active.mediaBackfill).toEqual({
        jobId: "job-1",
        status: "running",
        attachmentsFound: 2,
        attachmentsDownloaded: 1,
        attachmentsFailed: 0,
        createdAt: 1_700_000_000,
        startedAt: 1_700_000_001,
        updatedAt: 1_700_000_002,
        completedAt: null,
      });
      await expect(requestMediaBackfillStatus(path, { jobId: "missing" }))
        .resolves.toMatchObject({ ok: true, mediaBackfill: null });
      await expect(requestMediaBackfillStatus(path, { jobId: "other-account" }))
        .rejects.toThrow("access denied");
      await expect(requestMediaBackfillStatus(path, { jobId: "" }))
        .rejects.toThrow("invalid request");
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
