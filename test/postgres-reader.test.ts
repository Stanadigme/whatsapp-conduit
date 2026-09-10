import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { resolveConfig } from "../src/config.js";
import { openDb, type Database } from "../src/db/index.js";
import { upsertDirectoryGroupMember } from "../src/db/directory.js";
import {
  createHistoryJob,
  insertTranscription,
  setChatAllowed,
  setChatBlocked,
  upsertAccount,
  upsertAttachment,
  upsertChat,
  upsertMessage,
  upsertTranscriptionJob,
} from "../src/db/queries.js";
import {
  flushPostgresProjection,
  shutdownPostgresProjection,
  startPostgresProjection,
} from "../src/db/postgres-projection.js";
import { runPostgresMigrations } from "../src/db/postgres.js";
import { createSqliteReader } from "../src/db/sqlite-reader.js";
import { createPostgresReader } from "../src/db/postgres-reader.js";
import type { ClientDataReader } from "../src/db/reader.js";
import { createLogger } from "../src/util/logging.js";

/**
 * Contract test for the phase 2 read port: seeds one SQLite database, flushes
 * it to a real, throwaway PostgreSQL, and asserts the two readers agree on
 * every operation MCP/dashboard/export use — the same seed data through both
 * backends is a stronger guarantee than testing either one in isolation.
 *
 * Skipped unless WA_TEST_POSTGRES_URL is set, same as postgres-integration.test.ts:
 *   docker run --rm -d --name wac-pg -e POSTGRES_PASSWORD=test \
 *     -p 55432:5432 postgres:17-alpine
 *   WA_TEST_POSTGRES_URL=postgresql://postgres:test@127.0.0.1:55432/postgres \
 *     pnpm test postgres-reader
 *
 * Run this file and postgres-integration.test.ts separately, not in the same
 * vitest invocation: both reset the target database's whole `public` schema
 * in beforeEach, and vitest runs different test files in parallel by
 * default, so two files resetting the same live schema race each other.
 */
const url = process.env.WA_TEST_POSTGRES_URL;
const pool = url ? new Pool({ connectionString: url, max: 1 }) : undefined;
const logger = createLogger({ level: "error" });

afterAll(async () => {
  await shutdownPostgresProjection();
  await pool?.end();
});

async function resetSchema(): Promise<void> {
  await pool!.query("drop schema public cascade; create schema public");
  const client = await pool!.connect();
  try {
    await runPostgresMigrations(client);
  } finally {
    client.release();
  }
}

const open: Database[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

async function seed(mediaDir: string): Promise<{
  sqlite: ClientDataReader;
  postgres: ClientDataReader;
  db: Database;
}> {
  await shutdownPostgresProjection();
  const db = openDb(":memory:", { migrate: true });
  open.push(db);
  // The projection's shutdown ends its pool; wrap ours so the shared,
  // test-owned pool survives across seed() calls within one test file.
  startPostgresProjection(
    { connect: () => pool!.connect(), end: async () => undefined },
    logger,
  );

  upsertAccount(db, { id: "personal", selfJid: "33700000000@s.whatsapp.net" });

  upsertChat(db, {
    accountId: "personal",
    jid: "33600000000@s.whatsapp.net",
    name: "Allowed Contact",
  });
  setChatAllowed(db, "personal", "33600000000@s.whatsapp.net", true);

  upsertChat(db, {
    accountId: "personal",
    jid: "33600000001@s.whatsapp.net",
    name: "Blocked Contact",
  });
  setChatBlocked(db, "personal", "33600000001@s.whatsapp.net", true);

  upsertChat(db, {
    accountId: "personal",
    jid: "33600000002@s.whatsapp.net",
    name: "Discovered Contact",
  });

  upsertChat(db, {
    accountId: "personal",
    jid: "120@g.us",
    name: "Allowed Group",
    isGroup: true,
  });
  setChatAllowed(db, "personal", "120@g.us", true);
  upsertDirectoryGroupMember(db, {
    accountId: "personal",
    groupJid: "120@g.us",
    participantJid: "33600000003@s.whatsapp.net",
    role: "admin",
  });

  upsertMessage(db, {
    accountId: "personal",
    chatJid: "33600000000@s.whatsapp.net",
    messageId: "M1",
    senderJid: "33600000000@s.whatsapp.net",
    timestamp: 1_700_000_000,
    messageType: "text",
    text: "Réunion projet demain",
  });
  upsertMessage(db, {
    accountId: "personal",
    chatJid: "33600000000@s.whatsapp.net",
    messageId: "M2",
    senderJid: "33600000000@s.whatsapp.net",
    timestamp: 1_700_000_001,
    messageType: "audio",
    hasMedia: true,
    durationS: 4,
  });
  const audioPath = join(mediaDir, `${"c".repeat(64)}.opus`);
  writeFileSync(audioPath, "fake-audio");
  upsertAttachment(db, {
    accountId: "personal",
    chatJid: "33600000000@s.whatsapp.net",
    messageId: "M2",
    mediaType: "audio",
    mimeType: "audio/ogg",
    filePath: audioPath,
    sha256: "c".repeat(64),
    sizeBytes: 10,
    downloadedAt: 1_700_000_001,
  });
  upsertTranscriptionJob(db, {
    accountId: "personal",
    chatJid: "33600000000@s.whatsapp.net",
    messageId: "M2",
    status: "done",
    attempts: 1,
  });
  insertTranscription(db, {
    accountId: "personal",
    chatJid: "33600000000@s.whatsapp.net",
    messageId: "M2",
    textRaw: "sortie brute",
    engine: "whisper-local",
  });
  db.prepare(
    "update transcriptions set text_corrected = ? where message_id = ?",
  ).run("sortie corrigee", "M2");

  upsertMessage(db, {
    accountId: "personal",
    chatJid: "33600000001@s.whatsapp.net",
    messageId: "M3",
    senderJid: "33600000001@s.whatsapp.net",
    timestamp: 1_700_000_002,
    messageType: "text",
    text: "message from a blocked chat",
  });

  createHistoryJob(db, {
    id: "job-1",
    accountId: "personal",
    chatJid: "33600000000@s.whatsapp.net",
    sinceTs: 1_000,
    untilTs: 2_000,
  });

  await flushPostgresProjection();

  const config = resolveConfig(
    { paths: { media_dir: mediaDir } },
    { dataDir: "/data" },
  );
  return {
    sqlite: createSqliteReader(db, config, "personal"),
    postgres: createPostgresReader(pool!, config, "personal"),
    db,
  };
}

describe.skipIf(!url)("PostgresReader parity with SqliteReader", () => {
  beforeEach(resetSchema);

  it("agrees on health counts", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    // schemaVersion names the latest migration file, which differs by design
    // between the two independent migration histories (SQLite vs Postgres).
    expect(await postgres.health()).toEqual({
      ...(await sqlite.health()),
      schemaVersion: expect.any(String),
    });
  });

  it("agrees on the allowed chats list, in the same order", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const [sq, pg] = await Promise.all([
      sqlite.listChats({}),
      postgres.listChats({}),
    ]);
    expect(pg.items.map((c) => c.jid)).toEqual(sq.items.map((c) => c.jid));
    expect(pg.items).toEqual(sq.items);
  });

  it("agrees on the dashboard's unfiltered chat list", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const [sq, pg] = await Promise.all([
      sqlite.listDashboardChats(),
      postgres.listDashboardChats(),
    ]);
    expect(pg.map((c) => ({ ...c, lastSyncedAt: null }))).toEqual(
      sq.map((c) => ({ ...c, lastSyncedAt: null })),
    );
  });

  it("agrees on group participants", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const [sq, pg] = await Promise.all([
      sqlite.listGroupParticipants("120@g.us"),
      postgres.listGroupParticipants("120@g.us"),
    ]);
    expect(pg.map((m) => ({ jid: m.jid, role: m.role, is_active: m.is_active }))).toEqual(
      sq.map((m) => ({ jid: m.jid, role: m.role, is_active: m.is_active })),
    );
  });

  it("agrees on a policy-checked message and never leaks a blocked chat", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    expect(await postgres.getMessage("33600000000@s.whatsapp.net", "M1")).toEqual(
      await sqlite.getMessage("33600000000@s.whatsapp.net", "M1"),
    );
    await expect(
      postgres.getMessage("33600000001@s.whatsapp.net", "M3"),
    ).rejects.toThrow("chat is not available");
    await expect(
      sqlite.getMessage("33600000001@s.whatsapp.net", "M3"),
    ).rejects.toThrow("chat is not available");
  });

  it("agrees on listMessages, including the effective transcript", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const [sq, pg] = await Promise.all([
      sqlite.listMessages({}),
      postgres.listMessages({}),
    ]);
    expect(pg).toEqual(sq);
    const audio = pg.items.find((m) => m.messageId === "M2");
    expect(audio?.textCorrected).toBe("sortie corrigee");
    expect(audio?.textRaw).toBe("sortie brute");
  });

  it("agrees on message context around the audio message", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const [sq, pg] = await Promise.all([
      sqlite.messageContext("33600000000@s.whatsapp.net", "M2", 5, 5),
      postgres.messageContext("33600000000@s.whatsapp.net", "M2", 5, 5),
    ]);
    expect(pg).toEqual(sq);
  });

  it("finds a message by unaccented, case-insensitive search on both backends", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const [sq, pg] = await Promise.all([
      sqlite.searchMessages("reunion", {}),
      postgres.searchMessages("reunion", {}),
    ]);
    expect(sq.items.map((m) => m.messageId)).toEqual(["M1"]);
    expect(pg.items.map((m) => m.messageId)).toEqual(["M1"]);
  });

  it("finds the corrected transcript, not the raw one, via search", async () => {
    const { postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const hit = await postgres.searchMessages("corrigee", {});
    expect(hit.items.map((m) => m.messageId)).toEqual(["M2"]);
    const miss = await postgres.searchMessages("brute", {});
    expect(miss.items).toEqual([]);
  });

  it("agrees on materialized chat message stats", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const [sq, pg] = await Promise.all([
      sqlite.chatMessageStats("33600000000@s.whatsapp.net"),
      postgres.chatMessageStats("33600000000@s.whatsapp.net"),
    ]);
    expect(pg).toEqual({ ...sq, updatedAt: expect.any(Number) });
  });

  it("never exposes a raw local path from media metadata, on either backend", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const [sq, pg] = await Promise.all([
      sqlite.getMediaMetadata("33600000000@s.whatsapp.net", "M2"),
      postgres.getMediaMetadata("33600000000@s.whatsapp.net", "M2"),
    ]);
    expect(pg).toEqual(sq);
    expect(JSON.stringify(pg)).not.toMatch(/\/tmp|wac-pgr/);
  });

  it("resolves the same local media file by recomputing its path from sha256", async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "wac-pgr-"));
    const { postgres } = await seed(mediaDir);
    const resolved = await postgres.resolveLocalMediaFile(
      "33600000000@s.whatsapp.net",
      "M2",
      0,
    );
    expect(resolved?.path).toBe(join(mediaDir, `${"c".repeat(64)}.opus`));
  });

  it("refuses to resolve a media file in a blocked chat, on both backends", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    await expect(
      postgres.resolveLocalMediaFile("33600000001@s.whatsapp.net", "M3", 0),
    ).rejects.toThrow("chat is not available");
    await expect(
      sqlite.resolveLocalMediaFile("33600000001@s.whatsapp.net", "M3", 0),
    ).rejects.toThrow("chat is not available");
  });

  it("agrees on the effective transcript view", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    expect(
      await postgres.getTranscript("33600000000@s.whatsapp.net", "M2"),
    ).toEqual(await sqlite.getTranscript("33600000000@s.whatsapp.net", "M2"));
  });

  it("applies a manual correction without touching text_raw (invariant 8)", async () => {
    const { postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const applied = await postgres.setTranscriptionCorrection({
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "M2",
      textCorrected: "nouvelle correction",
    });
    expect(applied).toBe(true);
    const transcript = await postgres.getTranscript(
      "33600000000@s.whatsapp.net",
      "M2",
    );
    expect(transcript.text_corrected).toBe("nouvelle correction");
    expect(transcript.text_raw).toBe("sortie brute");
  });

  it("agrees on history jobs", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    expect(await postgres.getHistoryJob("job-1")).toEqual(
      await sqlite.getHistoryJob("job-1"),
    );
    expect(await postgres.getActiveHistoryJob()).toEqual(
      await sqlite.getActiveHistoryJob(),
    );
  });

  it("agrees on export rows and excludes the blocked chat under --all", async () => {
    const { sqlite, postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    const [sq, pg] = await Promise.all([
      sqlite.exportRows({ allowedOnly: false }),
      postgres.exportRows({ allowedOnly: false }),
    ]);
    expect(pg.map((r) => r.message_id)).toEqual(sq.map((r) => r.message_id));
    expect(pg.map((r) => r.chat_jid)).not.toContain("33600000001@s.whatsapp.net");
  });

  it("round-trips a consumer offset", async () => {
    const { postgres } = await seed(mkdtempSync(join(tmpdir(), "wac-pgr-")));
    expect(await postgres.getConsumerOffset("export")).toBeUndefined();
    await postgres.setConsumerOffset("export", { lastSeenEventId: 7 });
    const offset = await postgres.getConsumerOffset("export");
    expect(offset?.last_seen_event_id).toBe(7);
  });

});
