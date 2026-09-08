import type { Database } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import {
  insertTranscription,
  setChatAllowed,
  upsertAccount,
  upsertChat,
  upsertMessage,
  upsertParticipant,
} from "../src/db/queries.js";
import { upsertDirectoryContact } from "../src/db/directory.js";
import { getMessage, listMessages } from "../src/read/messages.js";

const ACCOUNT = "personal";
const CHAT = "33600000000@s.whatsapp.net";

/**
 * Counts statements compiled on a connection.
 *
 * No statement cache exists in src/, so one `prepare` is one query sent to the
 * database. Assigning an own property shadows the prototype method for this
 * instance only.
 */
function countQueries(db: Database): () => number {
  const original = db.prepare.bind(db);
  let count = 0;
  // The signature is heavily overloaded; the test only needs the SQL passthrough.
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (
    sql: string,
  ) => {
    count += 1;
    return original(sql);
  };
  return () => count;
}

function seed(messages: number): Database {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: ACCOUNT });
  upsertChat(db, { accountId: ACCOUNT, jid: CHAT, name: "Contact" });
  setChatAllowed(db, ACCOUNT, CHAT, true);
  upsertParticipant(db, {
    accountId: ACCOUNT,
    jid: CHAT,
    displayName: "Alice",
  });
  for (let index = 0; index < messages; index += 1) {
    const messageId = `M${String(index).padStart(2, "0")}`;
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: CHAT,
      messageId,
      senderJid: CHAT,
      timestamp: 1_700_000_000 + index,
      messageType: index % 5 === 0 ? "audio" : "text",
      text: `message ${index}`,
    });
    if (index % 5 === 0) {
      insertTranscription(db, {
        accountId: ACCOUNT,
        chatJid: CHAT,
        messageId,
        textRaw: `transcription ${index}`,
        engine: "whisper-local",
      });
    }
  }
  return db;
}

describe("read path query count", () => {
  it("resolves a page with a fixed number of queries", () => {
    const db = seed(55);
    const ctx = { db, accountId: ACCOUNT };
    // Warm the connection-scoped schema caches, which is the steady state of a
    // long-running process. What is measured is the per-page cost.
    listMessages(ctx, { chat: CHAT, limit: 50 });

    const queries = countQueries(db);
    const paged = listMessages(ctx, { chat: CHAT, limit: 50 });

    expect(paged.items).toHaveLength(50);
    expect(paged.items[0]?.senderName).toBe("Alice");
    // Sender name and transcript are resolved by joins, so the cost no longer
    // scales with the page: 5 queries measured here, against 160+ before
    // batching. A regression to per-row resolution blows past this ceiling.
    expect(queries()).toBeLessThanOrEqual(8);
    db.close();
  });

  it("does not scale with the number of rows returned", () => {
    const db = seed(55);
    const ctx = { db, accountId: ACCOUNT };
    listMessages(ctx, { chat: CHAT, limit: 5 });

    const queries = countQueries(db);
    listMessages(ctx, { chat: CHAT, limit: 5 });
    const small = queries();
    const largeQueries = countQueries(db);
    listMessages(ctx, { chat: CHAT, limit: 50 });

    // Ten times the rows must cost the same number of queries.
    expect(largeQueries()).toBe(small);
    db.close();
  });
});

/**
 * `listMessages` resolves the sender name with SQL joins while `getMessage`
 * still resolves it row by row in JavaScript. They must agree on every
 * precedence rule, otherwise a conversation and a single message would show
 * different names for the same sender.
 */
describe("sender name resolution", () => {
  function bothPaths(
    db: Database,
    chatJid: string,
    messageId: string,
  ): [string | null, string | null] {
    const ctx = { db, accountId: ACCOUNT };
    const listed = listMessages(ctx, { chat: chatJid }).items.find(
      (item) => item.messageId === messageId,
    );
    return [
      listed?.senderName ?? null,
      getMessage(ctx, chatJid, messageId).senderName,
    ];
  }

  function chatWithSender(db: Database, chatJid: string, senderJid: string) {
    upsertChat(db, { accountId: ACCOUNT, jid: chatJid });
    setChatAllowed(db, ACCOUNT, chatJid, true);
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid,
      messageId: "M1",
      senderJid,
      timestamp: 1,
      text: "hello",
    });
  }

  it("agrees with the per-row path on a canonical directory entity", () => {
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: ACCOUNT });
    const sender = "33600000001@s.whatsapp.net";
    chatWithSender(db, sender, sender);
    upsertDirectoryContact(db, {
      accountId: ACCOUNT,
      jid: sender,
      displayName: "Alice Canonical",
    });
    const [listed, single] = bothPaths(db, sender, "M1");
    expect(listed).toBe("Alice Canonical");
    expect(single).toBe(listed);
    db.close();
  });

  it("agrees when the sender is only known through a LID alias", () => {
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: ACCOUNT });
    const phone = "33600000002@s.whatsapp.net";
    const lid = "900000000002@lid";
    // The message carries the LID, the directory entity is keyed on the phone
    // JID: resolution has to go through directory_aliases.
    chatWithSender(db, lid, lid);
    upsertDirectoryContact(db, {
      accountId: ACCOUNT,
      jid: phone,
      lid,
      displayName: "Bob Alias",
    });
    const [listed, single] = bothPaths(db, lid, "M1");
    expect(listed).toBe("Bob Alias");
    expect(single).toBe(listed);
    db.close();
  });

  it("agrees on the participants fallback and on an unknown sender", () => {
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: ACCOUNT });
    const known = "33600000003@s.whatsapp.net";
    chatWithSender(db, known, known);
    upsertParticipant(db, {
      accountId: ACCOUNT,
      jid: known,
      pushName: "Carol Push",
    });
    const [listed, single] = bothPaths(db, known, "M1");
    expect(listed).toBe("Carol Push");
    expect(single).toBe(listed);

    // Nothing knows this sender: both paths must return null rather than
    // inventing a name from the JID.
    const unknown = "33600000009@s.whatsapp.net";
    chatWithSender(db, unknown, unknown);
    const [listedUnknown, singleUnknown] = bothPaths(db, unknown, "M1");
    expect(listedUnknown).toBeNull();
    expect(singleUnknown).toBeNull();
    db.close();
  });
});
