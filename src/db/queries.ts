import type { Database } from "better-sqlite3";
import { normalizeJid, phoneFromJid } from "../baileys/jid.js";
import { nowSec } from "../util/time.js";
import {
  directoryTablesAvailable,
  markDirectoryMissingMembersInactive,
  resolveDirectoryJid,
  upsertDirectoryContact,
  upsertDirectoryGroupMember,
} from "./directory.js";

/**
 * Persistence helpers. Every write is idempotent on its documented primary key
 * via `ON CONFLICT DO UPDATE`, so replaying the same Baileys event is safe.
 * `COALESCE(excluded.x, table.x)` is used where ingestion may carry a null we
 * must not use to clobber a previously-known value.
 */

export interface AccountInput {
  id: string;
  label?: string | null;
  selfJid?: string | null;
  phoneNumber?: string | null;
}

export interface AccountRow {
  id: string;
  label: string | null;
  self_jid: string | null;
  phone_number: string | null;
  created_at: number;
  updated_at: number;
}

export function upsertAccount(db: Database, input: AccountInput): void {
  const now = nowSec();
  db.prepare(
    `insert into accounts (id, label, self_jid, phone_number, created_at, updated_at)
     values (@id, @label, @selfJid, @phoneNumber, @now, @now)
     on conflict (id) do update set
       label = coalesce(excluded.label, accounts.label),
       self_jid = coalesce(excluded.self_jid, accounts.self_jid),
       phone_number = coalesce(excluded.phone_number, accounts.phone_number),
       updated_at = excluded.updated_at`,
  ).run({
    id: input.id,
    label: input.label ?? null,
    selfJid: input.selfJid ?? null,
    phoneNumber: input.phoneNumber ?? null,
    now,
  });
}

export function getAccount(db: Database, id: string): AccountRow | undefined {
  return db
    .prepare<[string], AccountRow>("select * from accounts where id = ?")
    .get(id);
}

export function listAccounts(db: Database): AccountRow[] {
  return db.prepare<[], AccountRow>("select * from accounts order by id").all();
}

export function countChats(db: Database, accountId?: string): number {
  if (accountId === undefined) {
    return (
      db.prepare<[], { n: number }>("select count(*) as n from chats").get()
        ?.n ?? 0
    );
  }
  return (
    db
      .prepare<
        [string],
        { n: number }
      >("select count(*) as n from chats where account_id = ?")
      .get(accountId)?.n ?? 0
  );
}

export function countAllowedChats(db: Database, accountId?: string): number {
  if (accountId === undefined) {
    return (
      db
        .prepare<
          [],
          { n: number }
        >("select count(*) as n from chats where is_allowed = 1")
        .get()?.n ?? 0
    );
  }
  return (
    db
      .prepare<
        [string],
        { n: number }
      >("select count(*) as n from chats where account_id = ? and is_allowed = 1")
      .get(accountId)?.n ?? 0
  );
}

export function latestMessageTimestamp(
  db: Database,
  accountId?: string,
): number | null {
  const row =
    accountId === undefined
      ? db
          .prepare<
            [],
            { ts: number | null }
          >("select max(timestamp) as ts from messages")
          .get()
      : db
          .prepare<
            [string],
            { ts: number | null }
          >("select max(timestamp) as ts from messages where account_id = ?")
          .get(accountId);
  return row?.ts ?? null;
}

export interface ChatInput {
  accountId: string;
  jid: string;
  name?: string | null;
  pushName?: string | null;
  isGroup?: boolean;
  isStatus?: boolean;
  lastMessageTs?: number | null;
  rawJson?: string | null;
}

export interface ChatRow {
  account_id: string;
  jid: string;
  name: string | null;
  push_name: string | null;
  is_group: number;
  is_status: number;
  is_blocked: number;
  is_allowed: number;
  discovered_at: number;
  updated_at: number;
  last_message_ts: number | null;
  raw_json: string | null;
}

/**
 * Upsert chat metadata discovered during ingestion. Deliberately does NOT touch
 * `is_allowed` / `is_blocked` — those are policy, owned by the allow/block
 * commands, not the sync path.
 */
export function upsertChat(db: Database, input: ChatInput): void {
  const now = nowSec();
  db.prepare(
    `insert into chats (
       account_id, jid, name, push_name, is_group, is_status,
       discovered_at, updated_at, last_message_ts, raw_json
     ) values (
       @accountId, @jid, @name, @pushName, @isGroup, @isStatus,
       @now, @now, @lastMessageTs, @rawJson
     )
     on conflict (account_id, jid) do update set
       name = coalesce(excluded.name, chats.name),
       push_name = coalesce(excluded.push_name, chats.push_name),
       -- Only reclassify group/status when the caller actually provided it.
       is_group = case when @isGroupSet = 1 then @isGroup else chats.is_group end,
       is_status = case when @isStatusSet = 1 then @isStatus else chats.is_status end,
       -- Null-safe max: never invent epoch-0 when neither side has a timestamp.
       last_message_ts = max(
         coalesce(excluded.last_message_ts, chats.last_message_ts),
         coalesce(chats.last_message_ts, excluded.last_message_ts)
       ),
       raw_json = coalesce(excluded.raw_json, chats.raw_json),
       updated_at = excluded.updated_at`,
  ).run({
    accountId: input.accountId,
    jid: input.jid,
    name: cleanDirectoryValue(input.name),
    pushName: cleanDirectoryValue(input.pushName),
    isGroup: input.isGroup ? 1 : 0,
    isGroupSet: input.isGroup === undefined ? 0 : 1,
    isStatus: input.isStatus ? 1 : 0,
    isStatusSet: input.isStatus === undefined ? 0 : 1,
    lastMessageTs: input.lastMessageTs ?? null,
    rawJson: input.rawJson ?? null,
    now,
  });
}

/** Set a chat's allow flag (policy). Clears the block flag when allowing. */
export function setChatAllowed(
  db: Database,
  accountId: string,
  jid: string,
  allowed: boolean,
): void {
  db.prepare(
    `update chats
       set is_allowed = @allowed,
           is_blocked = case when @allowed = 1 then 0 else is_blocked end,
           updated_at = @now
     where account_id = @accountId and jid = @jid`,
  ).run({ accountId, jid, allowed: allowed ? 1 : 0, now: nowSec() });
}

/** Set a chat's block flag (policy). Clears the allow flag when blocking. */
export function setChatBlocked(
  db: Database,
  accountId: string,
  jid: string,
  blocked: boolean,
): void {
  db.prepare(
    `update chats
       set is_blocked = @blocked,
           is_allowed = case when @blocked = 1 then 0 else is_allowed end,
           updated_at = @now
     where account_id = @accountId and jid = @jid`,
  ).run({ accountId, jid, blocked: blocked ? 1 : 0, now: nowSec() });
}

export function getChat(
  db: Database,
  accountId: string,
  jid: string,
): ChatRow | undefined {
  return db
    .prepare<
      [string, string],
      ChatRow
    >("select * from chats where account_id = ? and jid = ?")
    .get(accountId, jid);
}

export interface ListChatsOptions {
  accountId?: string;
  allowedOnly?: boolean;
  limit?: number;
}

/** List chats, most-recently-active first. */
export function listChats(
  db: Database,
  opts: ListChatsOptions = {},
): ChatRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.accountId) {
    where.push("account_id = @accountId");
    params.accountId = opts.accountId;
  }
  if (opts.allowedOnly) where.push("is_allowed = 1");
  if (opts.limit != null) params.limit = opts.limit;
  const sql =
    `select * from chats ${where.length ? `where ${where.join(" and ")}` : ""} ` +
    `order by coalesce(last_message_ts, 0) desc, jid asc ` +
    `${opts.limit != null ? "limit @limit" : ""}`;
  return db.prepare(sql).all(params) as ChatRow[];
}

export interface ParticipantInput {
  accountId: string;
  jid: string;
  lid?: string | null;
  phone?: string | null;
  displayName?: string | null;
  pushName?: string | null;
  verifiedName?: string | null;
  rawJson?: string | null;
}

export function upsertParticipant(db: Database, input: ParticipantInput): void {
  if (directoryTablesAvailable(db)) {
    upsertDirectoryContact(db, input);
    return;
  }
  const now = nowSec();
  const jid = normalizeJid(input.jid);
  const inputLid = input.lid
    ? normalizeJid(input.lid)
    : jid.endsWith("@lid")
      ? jid
      : null;
  const phoneJid = jid.endsWith("@s.whatsapp.net")
    ? jid
    : input.phone && /^\d+$/.test(input.phone)
      ? `${input.phone}@s.whatsapp.net`
      : null;

  const write = db.transaction(() => {
    const candidates = [jid, inputLid].filter(
      (value): value is string => value !== null,
    );
    const mapped = candidates
      .map(
        (alias) =>
          db
            .prepare<[string, string], { canonical_jid: string }>(
              `select canonical_jid from participant_aliases
             where account_id = ? and alias_jid = ?`,
            )
            .get(input.accountId, alias)?.canonical_jid,
      )
      .filter((value): value is string => value !== undefined);
    const canonical =
      phoneJid ??
      mapped.find((value) => !value.endsWith("@lid")) ??
      mapped[0] ??
      jid;
    const oldCanonicals = [
      ...new Set(mapped.filter((value) => value !== canonical)),
    ];

    const existing = db
      .prepare<
        [string, string],
        ParticipantRow
      >("select * from participants where account_id = ? and jid = ?")
      .get(input.accountId, canonical);

    for (const oldCanonical of oldCanonicals) {
      mergeParticipant(db, input.accountId, oldCanonical, canonical);
    }

    db.prepare(
      `insert into participants (
         account_id, jid, lid, phone, display_name, push_name, verified_name,
         first_seen_at, updated_at, raw_json
       ) values (
         @accountId, @jid, @lid, @phone, @displayName, @pushName, @verifiedName,
         @now, @now, @rawJson
       )
       on conflict (account_id, jid) do update set
         lid = coalesce(nullif(excluded.lid, ''), participants.lid),
         phone = coalesce(nullif(excluded.phone, ''), participants.phone),
         display_name = coalesce(nullif(trim(excluded.display_name), ''), participants.display_name),
         push_name = coalesce(nullif(trim(excluded.push_name), ''), participants.push_name),
         verified_name = coalesce(nullif(trim(excluded.verified_name), ''), participants.verified_name),
         raw_json = coalesce(excluded.raw_json, participants.raw_json),
         updated_at = excluded.updated_at`,
    ).run({
      accountId: input.accountId,
      jid: canonical,
      lid: inputLid ?? existing?.lid ?? null,
      phone: input.phone ?? phoneFromJid(canonical) ?? existing?.phone ?? null,
      displayName: cleanDirectoryValue(input.displayName),
      pushName: cleanDirectoryValue(input.pushName),
      verifiedName: cleanDirectoryValue(input.verifiedName),
      rawJson: input.rawJson ?? null,
      now,
    });

    for (const alias of new Set([canonical, ...candidates])) {
      db.prepare(
        `insert into participant_aliases (
           account_id, alias_jid, canonical_jid, first_seen_at, updated_at
         ) values (@accountId, @aliasJid, @canonicalJid, @now, @now)
         on conflict (account_id, alias_jid) do update set
           canonical_jid = excluded.canonical_jid,
           updated_at = excluded.updated_at`,
      ).run({
        accountId: input.accountId,
        aliasJid: alias,
        canonicalJid: canonical,
        now,
      });
    }

    const displayName = cleanDirectoryValue(input.displayName);
    if (displayName) {
      db.prepare(
        `update chats set name = coalesce(nullif(trim(name), ''), @displayName),
           updated_at = @now
         where account_id = @accountId and is_group = 0
           and jid in (
             select alias_jid from participant_aliases
             where account_id = @accountId and canonical_jid = @canonicalJid
           )`,
      ).run({
        accountId: input.accountId,
        canonicalJid: canonical,
        displayName,
        now,
      });
    }
  });
  write();
}

function cleanDirectoryValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Merge a legacy or newly-discovered alias row into the preferred canonical row. */
function mergeParticipant(
  db: Database,
  accountId: string,
  oldJid: string,
  canonicalJid: string,
): void {
  if (oldJid === canonicalJid) return;
  const old = db
    .prepare<
      [string, string],
      ParticipantRow
    >("select * from participants where account_id = ? and jid = ?")
    .get(accountId, oldJid);
  if (!old) return;

  db.prepare(
    `insert into participants (
       account_id, jid, lid, phone, display_name, push_name, verified_name,
       first_seen_at, updated_at, raw_json
     ) values (@accountId, @jid, @lid, @phone, @displayName, @pushName,
               @verifiedName, @firstSeenAt, @updatedAt, @rawJson)
     on conflict (account_id, jid) do update set
       lid = coalesce(participants.lid, excluded.lid),
       phone = coalesce(participants.phone, excluded.phone),
       display_name = coalesce(participants.display_name, excluded.display_name),
       push_name = coalesce(participants.push_name, excluded.push_name),
       verified_name = coalesce(participants.verified_name, excluded.verified_name),
       raw_json = coalesce(participants.raw_json, excluded.raw_json),
       first_seen_at = min(participants.first_seen_at, excluded.first_seen_at),
       updated_at = max(participants.updated_at, excluded.updated_at)`,
  ).run({
    accountId,
    jid: canonicalJid,
    lid: old.lid,
    phone: old.phone,
    displayName: cleanDirectoryValue(old.display_name),
    pushName: cleanDirectoryValue(old.push_name),
    verifiedName: cleanDirectoryValue(old.verified_name),
    firstSeenAt: old.first_seen_at,
    updatedAt: old.updated_at,
    rawJson: old.raw_json,
  });

  db.prepare(
    `update messages set sender_jid = @canonical
     where account_id = @accountId and sender_jid = @old`,
  ).run({ accountId, old: oldJid, canonical: canonicalJid });
  db.prepare(
    `update messages set quoted_sender_jid = @canonical
     where account_id = @accountId and quoted_sender_jid = @old`,
  ).run({ accountId, old: oldJid, canonical: canonicalJid });

  db.prepare(
    `insert into group_members (
       account_id, group_jid, participant_jid, role, is_active,
       first_seen_at, updated_at
     )
     select account_id, group_jid, @canonical, role, is_active,
            first_seen_at, updated_at
     from group_members
     where account_id = @accountId and participant_jid = @old
     on conflict (account_id, group_jid, participant_jid) do update set
       role = coalesce(group_members.role, excluded.role),
       is_active = max(group_members.is_active, excluded.is_active),
       first_seen_at = min(group_members.first_seen_at, excluded.first_seen_at),
       updated_at = max(group_members.updated_at, excluded.updated_at)`,
  ).run({ accountId, old: oldJid, canonical: canonicalJid });
  db.prepare(
    "delete from group_members where account_id = ? and participant_jid = ?",
  ).run(accountId, oldJid);
  db.prepare(
    `update participant_aliases set canonical_jid = @canonical,
       updated_at = @now
     where account_id = @accountId and canonical_jid = @old`,
  ).run({ accountId, old: oldJid, canonical: canonicalJid, now: nowSec() });
  db.prepare("delete from participants where account_id = ? and jid = ?").run(
    accountId,
    oldJid,
  );
}

export interface ParticipantRow {
  account_id: string;
  jid: string;
  lid: string | null;
  phone: string | null;
  display_name: string | null;
  push_name: string | null;
  verified_name: string | null;
  first_seen_at: number;
  updated_at: number;
  raw_json: string | null;
}

/** Resolve an incoming LID to the canonical phone JID when known. */
export function resolveParticipantJid(
  db: Database,
  accountId: string,
  jid: string,
): string {
  const normalized = normalizeJid(jid);
  if (directoryTablesAvailable(db)) {
    return resolveDirectoryJid(db, accountId, normalized);
  }
  const row = db
    .prepare<[string, string], Pick<ParticipantRow, "jid">>(
      `select canonical_jid as jid from participant_aliases
       where account_id = ? and alias_jid = ?`,
    )
    .get(accountId, normalized);
  if (row) return row.jid;
  if (!normalized.endsWith("@lid")) return normalized;
  const legacy = db
    .prepare<
      [string, string],
      Pick<ParticipantRow, "jid">
    >("select jid from participants where account_id = ? and lid = ?")
    .get(accountId, normalized);
  return legacy?.jid ?? normalized;
}

export function listKnownParticipantJids(
  db: Database,
  accountId: string,
): string[] {
  if (directoryTablesAvailable(db)) {
    return db
      .prepare<[string], { jid: string }>(
        `select canonical_jid as jid from directory_entities
         where account_id = ? and entity_type = 'contact'
         order by canonical_jid`,
      )
      .all(accountId)
      .map((row) => row.jid);
  }
  return db
    .prepare<[string], { jid: string }>(
      `select distinct canonical_jid as jid from participant_aliases
       where account_id = ? and canonical_jid not like '%@g.us'
       order by canonical_jid`,
    )
    .all(accountId)
    .map((row) => row.jid);
}

export interface GroupMemberInput {
  accountId: string;
  groupJid: string;
  participantJid: string;
  role?: "member" | "admin" | "superadmin" | null;
  isActive?: boolean;
}

export interface GroupMemberRow extends ParticipantRow {
  group_jid: string;
  role: "member" | "admin" | "superadmin" | null;
  is_active: number;
}

export function upsertGroupMember(db: Database, input: GroupMemberInput): void {
  if (directoryTablesAvailable(db)) {
    upsertDirectoryGroupMember(db, input);
    return;
  }
  const participantJid = resolveParticipantJid(
    db,
    input.accountId,
    normalizeJid(input.participantJid),
  );
  const now = nowSec();
  db.prepare(
    `insert into group_members (
       account_id, group_jid, participant_jid, role, is_active,
       first_seen_at, updated_at
     ) values (@accountId, @groupJid, @participantJid, @role, @isActive,
               @now, @now)
     on conflict (account_id, group_jid, participant_jid) do update set
       role = coalesce(excluded.role, group_members.role),
       is_active = case when @isActiveSet = 1
         then excluded.is_active else group_members.is_active end,
       updated_at = excluded.updated_at`,
  ).run({
    accountId: input.accountId,
    groupJid: normalizeJid(input.groupJid),
    participantJid,
    role: input.role ?? null,
    isActive: input.isActive === false ? 0 : 1,
    isActiveSet: input.isActive === undefined ? 0 : 1,
    now,
  });
}

export function markMissingGroupMembersInactive(
  db: Database,
  accountId: string,
  groupJid: string,
  activeJids: string[],
): void {
  if (directoryTablesAvailable(db)) {
    markDirectoryMissingMembersInactive(db, accountId, groupJid, activeJids);
    return;
  }
  const normalized = activeJids.map((jid) =>
    resolveParticipantJid(db, accountId, jid),
  );
  if (normalized.length === 0) {
    db.prepare(
      `update group_members set is_active = 0, updated_at = @now
       where account_id = @accountId and group_jid = @groupJid`,
    ).run({ accountId, groupJid: normalizeJid(groupJid), now: nowSec() });
    return;
  }
  const placeholders = normalized.map((_, index) => `@jid${index}`);
  const params: Record<string, unknown> = {
    accountId,
    groupJid: normalizeJid(groupJid),
    now: nowSec(),
  };
  normalized.forEach((jid, index) => {
    params[`jid${index}`] = jid;
  });
  db.prepare(
    `update group_members set is_active = 0, updated_at = @now
     where account_id = @accountId and group_jid = @groupJid
       and participant_jid not in (${placeholders.join(", ")})`,
  ).run(params);
}

export function listGroupMembers(
  db: Database,
  accountId: string,
  groupJid: string,
  limit = 200,
): GroupMemberRow[] {
  return db
    .prepare<[string, string, number], GroupMemberRow>(
      `select p.*, gm.group_jid, gm.role, gm.is_active
       from group_members gm
       join participants p on p.account_id = gm.account_id
         and p.jid = gm.participant_jid
       where gm.account_id = ? and gm.group_jid = ? and gm.is_active = 1
       order by coalesce(p.display_name, p.push_name, p.jid)
       limit ?`,
    )
    .all(accountId, normalizeJid(groupJid), limit);
}

export interface MessageInput {
  accountId: string;
  chatJid: string;
  messageId: string;
  senderJid?: string | null;
  fromMe?: boolean;
  timestamp?: number | null;
  messageType?: string | null;
  text?: string | null;
  normalizedText?: string | null;
  hasMedia?: boolean;
  durationS?: number | null;
  ingestionSource?: IngestionSource;
  quotedMessageId?: string | null;
  quotedSenderJid?: string | null;
  editedMessageId?: string | null;
  deletedAt?: number | null;
  rawJson?: string | null;
}

export type IngestionSource = "live" | "history" | "backup";

export type HistoryJobStatus =
  | "queued"
  | "waiting_connection"
  | "running"
  | "completed"
  | "failed";

export type HistoryJobPhase =
  | "queued"
  | "waiting_connection"
  | "requesting"
  | "ingesting"
  | "finalizing"
  | "done"
  | "failed";

export interface HistoryJobRow {
  id: string;
  account_id: string;
  chat_jid: string;
  since_ts: number;
  until_ts: number;
  status: HistoryJobStatus;
  phase: HistoryJobPhase;
  progress_percent: number | null;
  anchor_sender_jid: string | null;
  anchor_message_id: string | null;
  anchor_timestamp: number | null;
  oldest_seen_ts: number | null;
  batches_requested: number;
  batches_completed: number;
  messages_received: number;
  messages_inserted: number;
  coverage_complete: number;
  completion_reason: string | null;
  error_code: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
}

export interface HistoryAnchorRow {
  chat_jid: string;
  message_id: string;
  sender_jid: string | null;
  timestamp: number;
}

export interface HistoryJobInput {
  id: string;
  accountId: string;
  chatJid: string;
  sinceTs: number;
  untilTs: number;
  status?: HistoryJobStatus;
  phase?: HistoryJobPhase;
  anchorSenderJid?: string | null;
  anchorMessageId?: string | null;
  anchorTimestamp?: number | null;
  completionReason?: string | null;
}

export function createHistoryJob(db: Database, input: HistoryJobInput): void {
  const now = nowSec();
  db.prepare(
    `insert into history_jobs (
       id, account_id, chat_jid, since_ts, until_ts, status, phase,
       anchor_sender_jid, anchor_message_id, anchor_timestamp,
       completion_reason, created_at, updated_at
     ) values (
       @id, @accountId, @chatJid, @sinceTs, @untilTs, @status, @phase,
       @anchorSenderJid, @anchorMessageId, @anchorTimestamp,
       @completionReason, @now, @now
     )`,
  ).run({
    id: input.id,
    accountId: input.accountId,
    chatJid: input.chatJid,
    sinceTs: input.sinceTs,
    untilTs: input.untilTs,
    status: input.status ?? "queued",
    phase: input.phase ?? "queued",
    anchorSenderJid: input.anchorSenderJid ?? null,
    anchorMessageId: input.anchorMessageId ?? null,
    anchorTimestamp: input.anchorTimestamp ?? null,
    completionReason: input.completionReason ?? null,
    now,
  });
}

export function getHistoryJob(
  db: Database,
  accountId: string,
  id: string,
): HistoryJobRow | undefined {
  return db
    .prepare<
      [string, string],
      HistoryJobRow
    >("select * from history_jobs where account_id = ? and id = ?")
    .get(accountId, id);
}

export function getActiveHistoryJob(
  db: Database,
  accountId: string,
): HistoryJobRow | undefined {
  return db
    .prepare<[string], HistoryJobRow>(
      `select * from history_jobs
       where account_id = ? and status in ('queued', 'waiting_connection', 'running')
       order by created_at asc limit 1`,
    )
    .get(accountId);
}

export interface HistoryJobPatch {
  status?: HistoryJobStatus;
  phase?: HistoryJobPhase;
  progressPercent?: number | null;
  anchorSenderJid?: string | null;
  anchorMessageId?: string | null;
  anchorTimestamp?: number | null;
  oldestSeenTs?: number | null;
  batchesRequested?: number;
  batchesCompleted?: number;
  messagesReceived?: number;
  messagesInserted?: number;
  coverageComplete?: boolean;
  completionReason?: string | null;
  errorCode?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export function updateHistoryJob(
  db: Database,
  accountId: string,
  id: string,
  patch: HistoryJobPatch,
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = {
    accountId,
    id,
    updatedAt: nowSec(),
  };
  const fields: Array<[keyof HistoryJobPatch, string]> = [
    ["status", "status"],
    ["phase", "phase"],
    ["progressPercent", "progress_percent"],
    ["anchorSenderJid", "anchor_sender_jid"],
    ["anchorMessageId", "anchor_message_id"],
    ["anchorTimestamp", "anchor_timestamp"],
    ["oldestSeenTs", "oldest_seen_ts"],
    ["batchesRequested", "batches_requested"],
    ["batchesCompleted", "batches_completed"],
    ["messagesReceived", "messages_received"],
    ["messagesInserted", "messages_inserted"],
    ["coverageComplete", "coverage_complete"],
    ["completionReason", "completion_reason"],
    ["errorCode", "error_code"],
    ["startedAt", "started_at"],
    ["completedAt", "completed_at"],
  ];
  for (const [inputName, column] of fields) {
    const value = patch[inputName];
    if (value === undefined) continue;
    sets.push(`${column} = @${String(inputName)}`);
    params[String(inputName)] =
      inputName === "coverageComplete" ? (value ? 1 : 0) : value;
  }
  if (sets.length === 0) return;
  sets.push("updated_at = @updatedAt");
  db.prepare(
    `update history_jobs set ${sets.join(", ")} where account_id = @accountId and id = @id`,
  ).run(params);
}

export function getHistoryAnchor(
  db: Database,
  accountId: string,
  chatJid: string,
): HistoryAnchorRow | undefined {
  return db
    .prepare<[string, string], HistoryAnchorRow>(
      `select chat_jid, message_id, sender_jid, timestamp
       from messages
       where account_id = ? and chat_jid = ? and timestamp is not null
       order by timestamp asc, rowid asc limit 1`,
    )
    .get(accountId, chatJid);
}

export interface MessageRow {
  account_id: string;
  chat_jid: string;
  message_id: string;
  sender_jid: string | null;
  from_me: number;
  timestamp: number | null;
  received_at: number;
  message_type: string | null;
  text: string | null;
  normalized_text: string | null;
  has_media: number;
  duration_s: number | null;
  ingestion_source: IngestionSource;
  quoted_message_id: string | null;
  quoted_sender_jid: string | null;
  edited_message_id: string | null;
  deleted_at: number | null;
  raw_json: string | null;
}

/**
 * Idempotent message persistence keyed on
 * `(account_id, chat_jid, message_id)`. On replay we refresh mutable fields
 * (edits, deletes, late normalization, raw payload) but never overwrite the
 * original `received_at`, `from_me`, or first-seen `timestamp`.
 */
export function upsertMessage(db: Database, input: MessageInput): void {
  db.prepare(
    `insert into messages (
       account_id, chat_jid, message_id, sender_jid, from_me, timestamp,
       received_at, message_type, text, normalized_text, has_media,
       duration_s, ingestion_source,
       quoted_message_id, quoted_sender_jid, edited_message_id, deleted_at, raw_json
     ) values (
       @accountId, @chatJid, @messageId, @senderJid, @fromMe, @timestamp,
       @receivedAt, @messageType, @text, @normalizedText, @hasMedia,
       @durationS, @ingestionSource,
       @quotedMessageId, @quotedSenderJid, @editedMessageId, @deletedAt, @rawJson
     )
     on conflict (account_id, chat_jid, message_id) do update set
       sender_jid = coalesce(excluded.sender_jid, messages.sender_jid),
       message_type = coalesce(excluded.message_type, messages.message_type),
       text = coalesce(excluded.text, messages.text),
       normalized_text = coalesce(excluded.normalized_text, messages.normalized_text),
       -- Preserve a prior has_media=1 on partial replays (revoke/edit) that omit it.
       has_media = case when @hasMediaSet = 1 then @hasMedia else messages.has_media end,
       duration_s = coalesce(excluded.duration_s, messages.duration_s),
       ingestion_source = case when @ingestionSourceSet = 1
         then excluded.ingestion_source else messages.ingestion_source end,
       quoted_message_id = coalesce(excluded.quoted_message_id, messages.quoted_message_id),
       quoted_sender_jid = coalesce(excluded.quoted_sender_jid, messages.quoted_sender_jid),
       edited_message_id = coalesce(excluded.edited_message_id, messages.edited_message_id),
       deleted_at = coalesce(excluded.deleted_at, messages.deleted_at),
       raw_json = coalesce(excluded.raw_json, messages.raw_json)`,
  ).run({
    accountId: input.accountId,
    chatJid: input.chatJid,
    messageId: input.messageId,
    senderJid: input.senderJid ?? null,
    fromMe: input.fromMe ? 1 : 0,
    timestamp: input.timestamp ?? null,
    receivedAt: nowSec(),
    messageType: input.messageType ?? null,
    text: input.text ?? null,
    normalizedText: input.normalizedText ?? null,
    hasMedia: input.hasMedia ? 1 : 0,
    hasMediaSet: input.hasMedia === undefined ? 0 : 1,
    durationS: input.durationS ?? null,
    ingestionSource: input.ingestionSource ?? "live",
    ingestionSourceSet: input.ingestionSource === undefined ? 0 : 1,
    quotedMessageId: input.quotedMessageId ?? null,
    quotedSenderJid: input.quotedSenderJid ?? null,
    editedMessageId: input.editedMessageId ?? null,
    deletedAt: input.deletedAt ?? null,
    rawJson: input.rawJson ?? null,
  });
}

export interface AttachmentInput {
  accountId: string;
  chatJid: string;
  messageId: string;
  attachmentIndex?: number;
  mediaType?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  filePath?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  downloadedAt?: number | null;
  rawJson?: string | null;
}

export function upsertAttachment(db: Database, input: AttachmentInput): void {
  db.prepare(
    `insert into attachments (
       account_id, chat_jid, message_id, attachment_index, media_type,
       mime_type, file_name, file_path, sha256, size_bytes, downloaded_at, raw_json
     ) values (
       @accountId, @chatJid, @messageId, @attachmentIndex, @mediaType,
       @mimeType, @fileName, @filePath, @sha256, @sizeBytes, @downloadedAt, @rawJson
     )
     on conflict (account_id, chat_jid, message_id, attachment_index) do update set
       media_type = coalesce(excluded.media_type, attachments.media_type),
       mime_type = coalesce(excluded.mime_type, attachments.mime_type),
       file_name = coalesce(excluded.file_name, attachments.file_name),
       file_path = coalesce(excluded.file_path, attachments.file_path),
       sha256 = coalesce(excluded.sha256, attachments.sha256),
       size_bytes = coalesce(excluded.size_bytes, attachments.size_bytes),
       downloaded_at = coalesce(excluded.downloaded_at, attachments.downloaded_at),
       raw_json = coalesce(excluded.raw_json, attachments.raw_json)`,
  ).run({
    accountId: input.accountId,
    chatJid: input.chatJid,
    messageId: input.messageId,
    attachmentIndex: input.attachmentIndex ?? 0,
    mediaType: input.mediaType ?? null,
    mimeType: input.mimeType ?? null,
    fileName: input.fileName ?? null,
    filePath: input.filePath ?? null,
    sha256: input.sha256 ?? null,
    sizeBytes: input.sizeBytes ?? null,
    downloadedAt: input.downloadedAt ?? null,
    rawJson: input.rawJson ?? null,
  });
}

export interface AttachmentRow {
  account_id: string;
  chat_jid: string;
  message_id: string;
  attachment_index: number;
  media_type: string | null;
  mime_type: string | null;
  file_name: string | null;
  file_path: string | null;
  sha256: string | null;
  size_bytes: number | null;
  downloaded_at: number | null;
  raw_json: string | null;
}

export function getAttachment(
  db: Database,
  accountId: string,
  chatJid: string,
  messageId: string,
  attachmentIndex = 0,
): AttachmentRow | undefined {
  return db
    .prepare<[string, string, string, number], AttachmentRow>(
      `select * from attachments
       where account_id = ? and chat_jid = ? and message_id = ? and attachment_index = ?`,
    )
    .get(accountId, chatJid, messageId, attachmentIndex);
}

export function getMessage(
  db: Database,
  accountId: string,
  chatJid: string,
  messageId: string,
): MessageRow | undefined {
  return db
    .prepare<
      [string, string, string],
      MessageRow
    >("select * from messages where account_id = ? and chat_jid = ? and message_id = ?")
    .get(accountId, chatJid, messageId);
}

export interface ListMessagesOptions {
  accountId?: string;
  chatJid?: string;
  sinceTs?: number | null;
  limit?: number;
}

/** List messages, most-recent first (for human/JSON inspection). */
export function listMessages(
  db: Database,
  opts: ListMessagesOptions = {},
): MessageRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.accountId) {
    where.push("account_id = @accountId");
    params.accountId = opts.accountId;
  }
  if (opts.chatJid) {
    where.push("chat_jid = @chatJid");
    params.chatJid = opts.chatJid;
  }
  if (opts.sinceTs != null) {
    where.push("timestamp >= @sinceTs");
    params.sinceTs = opts.sinceTs;
  }
  if (opts.limit != null) params.limit = opts.limit;
  const sql =
    `select * from messages ${where.length ? `where ${where.join(" and ")}` : ""} ` +
    `order by coalesce(timestamp, 0) desc, rowid desc ` +
    `${opts.limit != null ? "limit @limit" : ""}`;
  return db.prepare(sql).all(params) as MessageRow[];
}

export interface ExportRow extends MessageRow {
  /** Stable per-row cursor for resumable export (the message's SQLite rowid). */
  export_rowid: number;
  chat_name: string | null;
  chat_is_group: number;
  chat_is_status: number;
  chat_is_allowed: number;
}

export interface ExportSelect {
  accountId?: string;
  /** Inclusive lower bound on message timestamp (epoch seconds). */
  sinceTs?: number | null;
  /** Inclusive upper bound on the message timestamp. */
  beforeTs?: number | null;
  /** Exclusive lower bound on the rowid cursor (for --since-last). */
  afterRowid?: number | null;
  /** Restrict to allowed chats (is_allowed = 1 or in `allowedChats`). */
  allowedOnly?: boolean;
  allowedChats?: string[];
  /** Config-level blocked chats to exclude in addition to the DB flag. */
  blockedChats?: string[];
  limit?: number;
}

/**
 * Select messages for export in deterministic ingestion order (ascending
 * rowid), joined with their chat. `export_rowid` is the resumable cursor used
 * by consumer offsets.
 */
export function selectExportMessages(
  db: Database,
  sel: ExportSelect = {},
): ExportRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (sel.accountId) {
    where.push("m.account_id = @accountId");
    params.accountId = sel.accountId;
  }
  if (sel.sinceTs != null) {
    where.push("m.timestamp >= @sinceTs");
    params.sinceTs = sel.sinceTs;
  }
  if (sel.beforeTs != null) {
    where.push("m.timestamp <= @beforeTs");
    params.beforeTs = sel.beforeTs;
  }
  if (sel.afterRowid != null) {
    where.push("m.rowid > @afterRowid");
    params.afterRowid = sel.afterRowid;
  }
  // Chats blocked via `chats block` (DB flag) are never exported.
  where.push("c.is_blocked = 0");
  // Config-level blocked_chats are excluded too, even under --all.
  const blocked = sel.blockedChats ?? [];
  if (blocked.length > 0) {
    const placeholders = blocked.map((_, i) => `@bc${i}`);
    blocked.forEach((jid, i) => {
      params[`bc${i}`] = jid;
    });
    where.push(`m.chat_jid not in (${placeholders.join(", ")})`);
  }
  if (sel.allowedOnly) {
    const allow = sel.allowedChats ?? [];
    const placeholders = allow.map((_, i) => `@ac${i}`);
    allow.forEach((jid, i) => {
      params[`ac${i}`] = jid;
    });
    const inClause =
      placeholders.length > 0
        ? ` or m.chat_jid in (${placeholders.join(", ")})`
        : "";
    where.push(`(c.is_allowed = 1${inClause})`);
  }
  if (sel.limit != null) params.limit = sel.limit;

  const sql =
    `select m.rowid as export_rowid, m.*, ` +
    `c.name as chat_name, c.is_group as chat_is_group, ` +
    `c.is_status as chat_is_status, c.is_allowed as chat_is_allowed ` +
    `from messages m ` +
    `join chats c on c.account_id = m.account_id and c.jid = m.chat_jid ` +
    `${where.length ? `where ${where.join(" and ")}` : ""} ` +
    `order by m.rowid asc ` +
    `${sel.limit != null ? "limit @limit" : ""}`;
  return db.prepare(sql).all(params) as ExportRow[];
}

export function countMessages(db: Database, accountId?: string): number {
  if (accountId === undefined) {
    return (
      db.prepare<[], { n: number }>("select count(*) as n from messages").get()
        ?.n ?? 0
    );
  }
  return (
    db
      .prepare<
        [string],
        { n: number }
      >("select count(*) as n from messages where account_id = ?")
      .get(accountId)?.n ?? 0
  );
}

export interface EventInput {
  accountId: string;
  eventType: string;
  eventTs?: number | null;
  rawJson: string;
}

export function insertEvent(db: Database, input: EventInput): number {
  const info = db
    .prepare(
      `insert into events (account_id, event_type, event_ts, ingested_at, raw_json)
       values (@accountId, @eventType, @eventTs, @ingestedAt, @rawJson)`,
    )
    .run({
      accountId: input.accountId,
      eventType: input.eventType,
      eventTs: input.eventTs ?? null,
      ingestedAt: nowSec(),
      rawJson: input.rawJson,
    });
  return Number(info.lastInsertRowid);
}

export interface ConsumerOffsetRow {
  consumer_name: string;
  last_seen_timestamp: number | null;
  last_seen_event_id: number | null;
  updated_at: number;
}

export function getConsumerOffset(
  db: Database,
  consumerName: string,
): ConsumerOffsetRow | undefined {
  return db
    .prepare<
      [string],
      ConsumerOffsetRow
    >("select * from consumer_offsets where consumer_name = ?")
    .get(consumerName);
}

export function setConsumerOffset(
  db: Database,
  consumerName: string,
  offset: {
    lastSeenTimestamp?: number | null;
    lastSeenEventId?: number | null;
  },
): void {
  db.prepare(
    `insert into consumer_offsets (
       consumer_name, last_seen_timestamp, last_seen_event_id, updated_at
     ) values (@name, @ts, @eventId, @now)
     on conflict (consumer_name) do update set
       -- Advance only the cursors provided; never erase the other component
       -- (both are needed for --since-last resume).
       last_seen_timestamp = coalesce(excluded.last_seen_timestamp, consumer_offsets.last_seen_timestamp),
       last_seen_event_id = coalesce(excluded.last_seen_event_id, consumer_offsets.last_seen_event_id),
       updated_at = excluded.updated_at`,
  ).run({
    name: consumerName,
    ts: offset.lastSeenTimestamp ?? null,
    eventId: offset.lastSeenEventId ?? null,
    now: nowSec(),
  });
}
