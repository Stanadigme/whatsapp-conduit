import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { upsertDirectoryContact } from "../src/db/directory.js";
import {
  setChatAllowed,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import { getChatMessageStats } from "../src/read/chat-stats.js";

describe("materialized conversation statistics", () => {
  it("keeps a direct, up-to-date row across inserts and deletions", () => {
    const db = openDb(":memory:", { migrate: true });
    const accountId = "personal";
    const chatJid = "33600000000@s.whatsapp.net";
    upsertAccount(db, { id: accountId });
    upsertChat(db, { accountId, jid: chatJid });
    setChatAllowed(db, accountId, chatJid, true);

    upsertMessage(db, {
      accountId,
      chatJid,
      messageId: "newer",
      timestamp: 200,
      hasMedia: true,
    });
    upsertMessage(db, {
      accountId,
      chatJid,
      messageId: "older",
      timestamp: 100,
      hasMedia: false,
    });
    upsertMessage(db, { accountId, chatJid, messageId: "unknown-date" });

    expect(getChatMessageStats({ db, accountId }, chatJid)).toMatchObject({
      messageCount: 3,
      mediaMessageCount: 1,
      oldestMessageTs: 100,
      newestMessageTs: 200,
    });

    db.prepare(
      "delete from messages where account_id = ? and chat_jid = ? and message_id = ?",
    ).run(accountId, chatJid, "older");
    expect(getChatMessageStats({ db, accountId }, chatJid)).toMatchObject({
      messageCount: 2,
      mediaMessageCount: 1,
      oldestMessageTs: 200,
      newestMessageTs: 200,
    });
    db.close();
  });

  it("combines the materialized rows for an allowed contact's aliases", () => {
    const db = openDb(":memory:", { migrate: true });
    const accountId = "personal";
    const phoneJid = "33600000000@s.whatsapp.net";
    const lidJid = "900000000000@lid";
    upsertAccount(db, { id: accountId });
    upsertChat(db, { accountId, jid: phoneJid });
    upsertChat(db, { accountId, jid: lidJid });
    setChatAllowed(db, accountId, lidJid, true);
    upsertDirectoryContact(db, {
      accountId,
      jid: phoneJid,
      lid: lidJid,
    });
    upsertMessage(db, {
      accountId,
      chatJid: phoneJid,
      messageId: "phone-message",
      timestamp: 100,
    });
    upsertMessage(db, {
      accountId,
      chatJid: lidJid,
      messageId: "lid-message",
      timestamp: 200,
      hasMedia: true,
    });

    expect(getChatMessageStats({ db, accountId }, lidJid)).toMatchObject({
      messageCount: 2,
      mediaMessageCount: 1,
      oldestMessageTs: 100,
      newestMessageTs: 200,
    });
    db.close();
  });
});
