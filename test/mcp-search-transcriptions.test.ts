import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb, type Database } from "../src/db/index.js";
import {
  insertTranscription,
  setChatAllowed,
  upsertAccount,
  upsertAttachment,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import {
  getTranscript,
  listMessages,
  messageContext,
  searchMessages,
} from "../src/mcp/read.js";
import type { McpContext } from "../src/mcp/types.js";

const ACCOUNT = "personal";
const CHAT = "33600000000@s.whatsapp.net";

/**
 * The transcription branch of `searchMessages` only becomes reachable once the
 * `transcriptions` table exists, which is why it is exercised here: it puts an
 * FTS `match` in an `or`, a shape SQLite refuses in some contexts.
 */
function context(): McpContext {
  const db: Database = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: ACCOUNT });
  upsertChat(db, { accountId: ACCOUNT, jid: CHAT, name: "Contact" });
  setChatAllowed(db, ACCOUNT, CHAT, true);
  upsertMessage(db, {
    accountId: ACCOUNT,
    chatJid: CHAT,
    messageId: "T1",
    senderJid: CHAT,
    timestamp: 1_700_000_000,
    messageType: "text",
    text: "on se voit demain",
    normalizedText: "on se voit demain",
  });
  upsertMessage(db, {
    accountId: ACCOUNT,
    chatJid: CHAT,
    messageId: "A1",
    senderJid: CHAT,
    timestamp: 1_700_000_010,
    messageType: "audio",
    hasMedia: true,
    durationS: 12,
  });
  upsertAttachment(db, {
    accountId: ACCOUNT,
    chatJid: CHAT,
    messageId: "A1",
    mediaType: "audio",
    filePath: "/data/media/abc.opus",
    sha256: "abc",
    downloadedAt: 1_700_000_011,
  });
  insertTranscription(db, {
    accountId: ACCOUNT,
    chatJid: CHAT,
    messageId: "A1",
    audioSha256: "abc",
    textRaw: "il faut relancer la facture Odoo",
    language: "fr",
    engine: "whisper-local",
    engineModel: "large-v3-turbo",
    durationS: 12,
  });
  return {
    db,
    config: resolveConfig({}, { dataDir: "/data" }),
    accountId: ACCOUNT,
    runtimeStatus: null,
  };
}

describe("search with transcriptions present", () => {
  it("finds a word only ever spoken in a voice note", () => {
    const ctx = context();
    const page = searchMessages(ctx, "facture");

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.messageId).toBe("A1");
    expect(page.items[0]?.matchedTranscript).toBe(true);
    expect(page.items[0]).not.toHaveProperty("textRaw");
    expect(page.items[0]?.textCorrected).toBe(
      "il faut relancer la facture Odoo",
    );
    ctx.db.close();
  });

  it("projects the manual correction as the effective transcript", () => {
    const ctx = context();
    ctx.db
      .prepare(
        "update transcriptions set text_corrected = ? where message_id = ?",
      )
      .run("il faut relancer la facture corrigée", "A1");

    const list = listMessages(ctx, { chat: CHAT, kind: "audio" });
    expect(list.items[0]).not.toHaveProperty("textRaw");
    expect(list.items[0]?.textCorrected).toBe(
      "il faut relancer la facture corrigée",
    );

    const search = searchMessages(ctx, "corrigée");
    expect(search.items[0]?.textCorrected).toBe(
      "il faut relancer la facture corrigée",
    );
    expect(search.items[0]).not.toHaveProperty("textRaw");

    const surrounding = messageContext(ctx, CHAT, "A1", 0, 0);
    expect(surrounding.message).not.toHaveProperty("textRaw");
    expect(surrounding.message.textCorrected).toBe(
      "il faut relancer la facture corrigée",
    );

    ctx.db
      .prepare(
        "update transcriptions set text_corrected = ? where message_id = ?",
      )
      .run("", "A1");
    expect(
      listMessages(ctx, { chat: CHAT, kind: "audio" }).items[0]?.textCorrected,
    ).toBe("");
    ctx.db.close();
  });

  it("still finds written text, and does not flag it as a transcript match", () => {
    const ctx = context();
    const page = searchMessages(ctx, "demain");

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.messageId).toBe("T1");
    expect(page.items[0]?.matchedTranscript).toBe(false);
    ctx.db.close();
  });

  it("reports the transcript as available", () => {
    const ctx = context();
    const result = getTranscript(ctx, CHAT, "A1");

    expect(result.status).toBe("available");
    expect(result.text_raw).toBe("il faut relancer la facture Odoo");
    expect(result.engine).toBe("whisper-local");
    ctx.db.close();
  });
});
