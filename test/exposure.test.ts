import type { Database } from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { upsertDirectoryContact } from "../src/db/directory.js";
import {
  selectExportMessages,
  setChatAllowed,
  setChatBlocked,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import { chatStats, listChats, searchMessages, type SqliteMcpContext } from "../src/mcp/read.js";
import { listMessages, type MessageReadContext } from "../src/read/messages.js";

const ACCOUNT = "personal";

/**
 * ADR-0037 §1-2: "conserver, ne pas exposer". These messages are inserted
 * directly through db/queries.ts — never through ingestion — because the
 * point of the exposure rule is that storage and visibility are decided
 * separately. A chat's exposure must change the instant its policy or the
 * process config changes, with no re-ingestion, which the "toggle" half of
 * each test below checks.
 */
function seed(dataDir: string, overrides: Record<string, unknown> = {}) {
  const db: Database = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: ACCOUNT });
  const config = resolveConfig(overrides, { dataDir });
  const sqliteCtx: SqliteMcpContext = {
    db,
    config,
    accountId: ACCOUNT,
    runtimeStatus: null,
  };
  const readCtx: MessageReadContext = { db, accountId: ACCOUNT, config };
  return { db, config, sqliteCtx, readCtx };
}

/** Rebuilds the two context shapes against a live config change — no re-read of the db. */
function withConfig(
  db: Database,
  config: ReturnType<typeof resolveConfig>,
): { sqliteCtx: SqliteMcpContext; readCtx: MessageReadContext } {
  return {
    sqliteCtx: { db, config, accountId: ACCOUNT, runtimeStatus: null },
    readCtx: { db, accountId: ACCOUNT, config },
  };
}

function exportSelect(config: ReturnType<typeof resolveConfig>) {
  return {
    accountId: ACCOUNT,
    allowedOnly: true,
    includeGroups: config.privacy.includeGroups,
    includeStatus: config.privacy.includeStatus,
    allowedChats: config.filters.allowedChats,
    blockedChats: config.filters.blockedChats,
  };
}

describe("chat exposure (ADR-0037)", () => {
  it("hides a group behind include_groups, a blocked chat, and a discovered chat — from chats, messages, search and export — until authorised, without re-ingestion", () => {
    const { db, config, sqliteCtx, readCtx } = seed("/tmp/wac-exposure-default");

    // A group explicitly allowed at the chat level, but groups are excluded
    // by default (privacy.include_groups: false) — the config-level switch
    // wins over the per-chat flag.
    const group = "120@g.us";
    upsertChat(db, { accountId: ACCOUNT, jid: group, isGroup: true, name: "Groupe" });
    setChatAllowed(db, ACCOUNT, group, true);
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: group,
      messageId: "G1",
      timestamp: 10,
      text: "reunion de groupe",
    });

    // Explicitly blocked.
    const blocked = "33600000021@s.whatsapp.net";
    upsertChat(db, { accountId: ACCOUNT, jid: blocked, name: "Bloque" });
    setChatAllowed(db, ACCOUNT, blocked, true);
    setChatBlocked(db, ACCOUNT, blocked, true);
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: blocked,
      messageId: "B1",
      timestamp: 11,
      text: "conversation bloquee",
    });

    // Discovered but never authorised.
    const discovered = "33600000022@s.whatsapp.net";
    upsertChat(db, { accountId: ACCOUNT, jid: discovered, name: "Decouvert" });
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: discovered,
      messageId: "D1",
      timestamp: 12,
      text: "conversation decouverte",
    });

    // wa_chats_list
    expect(listChats(sqliteCtx).items.map((c) => c.jid)).toEqual([]);
    // wa_messages_list, unscoped (the dashboard's default conversation list)
    expect(listMessages(readCtx, {}).items).toEqual([]);
    // wa_messages_list / dashboard messages, scoped to one hidden chat
    expect(() => listMessages(readCtx, { chat: group })).toThrow(
      "chat is not available",
    );
    expect(() => listMessages(readCtx, { chat: blocked })).toThrow(
      "chat is not available",
    );
    expect(() => listMessages(readCtx, { chat: discovered })).toThrow(
      "chat is not available",
    );
    // wa_messages_search
    expect(
      searchMessages(sqliteCtx, "reunion OR bloquee OR decouverte").items,
    ).toEqual([]);
    // wa_chat_stats
    expect(() => chatStats(sqliteCtx, group)).toThrow("chat is not available");
    // export (the MCP/CLI default: allowed-only)
    expect(selectExportMessages(db, exportSelect(config))).toEqual([]);

    // Toggle 1: a config change (no re-ingestion) exposes the group.
    const groupsOn = resolveConfig(
      { privacy: { include_groups: true } },
      { dataDir: "/tmp/wac-exposure-default" },
    );
    const on = withConfig(db, groupsOn);
    expect(listChats(on.sqliteCtx).items.map((c) => c.jid)).toEqual([group]);
    expect(
      listMessages(on.readCtx, { chat: group }).items.map((m) => m.messageId),
    ).toEqual(["G1"]);
    expect(selectExportMessages(db, exportSelect(groupsOn)).map((r) => r.message_id)).toEqual(
      ["G1"],
    );
    // The blocked and merely-discovered chats are unaffected by that toggle.
    expect(() => chatStats(on.sqliteCtx, blocked)).toThrow(
      "chat is not available",
    );
    expect(() => chatStats(on.sqliteCtx, discovered)).toThrow(
      "chat is not available",
    );

    // Toggle 2: authorising the discovered chat (no re-ingestion) exposes it,
    // still under the original config.
    setChatAllowed(db, ACCOUNT, discovered, true);
    expect(listChats(sqliteCtx).items.map((c) => c.jid)).toEqual([discovered]);
    expect(
      listMessages(readCtx, { chat: discovered }).items.map((m) => m.messageId),
    ).toEqual(["D1"]);

    db.close();
  });

  it("exposes a not-yet-allowed chat only through its configured allowed_chats alias, resolved via the directory", () => {
    const db: Database = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: ACCOUNT });
    const phone = "33600000030@s.whatsapp.net";
    const lid = "900000000030@lid";
    upsertChat(db, { accountId: ACCOUNT, jid: phone, name: "Alias" });
    upsertDirectoryContact(db, { accountId: ACCOUNT, jid: phone, lid });
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: phone,
      messageId: "A1",
      timestamp: 1,
      text: "salut",
    });

    // allowed_chats lists the LID alias only; the chat is stored — and would
    // be read — under the phone JID. Without alias resolution this chat
    // would stay invisible despite being explicitly configured as allowed.
    const config = resolveConfig(
      { filters: { allowed_chats: [lid] } },
      { dataDir: "/tmp/wac-exposure-alias" },
    );
    const sqliteCtx: SqliteMcpContext = {
      db,
      config,
      accountId: ACCOUNT,
      runtimeStatus: null,
    };
    expect(listChats(sqliteCtx).items.map((c) => c.jid)).toEqual([phone]);
    expect(
      listMessages({ db, accountId: ACCOUNT, config }, { chat: phone }).items.map(
        (m) => m.messageId,
      ),
    ).toEqual(["A1"]);
    expect(
      selectExportMessages(db, exportSelect(config)).map((r) => r.message_id),
    ).toEqual(["A1"]);

    db.close();
  });

  it("keeps blocked_chats winning over allowed_chats, alias resolved, even after chats-level allow", () => {
    const db: Database = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: ACCOUNT });
    const phone = "33600000031@s.whatsapp.net";
    const lid = "900000000031@lid";
    upsertChat(db, { accountId: ACCOUNT, jid: phone, name: "Alias bloque" });
    upsertDirectoryContact(db, { accountId: ACCOUNT, jid: phone, lid });
    // Explicitly allowed at the chat level...
    setChatAllowed(db, ACCOUNT, phone, true);
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: phone,
      messageId: "C1",
      timestamp: 1,
      text: "salut",
    });

    // ...but blocked_chats lists its LID alias: the block must still win.
    const config = resolveConfig(
      { filters: { blocked_chats: [lid] } },
      { dataDir: "/tmp/wac-exposure-blocked-alias" },
    );
    const sqliteCtx: SqliteMcpContext = {
      db,
      config,
      accountId: ACCOUNT,
      runtimeStatus: null,
    };
    expect(listChats(sqliteCtx).items.map((c) => c.jid)).toEqual([]);
    expect(
      selectExportMessages(db, exportSelect(config)),
    ).toEqual([]);

    db.close();
  });
});
