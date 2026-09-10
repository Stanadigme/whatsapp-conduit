import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { WAMessage } from "baileys";
import { Pool } from "pg";
import { ingestMessage } from "../src/baileys/ingest.js";
import { resolveConfig } from "../src/config.js";
import { openDb, type Database } from "../src/db/index.js";
import { upsertDirectoryGroupMember } from "../src/db/directory.js";
import {
  createHistoryJob,
  insertTranscription,
  setChatAllowed,
  upsertAccount,
  upsertAttachment,
  upsertTranscriptionJob,
} from "../src/db/queries.js";
import {
  flushPostgresProjection,
  shutdownPostgresProjection,
  startPostgresProjection,
} from "../src/db/postgres-projection.js";
import { runPostgresMigrations } from "../src/db/postgres.js";
import { createLogger } from "../src/util/logging.js";

/**
 * Contract tests against a real, throwaway PostgreSQL. Skipped unless an
 * ephemeral instance is provided, so `pnpm test` stays offline:
 *
 *   docker run --rm -d --name wac-pg -e POSTGRES_PASSWORD=test \
 *     -p 55432:5432 postgres:17-alpine
 *   WA_TEST_POSTGRES_URL=postgresql://postgres:test@127.0.0.1:55432/postgres \
 *     pnpm test postgres-integration
 *
 * TLS is deliberately not exercised here — it is a connection concern, covered
 * by test/postgres-config.test.ts.
 *
 * Run this file and postgres-reader.test.ts separately, not in the same
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
}

async function migrate(): Promise<{ applied: string[] }> {
  const client = await pool!.connect();
  try {
    return await runPostgresMigrations(client);
  } finally {
    client.release();
  }
}

function seededDb(): Database {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "personal" });
  return db;
}

function message(id: string, text: string): WAMessage {
  return {
    key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id },
    messageTimestamp: 1_700,
    pushName: "Alice",
    message: { conversation: text },
  } as WAMessage;
}

function deps(db: Database) {
  return {
    db,
    accountId: "personal",
    config: resolveConfig({}, { dataDir: "/data" }),
    logger,
  };
}

async function count(table: string): Promise<number> {
  const result = await pool!.query<{ n: string }>(
    `select count(*) as n from ${table}`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

describe.skipIf(!url)("PostgreSQL contract", () => {
  let db: Database;

  beforeEach(async () => {
    await resetSchema();
    await migrate();
    await shutdownPostgresProjection();
    db = seededDb();
    startPostgresProjection(
      { connect: () => pool!.connect(), end: async () => undefined },
      logger,
    );
  });

  it("applies migrations once and is a no-op when repeated", async () => {
    const second = await migrate();
    expect(second.applied).toEqual([]);
    const third = await migrate();
    expect(third.applied).toEqual([]);
    expect(
      (await pool!.query("select name from schema_migrations order by name"))
        .rows,
    ).toEqual([
      { name: "0001_message_snapshots.sql" },
      { name: "0002_alpha_projection.sql" },
      { name: "0003_export_offsets.sql" },
      { name: "0004_message_search.sql" },
      { name: "0005_message_surrogate_id.sql" },
    ]);
  });

  it("projects a message with its attachment, transcription and stats", async () => {
    ingestMessage(deps(db), message("M1", "bonjour"));
    upsertAttachment(db, {
      accountId: "personal",
      chatJid: "c@s.whatsapp.net",
      messageId: "M1",
      mediaType: "audio",
      mimeType: "audio/ogg",
      filePath: "/data/media/voice.ogg",
      sizeBytes: 4_096,
    });
    upsertTranscriptionJob(db, {
      accountId: "personal",
      chatJid: "c@s.whatsapp.net",
      messageId: "M1",
      status: "done",
      attempts: 1,
    });
    insertTranscription(db, {
      accountId: "personal",
      chatJid: "c@s.whatsapp.net",
      messageId: "M1",
      textRaw: "bonjour",
      engine: "whisper-local",
    });
    await flushPostgresProjection();

    const stored = await pool!.query<{
      text: string;
      from_me: boolean;
      has_media: boolean;
    }>("select text, from_me, has_media from messages");
    expect(stored.rows).toEqual([
      { text: "bonjour", from_me: false, has_media: false },
    ]);

    const attachment = await pool!.query<{ size_bytes: string }>(
      "select size_bytes from attachments",
    );
    expect(Number(attachment.rows[0]?.size_bytes)).toBe(4_096);

    expect(await count("transcriptions")).toBe(1);
    expect(await count("transcription_jobs")).toBe(1);

    const stats = await pool!.query<{ message_count: string }>(
      "select message_count from chat_message_stats",
    );
    expect(Number(stats.rows[0]?.message_count)).toBe(1);
  });

  it("is idempotent on natural keys across replays", async () => {
    ingestMessage(deps(db), message("M1", "un"));
    ingestMessage(deps(db), message("M1", "un"));
    await flushPostgresProjection();
    ingestMessage(deps(db), message("M1", "un"));
    await flushPostgresProjection();

    expect(await count("messages")).toBe(1);
    expect(await count("chats")).toBe(1);
    expect(await count("accounts")).toBe(1);
  });

  it("projects an allow/block policy change", async () => {
    ingestMessage(deps(db), message("M1", "bonjour"));
    await flushPostgresProjection();
    setChatAllowed(db, "personal", "c@s.whatsapp.net", true);
    await flushPostgresProjection();

    const chat = await pool!.query<{
      is_allowed: boolean;
      is_blocked: boolean;
    }>("select is_allowed, is_blocked from chats");
    expect(chat.rows[0]).toEqual({ is_allowed: true, is_blocked: false });
  });

  it("projects the directory with canonical JIDs on both sides", async () => {
    upsertDirectoryGroupMember(db, {
      accountId: "personal",
      groupJid: "g@g.us",
      participantJid: "33600000000@s.whatsapp.net",
      role: "admin",
    });
    await flushPostgresProjection();

    const member = await pool!.query<{
      group_jid: string;
      member_jid: string;
      role: string;
      is_active: boolean;
    }>(
      "select group_jid, member_jid, role, is_active from directory_group_members",
    );
    expect(member.rows).toEqual([
      {
        group_jid: "g@g.us",
        member_jid: "33600000000@s.whatsapp.net",
        role: "admin",
        is_active: true,
      },
    ]);
    expect(await count("directory_entities")).toBe(2);
    expect(await count("directory_aliases")).toBeGreaterThanOrEqual(2);
  });

  it("projects a history job after its chat", async () => {
    ingestMessage(deps(db), message("M1", "bonjour"));
    createHistoryJob(db, {
      id: "job-1",
      accountId: "personal",
      chatJid: "c@s.whatsapp.net",
      sinceTs: 1_000,
      untilTs: 2_000,
    });
    await flushPostgresProjection();

    const job = await pool!.query<{
      id: string;
      status: string;
      coverage_complete: boolean;
    }>("select id, status, coverage_complete from history_jobs");
    expect(job.rows).toEqual([
      { id: "job-1", status: "queued", coverage_complete: false },
    ]);
  });

  it("stores and advances a consumer offset", async () => {
    await pool!.query(
      `insert into consumer_offsets (consumer_name, last_seen_event_id, updated_at)
       values ('export', 41, 1000)`,
    );
    await pool!.query(
      `insert into consumer_offsets (consumer_name, last_seen_event_id, updated_at)
       values ('export', 42, 1001)
       on conflict (consumer_name) do update set
         last_seen_event_id = excluded.last_seen_event_id,
         updated_at = excluded.updated_at`,
    );
    const row = await pool!.query<{ last_seen_event_id: string }>(
      "select last_seen_event_id from consumer_offsets where consumer_name = 'export'",
    );
    expect(Number(row.rows[0]?.last_seen_event_id)).toBe(42);
  });

  it("matches message and transcript search_vector across accents, case, and correction precedence", async () => {
    ingestMessage(deps(db), message("M1", "Réunion projet demain"));
    ingestMessage(deps(db), message("M2", "note vocale"));
    await flushPostgresProjection();
    upsertTranscriptionJob(db, {
      accountId: "personal",
      chatJid: "c@s.whatsapp.net",
      messageId: "M2",
      status: "done",
      attempts: 1,
    });
    insertTranscription(db, {
      accountId: "personal",
      chatJid: "c@s.whatsapp.net",
      messageId: "M2",
      textRaw: "sortie brute",
      engine: "whisper-local",
    });
    await flushPostgresProjection();
    await pool!.query(
      "update transcriptions set text_corrected = 'sortie corrigee' where message_id = 'M2'",
    );

    const messageHit = await pool!.query(
      "select message_id from messages where search_vector @@ websearch_to_tsquery('simple', immutable_unaccent('reunion'))",
    );
    expect(messageHit.rows).toEqual([{ message_id: "M1" }]);

    const transcriptHit = await pool!.query(
      "select message_id from transcriptions where search_vector @@ websearch_to_tsquery('simple', immutable_unaccent('corrigee'))",
    );
    expect(transcriptHit.rows).toEqual([{ message_id: "M2" }]);
    const rawMiss = await pool!.query(
      "select message_id from transcriptions where search_vector @@ websearch_to_tsquery('simple', immutable_unaccent('brute'))",
    );
    expect(rawMiss.rows).toEqual([]);
  });

  it("enforces the message foreign key rather than inventing a chat", async () => {
    await expect(
      pool!.query(
        `insert into messages (account_id, chat_jid, message_id, received_at, ingestion_source)
         values ('personal', 'ghost@s.whatsapp.net', 'X', 1, 'live')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
