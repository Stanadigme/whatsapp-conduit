import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WAMessage } from "baileys";
import { ingestMessage, type IngestDeps } from "../src/baileys/ingest.js";
import {
  downloadStoredMedia,
  reconstructMessageFromRawJson,
} from "../src/baileys/media-backfill.js";
import { resolveConfig, type Config } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  getAttachment,
  getMediaBackfillJob,
  getMessage,
  listMediaBackfillCandidates,
  setChatAllowed,
  upsertAccount,
  upsertAttachment,
  upsertChat,
  type MessageRow,
} from "../src/db/queries.js";
import { MediaBackfillCoordinator } from "../src/history/media-backfill-coordinator.js";
import { createLogger } from "../src/util/logging.js";

const baileysMock = vi.hoisted(() => ({ downloadMediaMessage: vi.fn() }));
vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("baileys")>();
  return { ...actual, downloadMediaMessage: baileysMock.downloadMediaMessage };
});

const ACCOUNT = "personal";
const CHAT_A = "a@s.whatsapp.net";
const CHAT_B = "b@s.whatsapp.net";

function audioMessage(id: string, chat: string, mediaKey?: Uint8Array): WAMessage {
  return {
    key: { remoteJid: chat, fromMe: false, id },
    messageTimestamp: 1700,
    pushName: "Alice",
    message: {
      audioMessage: {
        seconds: 3,
        mimetype: "audio/ogg; codecs=opus",
        ...(mediaKey ? { mediaKey } : {}),
      },
    },
  } as WAMessage;
}

let root: string;

beforeEach(async () => {
  baileysMock.downloadMediaMessage.mockReset();
  root = await mkdtemp(join(tmpdir(), "wac-media-backfill-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setupDeps(overrides: Record<string, unknown> = {}): IngestDeps {
  const config: Config = resolveConfig(
    { paths: { data_dir: root }, ...overrides },
    { dataDir: root },
  );
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: ACCOUNT });
  return { db, accountId: ACCOUNT, config, logger: createLogger({ level: "error" }) };
}

describe("reconstructMessageFromRawJson", () => {
  it("round-trips a base64-encoded mediaKey back into a real Uint8Array", () => {
    const deps = setupDeps();
    setChatAllowed(deps.db, ACCOUNT, CHAT_A, true);
    upsertChat(deps.db, { accountId: ACCOUNT, jid: CHAT_A });
    const key = Uint8Array.from([1, 2, 3, 4, 5]);
    const stored = ingestMessage(deps, audioMessage("M1", CHAT_A, key));
    expect(stored).not.toBeNull();
    const row = getMessage(deps.db, ACCOUNT, CHAT_A, "M1");
    expect(row?.raw_json).toEqual(expect.any(String));

    const reconstructed = reconstructMessageFromRawJson(row?.raw_json ?? null);
    expect(reconstructed).not.toBeNull();
    const audio = reconstructed?.message?.audioMessage;
    expect(audio?.mediaKey).toBeInstanceOf(Uint8Array);
    expect(Array.from(audio?.mediaKey ?? [])).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns null when there is no raw_json to work from", () => {
    expect(reconstructMessageFromRawJson(null)).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", () => {
    expect(reconstructMessageFromRawJson("{not json")).toBeNull();
  });
});

describe("listMediaBackfillCandidates", () => {
  it("finds media messages with no attachment row and excludes downloaded or non-media ones", () => {
    const deps = setupDeps();
    upsertChat(deps.db, { accountId: ACCOUNT, jid: CHAT_A });
    setChatAllowed(deps.db, ACCOUNT, CHAT_A, true);

    // No attachments row at all: store_media was off at ingestion.
    ingestMessage(deps, audioMessage("M1", CHAT_A, Uint8Array.from([1])));

    // Attachments row exists but never downloaded: still a candidate.
    ingestMessage(deps, audioMessage("M2", CHAT_A, Uint8Array.from([2])));
    upsertAttachment(deps.db, {
      accountId: ACCOUNT,
      chatJid: CHAT_A,
      messageId: "M2",
      mediaType: "audio",
    });

    // Already downloaded: not a candidate.
    ingestMessage(deps, audioMessage("M3", CHAT_A, Uint8Array.from([3])));
    upsertAttachment(deps.db, {
      accountId: ACCOUNT,
      chatJid: CHAT_A,
      messageId: "M3",
      mediaType: "audio",
      downloadedAt: 1_700_000_000,
    });

    const candidates = listMediaBackfillCandidates(deps.db, ACCOUNT, CHAT_A, 100);
    expect(candidates.map((row: MessageRow) => row.message_id).sort()).toEqual([
      "M1",
      "M2",
    ]);
  });
});

describe("downloadStoredMedia", () => {
  it("downloads and persists media reconstructed from raw_json", async () => {
    const deps = setupDeps({ privacy: { store_media: true } });
    upsertChat(deps.db, { accountId: ACCOUNT, jid: CHAT_A });
    setChatAllowed(deps.db, ACCOUNT, CHAT_A, true);
    ingestMessage(deps, audioMessage("M1", CHAT_A, Uint8Array.from([9, 9])));
    const row = getMessage(deps.db, ACCOUNT, CHAT_A, "M1");
    if (!row) throw new Error("expected message row");

    baileysMock.downloadMediaMessage.mockResolvedValue(
      Readable.from([Buffer.from("audio bytes")]),
    );

    const attempted = await downloadStoredMedia(row, deps);
    expect(attempted).toBe(true);
    expect(baileysMock.downloadMediaMessage).toHaveBeenCalledTimes(1);

    const attachment = getAttachment(deps.db, ACCOUNT, CHAT_A, "M1");
    expect(attachment?.downloaded_at).toEqual(expect.any(Number));
    expect(attachment?.sha256).toEqual(expect.any(String));
  });

  it("returns false without attempting a download when raw_json has no media key", async () => {
    // store_message_text: false suppresses raw_json too (src/baileys/ingest.ts,
    // rawJsonOfValue) — nothing usable was ever captured for this message.
    const deps = setupDeps({
      privacy: { store_media: true, store_message_text: false },
    });
    upsertChat(deps.db, { accountId: ACCOUNT, jid: CHAT_A });
    setChatAllowed(deps.db, ACCOUNT, CHAT_A, true);
    ingestMessage(deps, audioMessage("M1", CHAT_A, Uint8Array.from([1])));
    const row = getMessage(deps.db, ACCOUNT, CHAT_A, "M1");
    if (!row) throw new Error("expected message row");
    expect(row.raw_json).toBeNull();

    const attempted = await downloadStoredMedia(row, deps);
    expect(attempted).toBe(false);
    expect(baileysMock.downloadMediaMessage).not.toHaveBeenCalled();
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe("MediaBackfillCoordinator", () => {
  it("backfills a single chat sequentially and tracks progress", async () => {
    const deps = setupDeps({ privacy: { store_media: true } });
    upsertChat(deps.db, { accountId: ACCOUNT, jid: CHAT_A });
    setChatAllowed(deps.db, ACCOUNT, CHAT_A, true);
    ingestMessage(deps, audioMessage("M1", CHAT_A, Uint8Array.from([1])));
    ingestMessage(deps, audioMessage("M2", CHAT_A, Uint8Array.from([2])));
    baileysMock.downloadMediaMessage.mockResolvedValue(
      Readable.from([Buffer.from("audio bytes")]),
    );

    const coordinator = new MediaBackfillCoordinator(deps);
    const { job, reused } = await coordinator.start(CHAT_A);
    expect(reused).toBe(false);

    await waitFor(() => {
      const current = getMediaBackfillJob(deps.db, ACCOUNT, job.id);
      return current?.status === "completed";
    });

    const finished = getMediaBackfillJob(deps.db, ACCOUNT, job.id);
    expect(finished?.attachments_found).toBe(2);
    expect(finished?.attachments_downloaded).toBe(2);
    expect(finished?.attachments_failed).toBe(0);
  });

  it("processes every allowed chat one at a time on a bulk run", async () => {
    const deps = setupDeps({ privacy: { store_media: true } });
    upsertChat(deps.db, { accountId: ACCOUNT, jid: CHAT_A });
    upsertChat(deps.db, { accountId: ACCOUNT, jid: CHAT_B });
    setChatAllowed(deps.db, ACCOUNT, CHAT_A, true);
    setChatAllowed(deps.db, ACCOUNT, CHAT_B, true);
    ingestMessage(deps, audioMessage("M1", CHAT_A, Uint8Array.from([1])));
    ingestMessage(deps, audioMessage("M2", CHAT_B, Uint8Array.from([2])));
    baileysMock.downloadMediaMessage.mockResolvedValue(
      Readable.from([Buffer.from("audio bytes")]),
    );

    const coordinator = new MediaBackfillCoordinator(deps);
    const { job } = await coordinator.start(null);
    await waitFor(() => {
      const current = getMediaBackfillJob(deps.db, ACCOUNT, job.id);
      return current?.status === "completed";
    });

    const finished = getMediaBackfillJob(deps.db, ACCOUNT, job.id);
    expect(finished?.chat_jid).toBeNull();
    expect(finished?.attachments_found).toBe(2);
    expect(finished?.attachments_downloaded).toBe(2);
  });

  it("reuses the active job instead of starting a second one", async () => {
    const deps = setupDeps({ privacy: { store_media: true } });
    upsertChat(deps.db, { accountId: ACCOUNT, jid: CHAT_A });
    setChatAllowed(deps.db, ACCOUNT, CHAT_A, true);
    ingestMessage(deps, audioMessage("M1", CHAT_A, Uint8Array.from([1])));
    // Held open, not left dangling: released and awaited to completion below
    // so it cannot bleed into the next test through the shared "baileys" mock.
    let releaseDownload: (() => void) | undefined;
    baileysMock.downloadMediaMessage.mockImplementation(
      () =>
        new Promise<Readable>((resolve) => {
          releaseDownload = () => resolve(Readable.from([Buffer.from("x")]));
        }),
    );

    const coordinator = new MediaBackfillCoordinator(deps);
    const first = await coordinator.start(CHAT_A);
    const second = await coordinator.start(CHAT_A);
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);

    releaseDownload?.();
    await waitFor(() => {
      const current = getMediaBackfillJob(deps.db, ACCOUNT, first.job.id);
      return current?.status === "completed";
    });
  });

  it("marks a permanently unavailable media as failed without retrying forever", async () => {
    const deps = setupDeps({ privacy: { store_media: true } });
    upsertChat(deps.db, { accountId: ACCOUNT, jid: CHAT_A });
    setChatAllowed(deps.db, ACCOUNT, CHAT_A, true);
    ingestMessage(deps, audioMessage("M1", CHAT_A, Uint8Array.from([1])));
    baileysMock.downloadMediaMessage.mockRejectedValue(
      new Error("media no longer available"),
    );

    const coordinator = new MediaBackfillCoordinator(deps);
    const { job } = await coordinator.start(CHAT_A);
    await waitFor(() => {
      const current = getMediaBackfillJob(deps.db, ACCOUNT, job.id);
      return current?.status === "completed";
    });

    const finished = getMediaBackfillJob(deps.db, ACCOUNT, job.id);
    expect(finished?.attachments_failed).toBe(1);
    expect(finished?.attachments_downloaded).toBe(0);
    const attachment = getAttachment(deps.db, ACCOUNT, CHAT_A, "M1");
    expect(attachment?.download_last_error).toContain("media no longer available");
  });
});
