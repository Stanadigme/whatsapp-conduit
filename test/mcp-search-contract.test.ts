import type { Database } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  setChatAllowed,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import { searchMessages } from "../src/mcp/read.js";
import type { McpContext } from "../src/mcp/types.js";

const ACCOUNT = "personal";
const CHAT = "33600000000@s.whatsapp.net";

/**
 * Pins the search contract that the FTS tokenizer provides today:
 * accent-insensitive, case-insensitive, and **not** stemming.
 *
 * It exists for the storage port. `unicode61 remove_diacritics 2` maps onto
 * PostgreSQL as `to_tsvector('simple', …)` with unaccent — not `'french'`,
 * whose `french_stem` would additionally match word stems and silently widen
 * every search. The `resum` case below is what catches that mistake.
 */
function context(): McpContext {
  const db: Database = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: ACCOUNT });
  upsertChat(db, { accountId: ACCOUNT, jid: CHAT, name: "Contact" });
  setChatAllowed(db, ACCOUNT, CHAT, true);
  upsertMessage(db, {
    accountId: ACCOUNT,
    chatJid: CHAT,
    messageId: "M1",
    senderJid: CHAT,
    timestamp: 1_700_000_000,
    messageType: "text",
    text: "Voici le résumé de la réunion",
  });
  return {
    db,
    config: resolveConfig({}, { dataDir: "/data" }),
    accountId: ACCOUNT,
    runtimeStatus: null,
  };
}

function ids(ctx: McpContext, query: string): string[] {
  return searchMessages(ctx, query).items.map((item) => item.messageId);
}

describe("message search contract", () => {
  it("matches regardless of accents and case", () => {
    const ctx = context();
    // Both directions matter: an unaccented query finding accented text, and
    // an accented query finding the same text.
    expect(ids(ctx, "resume")).toEqual(["M1"]);
    expect(ids(ctx, "résumé")).toEqual(["M1"]);
    expect(ids(ctx, "RÉSUMÉ")).toEqual(["M1"]);
    expect(ids(ctx, "reunion")).toEqual(["M1"]);
    // Multi-term queries are AND-ed by ftsQuery.
    expect(ids(ctx, "resume reunion")).toEqual(["M1"]);
    ctx.db.close();
  });

  it("does not stem or prefix-match", () => {
    const ctx = context();
    // A truncated word must not match. If this ever returns M1, a stemming
    // tokenizer has been introduced and every search silently got broader.
    expect(ids(ctx, "resum")).toEqual([]);
    expect(ids(ctx, "réun")).toEqual([]);
    ctx.db.close();
  });
});
