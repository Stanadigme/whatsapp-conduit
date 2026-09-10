import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { createSqliteReader } from "../src/db/sqlite-reader.js";
import { allowDashboardChat, blockDashboardChat } from "../src/dashboard/chats.js";
import { openDb, type Database } from "../src/db/index.js";
import {
  insertTranscription,
  setChatAllowed,
  setChatBlocked,
  upsertAccount,
  upsertAttachment,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import {
  flushPostgresProjection,
  shutdownPostgresProjection,
  startPostgresProjection,
  type PostgresProjectionPool,
} from "../src/db/postgres-projection.js";
import { createLogger } from "../src/util/logging.js";

/** Minimal fake pool: records every statement, answers every query as a no-op. */
class FakePool implements PostgresProjectionPool {
  readonly statements: string[] = [];
  async connect() {
    const statements = this.statements;
    return {
      async query(sql: string) {
        statements.push(sql);
      },
      release() {
        /* no-op */
      },
    };
  }
  async end() {
    /* no-op */
  }
}

const open: Database[] = [];
afterEach(async () => {
  await shutdownPostgresProjection();
  while (open.length > 0) open.pop()?.close();
});

function seeded(mediaDir: string) {
  const db = openDb(":memory:", { migrate: true });
  open.push(db);
  upsertAccount(db, { id: "personal" });
  upsertChat(db, {
    accountId: "personal",
    jid: "33600000000@s.whatsapp.net",
    name: "Allowed",
  });
  setChatAllowed(db, "personal", "33600000000@s.whatsapp.net", true);
  upsertChat(db, {
    accountId: "personal",
    jid: "33600000001@s.whatsapp.net",
    name: "Hidden",
  });
  upsertMessage(db, {
    accountId: "personal",
    chatJid: "33600000000@s.whatsapp.net",
    messageId: "M1",
    timestamp: 1_700_000_000,
    messageType: "text",
    text: "bonjour",
  });
  upsertMessage(db, {
    accountId: "personal",
    chatJid: "33600000001@s.whatsapp.net",
    messageId: "M2",
    timestamp: 1_700_000_001,
    messageType: "text",
    text: "secret",
  });
  const config = resolveConfig(
    { paths: { media_dir: mediaDir } },
    { dataDir: "/data" },
  );
  return { db, reader: createSqliteReader(db, config, "personal"), config };
}

describe("SqliteReader", () => {
  it("reports database-derived health counts only", async () => {
    const { reader } = seeded(mkdtempSync(join(tmpdir(), "wac-reader-")));
    const health = await reader.health();
    expect(health).toEqual({
      selfJid: null,
      chats: 2,
      allowedChats: 1,
      messages: 2,
      attachments: 0,
      lastMessageAt: 1_700_000_001,
      schemaVersion: expect.any(String),
      transcriptionAvailable: true,
    });
  });

  it("lists only allowed chats and messages", async () => {
    const { reader } = seeded(mkdtempSync(join(tmpdir(), "wac-reader-")));
    const chats = await reader.listChats({});
    expect(chats.items.map((c) => c.jid)).toEqual([
      "33600000000@s.whatsapp.net",
    ]);
    const messages = await reader.listMessages({});
    expect(messages.items.map((m) => m.text)).toEqual(["bonjour"]);
  });

  it("lists every discovered chat on the dashboard, unfiltered by default", async () => {
    const { reader } = seeded(mkdtempSync(join(tmpdir(), "wac-reader-")));
    const chats = await reader.listDashboardChats();
    expect(chats.map((c) => c.jid).sort()).toEqual([
      "33600000000@s.whatsapp.net",
      "33600000001@s.whatsapp.net",
    ]);
  });

  it("applies a policy change (written directly to SQLite) and reflects it back", async () => {
    const { db, reader } = seeded(mkdtempSync(join(tmpdir(), "wac-reader-")));
    // Allow/block is never routed through the reader — see reader.ts's
    // doc comment on why (the ingestion daemon depends on this SQLite write).
    const updated = allowDashboardChat(db, "personal", "33600000001@s.whatsapp.net");
    expect(updated.allowed).toBe(true);
    const messages = await reader.listMessages({});
    expect(messages.items.map((m) => m.text).sort()).toEqual([
      "bonjour",
      "secret",
    ]);
  });

  it("reads materialized chat message stats", async () => {
    const { reader } = seeded(mkdtempSync(join(tmpdir(), "wac-reader-")));
    const stats = await reader.chatMessageStats("33600000000@s.whatsapp.net");
    expect(stats.messageCount).toBe(1);
  });

  it("excludes blocked chats from export even under allowedOnly: false", async () => {
    const { db, reader } = seeded(mkdtempSync(join(tmpdir(), "wac-reader-")));
    setChatBlocked(db, "personal", "33600000001@s.whatsapp.net", true);
    const rows = await reader.exportRows({ allowedOnly: false });
    expect(rows.map((r) => r.chat_jid)).toEqual([
      "33600000000@s.whatsapp.net",
    ]);
  });

  it("never exposes a raw local path from media metadata", async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "wac-reader-"));
    const { db, reader } = seeded(mediaDir);
    const path = join(mediaDir, `${"a".repeat(64)}.opus`);
    writeFileSync(path, "fake-audio");
    upsertAttachment(db, {
      accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "M1",
      mediaType: "audio",
      mimeType: "audio/ogg",
      filePath: path,
      sha256: "a".repeat(64),
      downloadedAt: 1_700_000_000,
    });
    const media = await reader.getMediaMetadata(
      "33600000000@s.whatsapp.net",
      "M1",
    );
    expect(JSON.stringify(media)).not.toContain(mediaDir);
    expect(media.status).toBe("available");
  });

  it("resolves a local media file only inside the media root", async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "wac-reader-"));
    const { db, reader } = seeded(mediaDir);
    const path = join(mediaDir, `${"b".repeat(64)}.opus`);
    writeFileSync(path, "fake-audio");
    upsertAttachment(db, {
      accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "M1",
      filePath: path,
      mimeType: "audio/ogg",
    });
    const resolved = await reader.resolveLocalMediaFile(
      "33600000000@s.whatsapp.net",
      "M1",
      0,
    );
    expect(resolved?.path).toBe(path);

    const missing = await reader.resolveLocalMediaFile(
      "33600000000@s.whatsapp.net",
      "does-not-exist",
      0,
    );
    expect(missing).toBeNull();
  });

  it("refuses to resolve a media file in a chat that is not allowed", async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "wac-reader-"));
    const { db, reader } = seeded(mediaDir);
    const path = join(mediaDir, `${"d".repeat(64)}.opus`);
    writeFileSync(path, "fake-audio");
    upsertAttachment(db, {
      accountId: "personal",
      chatJid: "33600000001@s.whatsapp.net",
      messageId: "M2",
      filePath: path,
      mimeType: "audio/ogg",
    });
    await expect(
      reader.resolveLocalMediaFile("33600000001@s.whatsapp.net", "M2", 0),
    ).rejects.toThrow("chat is not available");
  });

  it("makes an allow/block write visible in Postgres once flushed (dashboard's own pattern)", async () => {
    const { db } = seeded(mkdtempSync(join(tmpdir(), "wac-reader-")));
    const pool = new FakePool();
    startPostgresProjection(pool, createLogger({ level: "error" }));

    // dashboard/api.ts's allow/block route: write SQLite directly, then flush
    // explicitly so a chat just blocked can't still read as allowed from
    // Postgres for however long the queue would otherwise take to drain.
    blockDashboardChat(db, "personal", "33600000001@s.whatsapp.net");
    await flushPostgresProjection();

    expect(
      pool.statements.some((sql) => sql.startsWith("insert into chats ")),
    ).toBe(true);
  });

  it("drains the projection queue before setTranscriptionCorrection returns", async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), "wac-reader-"));
    const { db, reader } = seeded(mediaDir);
    upsertMessage(db, {
      accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "A1",
      messageType: "audio",
      timestamp: 1_700_000_002,
    });
    insertTranscription(db, {
      accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "A1",
      textRaw: "brut",
      engine: "whisper-local",
    });
    const pool = new FakePool();
    startPostgresProjection(pool, createLogger({ level: "error" }));

    const applied = await reader.setTranscriptionCorrection({
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "A1",
      textCorrected: "corrigé",
    });

    expect(applied).toBe(true);
    expect(
      pool.statements.some((sql) =>
        sql.startsWith("insert into transcriptions "),
      ),
    ).toBe(true);
  });
});
