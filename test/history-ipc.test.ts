import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HistoryControlServer,
  requestHistoryStart,
} from "../src/control/ipc.js";

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
});
