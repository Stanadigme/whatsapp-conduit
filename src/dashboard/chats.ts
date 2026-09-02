import type { Database } from "better-sqlite3";
import {
  directoryTablesAvailable,
  getDirectoryEntityByJid,
} from "../db/directory.js";
import {
  getChat,
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

/** A chat row already carrying its resolved directory name, if any. */
interface ResolvedChatRow extends ChatRow {
  dir_name: string | null;
  dir_push_name: string | null;
  dir_last_synced_at: number | null;
}

/**
 * Filtering used to happen in JavaScript after materializing the 500
 * most-recent chats, which made every chat past that rank unreachable by
 * search — a silently wrong result, not a limit. The filters now run in SQL so
 * the limit applies to matches instead of candidates.
 */
export function listDashboardChats(
  db: Database,
  accountId: string,
  filter: DashboardChatFilter = {},
): DashboardChat[] {
  const where: string[] = ["c.account_id = @accountId"];
  const params: Record<string, unknown> = {
    accountId,
    limit: Math.min(filter.limit ?? 200, 200),
  };
  if (filter.kind === "status") where.push("c.is_status = 1");
  else if (filter.kind === "group")
    where.push("c.is_group = 1 and c.is_status = 0");
  else if (filter.kind === "contact")
    where.push("c.is_group = 0 and c.is_status = 0");
  if (filter.policy === "allowed") where.push("c.is_allowed = 1");
  else if (filter.policy === "blocked") where.push("c.is_blocked = 1");
  else if (filter.policy === "discovered")
    where.push("c.is_allowed = 0 and c.is_blocked = 0");

  // Two left joins — canonical JID first, alias second — reproduce the
  // canonical-over-alias precedence of getDirectoryEntityByJid without a
  // cross-table `or`, so all three joins stay index-driven.
  const directory = directoryTablesAvailable(db);
  const joins = directory
    ? `left join directory_entities ec
              on ec.account_id = c.account_id and ec.canonical_jid = c.jid
       left join directory_aliases a
              on a.account_id = c.account_id and a.alias_jid = c.jid
       left join directory_entities ea on ea.id = a.entity_id`
    : "";
  const dirName = directory ? "coalesce(ec.name, ea.name)" : "null";
  const dirPushName = directory
    ? "coalesce(ec.push_name, ea.push_name)"
    : "null";
  const dirSyncedAt = directory
    ? "coalesce(ec.last_synced_at, ea.last_synced_at)"
    : "null";

  const query = filter.query?.trim().toLocaleLowerCase();
  if (query) {
    params.query = `%${query}%`;
    const haystack = ["c.name", "c.push_name", "c.jid", dirName, dirPushName];
    where.push(
      `(${haystack.map((column) => `lower_u(${column}) like @query`).join(" or ")})`,
    );
  }

  const rows = db
    .prepare(
      `select c.*,
              ${dirName} as dir_name,
              ${dirPushName} as dir_push_name,
              ${dirSyncedAt} as dir_last_synced_at
       from chats c
       ${joins}
       where ${where.join(" and ")}
       order by coalesce(c.last_message_ts, 0) desc, c.jid asc
       limit @limit`,
    )
    .all(params) as ResolvedChatRow[];
  return rows.map((row) => ({
    jid: row.jid,
    name: row.dir_name ?? row.name ?? row.push_name ?? row.jid,
    pushName: row.dir_push_name ?? row.push_name,
    kind:
      row.is_status === 1 ? "status" : row.is_group === 1 ? "group" : "contact",
    allowed: row.is_allowed === 1,
    blocked: row.is_blocked === 1,
    lastMessageTs: row.last_message_ts,
    lastSyncedAt: row.dir_last_synced_at,
  }));
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
