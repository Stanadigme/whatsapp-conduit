import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { createSqliteReader } from "../src/db/sqlite-reader.js";
import { openDb, type Database } from "../src/db/index.js";
import {
  setChatAllowed,
  setChatBlocked,
  upsertAccount,
  upsertAttachment,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";

const open: Database[] = [];
afterEach(() => {
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

  it("applies a policy change and reflects it back", async () => {
    const { reader } = seeded(mkdtempSync(join(tmpdir(), "wac-reader-")));
    const updated = await reader.setChatPolicy(
      "33600000001@s.whatsapp.net",
      "allow",
    );
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
});
