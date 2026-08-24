import type { Database } from "better-sqlite3";
import {
  directoryTablesAvailable,
  getDirectoryEntityByJid,
} from "../db/directory.js";
import {
  getChat,
  listChats,
  setChatAllowed,
  setChatBlocked,
  type ChatRow,
} from "../db/queries.js";
import { normalizeJid } from "../baileys/jid.js";

export interface DashboardChat {
  jid: string;
  name: string;
  pushName: string | null;
  kind: "contact" | "group" | "status";
  allowed: boolean;
  blocked: boolean;
  lastMessageTs: number | null;
  lastSyncedAt: number | null;
}

export interface DashboardChatFilter {
  query?: string;
  kind?: "contact" | "group" | "status";
  policy?: "allowed" | "blocked" | "discovered";
  limit?: number;
}

function toDashboardChat(db: Database, row: ChatRow): DashboardChat {
  const entity = directoryTablesAvailable(db)
    ? getDirectoryEntityByJid(db, row.account_id, row.jid)
    : undefined;
  const name = entity?.name ?? row.name ?? row.push_name ?? row.jid;
  return {
    jid: row.jid,
    name,
    pushName: entity?.push_name ?? row.push_name,
    kind:
      row.is_status === 1 ? "status" : row.is_group === 1 ? "group" : "contact",
    allowed: row.is_allowed === 1,
    blocked: row.is_blocked === 1,
    lastMessageTs: row.last_message_ts,
    lastSyncedAt: entity?.last_synced_at ?? null,
  };
}

export function listDashboardChats(
  db: Database,
  accountId: string,
  filter: DashboardChatFilter = {},
): DashboardChat[] {
  const query = filter.query?.trim().toLocaleLowerCase();
  const rows = listChats(db, { accountId, limit: 500 });
  return rows
    .map((row) => toDashboardChat(db, row))
    .filter((chat) => {
      if (filter.kind && chat.kind !== filter.kind) return false;
      if (filter.policy === "allowed" && !chat.allowed) return false;
      if (filter.policy === "blocked" && !chat.blocked) return false;
      if (filter.policy === "discovered" && (chat.allowed || chat.blocked))
        return false;
      if (!query) return true;
      return [chat.name, chat.pushName, chat.jid]
        .filter((value): value is string => value !== null)
        .some((value) => value.toLocaleLowerCase().includes(query));
    })
    .slice(0, Math.min(filter.limit ?? 200, 200));
}

function policyChat(
  db: Database,
  accountId: string,
  jid: string,
  action: "allow" | "block",
): DashboardChat {
  const normalized = normalizeJid(jid);
  const row = getChat(db, accountId, normalized);
  if (!row) throw new Error("chat is not available");
  if (row.is_status === 1) throw new Error("status chats cannot be allowed");
  if (action === "allow") setChatAllowed(db, accountId, normalized, true);
  else setChatBlocked(db, accountId, normalized, true);
  const updated = getChat(db, accountId, normalized);
  if (!updated) throw new Error("chat policy was not persisted");
  return toDashboardChat(db, updated);
}

export function allowDashboardChat(
  db: Database,
  accountId: string,
  jid: string,
): DashboardChat {
  return policyChat(db, accountId, jid, "allow");
}

export function blockDashboardChat(
  db: Database,
  accountId: string,
  jid: string,
): DashboardChat {
  return policyChat(db, accountId, jid, "block");
}
