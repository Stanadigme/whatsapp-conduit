import type { Database } from "better-sqlite3";
import { normalizeJid, phoneFromJid } from "../baileys/jid.js";
import { nowSec } from "../util/time.js";

export type DirectoryEntityType = "contact" | "group";
export type DirectoryNameSource =
  | "local"
  | "display_name"
  | "verified_name"
  | "push_name"
  | "group_info"
  | "group_joined"
  | "message";
export type DirectoryMemberRole = "member" | "admin" | "superadmin";

export interface DirectoryContactInput {
  accountId: string;
  jid: string;
  lid?: string | null;
  phone?: string | null;
  displayName?: string | null;
  pushName?: string | null;
  verifiedName?: string | null;
  rawJson?: string | null;
  lastSyncedAt?: number | null;
}

export interface DirectoryGroupInput {
  accountId: string;
  jid: string;
  name?: string | null;
  nameSource?: DirectoryNameSource;
  rawJson?: string | null;
  lastSyncedAt?: number | null;
}

export interface DirectoryEntityRow {
  id: number;
  account_id: string;
  entity_type: DirectoryEntityType;
  canonical_jid: string;
  name: string | null;
  display_name: string | null;
  push_name: string | null;
  verified_name: string | null;
  name_source: DirectoryNameSource | null;
  first_seen_at: number;
  updated_at: number;
  last_synced_at: number | null;
  raw_json: string | null;
}

export interface DirectoryAliasRow {
  account_id: string;
  alias_jid: string;
  entity_id: number;
  alias_type: "canonical" | "phone" | "lid";
  first_seen_at: number;
  updated_at: number;
}

export interface DirectoryGroupMemberInput {
  accountId: string;
  groupJid: string;
  participantJid: string;
  role?: DirectoryMemberRole | null;
  isActive?: boolean;
}

export interface DirectoryGroupMemberRow extends DirectoryEntityRow {
  group_entity_id: number;
  member_entity_id: number;
  role: DirectoryMemberRole | null;
  is_active: number;
}

const NAME_RANK: Record<string, number> = {
  message: 10,
  push_name: 30,
  group_joined: 30,
  verified_name: 40,
  group_info: 40,
  display_name: 50,
  local: 50,
};

export function directoryTablesAvailable(db: Database): boolean {
  return Boolean(
    db
      .prepare<
        [string],
        { name: string }
      >("select name from sqlite_master where type = 'table' and name = ?")
      .get("directory_entities"),
  );
}

export function resolveDirectoryJid(
  db: Database,
  accountId: string,
  jid: string,
): string {
  const alias = db
    .prepare<[string, string], { canonical_jid: string }>(
      `select e.canonical_jid
       from directory_aliases a
       join directory_entities e on e.id = a.entity_id
       where a.account_id = ? and a.alias_jid = ?`,
    )
    .get(accountId, normalizeJid(jid));
  return alias?.canonical_jid ?? normalizeJid(jid);
}

export function upsertDirectoryContact(
  db: Database,
  input: DirectoryContactInput,
): DirectoryEntityRow {
  const write = db.transaction(() => {
    const jid = normalizeJid(input.jid);
    const lid = input.lid
      ? normalizeJid(input.lid)
      : jid.endsWith("@lid")
        ? jid
        : null;
    const phoneJid = jid.endsWith("@s.whatsapp.net")
      ? jid
      : input.phone && /^\d+$/.test(input.phone)
        ? `${input.phone}@s.whatsapp.net`
        : null;
    const aliases = [jid, lid].filter(
      (value): value is string => value !== null,
    );
    const mapped = aliases
      .map((alias) =>
        db
          .prepare<[string, string], { id: number; canonical_jid: string }>(
            `select e.id, e.canonical_jid
             from directory_aliases a
             join directory_entities e on e.id = a.entity_id
             where a.account_id = ? and a.alias_jid = ?`,
          )
          .get(input.accountId, alias),
      )
      .filter(
        (value): value is { id: number; canonical_jid: string } =>
          value !== undefined,
      );
    const canonicalJid =
      phoneJid ??
      mapped.find((value) => !value.canonical_jid.endsWith("@lid"))
        ?.canonical_jid ??
      mapped[0]?.canonical_jid ??
      jid;
    const oldIds = [
      ...new Set(
        mapped
          .filter((value) => value.canonical_jid !== canonicalJid)
          .map((value) => value.id),
      ),
    ];
    const canonical = ensureEntity(
      db,
      input.accountId,
      "contact",
      canonicalJid,
    );
    for (const oldId of oldIds) {
      mergeDirectoryEntity(db, input.accountId, oldId, canonical.id);
    }

    const current = getEntityById(db, canonical.id);
    if (!current) throw new Error("directory contact entity disappeared");
    const displayName = clean(input.displayName);
    const pushName = clean(input.pushName);
    const verifiedName = clean(input.verifiedName);
    const incomingName = bestName([
      { value: displayName, source: "display_name" },
      { value: verifiedName, source: "verified_name" },
      { value: pushName, source: "push_name" },
    ]);
    const selectedName = selectName(current, incomingName);
    const now = nowSec();
    db.prepare(
      `update directory_entities set
         name = @name,
         display_name = coalesce(@displayName, display_name),
         push_name = coalesce(@pushName, push_name),
         verified_name = coalesce(@verifiedName, verified_name),
         name_source = @nameSource,
         updated_at = @now,
         last_synced_at = coalesce(@lastSyncedAt, last_synced_at),
         raw_json = coalesce(@rawJson, raw_json)
       where id = @id`,
    ).run({
      id: canonical.id,
      name: selectedName.value,
      displayName,
      pushName,
      verifiedName,
      nameSource: selectedName.source,
      now,
      lastSyncedAt: input.lastSyncedAt ?? null,
      rawJson: input.rawJson ?? null,
    });

    upsertDirectoryAlias(db, input.accountId, canonical.id, canonicalJid, now);
    for (const alias of aliases) {
      upsertDirectoryAlias(db, input.accountId, canonical.id, alias, now);
    }
    projectContact(db, input.accountId, canonical.id, input.phone, lid, now);
    const result = getEntityById(db, canonical.id);
    if (!result) throw new Error("directory contact entity was not persisted");
    return result;
  });
  return write();
}

export function upsertDirectoryGroup(
  db: Database,
  input: DirectoryGroupInput,
): DirectoryEntityRow {
  const write = db.transaction(() => {
    const jid = normalizeJid(input.jid);
    const entity = ensureEntity(db, input.accountId, "group", jid);
    const current = getEntityById(db, entity.id);
    if (!current) throw new Error("directory group entity disappeared");
    const name = clean(input.name);
    const source = input.nameSource ?? "group_info";
    const selected = selectName(current, name ? { value: name, source } : null);
    const now = nowSec();
    db.prepare(
      `update directory_entities set
         name = @name,
         name_source = @nameSource,
         updated_at = @now,
         last_synced_at = coalesce(@lastSyncedAt, last_synced_at),
         raw_json = coalesce(@rawJson, raw_json)
       where id = @id`,
    ).run({
      id: entity.id,
      name: selected.value,
      nameSource: selected.source,
      now,
      lastSyncedAt: input.lastSyncedAt ?? null,
      rawJson: input.rawJson ?? null,
    });
    upsertDirectoryAlias(db, input.accountId, entity.id, jid, now);
    projectGroup(db, input.accountId, entity.id, now);
    const result = getEntityById(db, entity.id);
    if (!result) throw new Error("directory group entity was not persisted");
    return result;
  });
  return write();
}

export function upsertDirectoryGroupMember(
  db: Database,
  input: DirectoryGroupMemberInput,
): void {
  const write = db.transaction(() => {
    const group = upsertDirectoryGroup(db, {
      accountId: input.accountId,
      jid: input.groupJid,
    });
    const member = upsertDirectoryContact(db, {
      accountId: input.accountId,
      jid: input.participantJid,
    });
    const now = nowSec();
    db.prepare(
      `insert into directory_group_members (
         account_id, group_entity_id, member_entity_id, role, is_active,
         first_seen_at, updated_at
       ) values (@accountId, @groupId, @memberId, @role, @isActive,
                 @now, @now)
       on conflict (account_id, group_entity_id, member_entity_id) do update set
         role = coalesce(excluded.role, directory_group_members.role),
         is_active = case when @isActiveSet = 1
           then excluded.is_active else directory_group_members.is_active end,
         updated_at = excluded.updated_at`,
    ).run({
      accountId: input.accountId,
      groupId: group.id,
      memberId: member.id,
      role: input.role ?? null,
      isActive: input.isActive === false ? 0 : 1,
      isActiveSet: input.isActive === undefined ? 0 : 1,
      now,
    });
    projectGroupMember(db, input.accountId, group.id, member.id, now);
  });
  write();
}

export function markDirectoryMissingMembersInactive(
  db: Database,
  accountId: string,
  groupJid: string,
  activeJids: string[],
): void {
  const group = getDirectoryEntityByJid(db, accountId, groupJid, "group");
  if (!group) return;
  const activeIds = activeJids
    .map((jid) => getDirectoryEntityByJid(db, accountId, jid, "contact"))
    .filter((entity): entity is DirectoryEntityRow => entity !== undefined);
  const activeCanonicalJids = activeIds.map((entity) => entity.canonical_jid);
  const activeEntityIds = activeIds.map((entity) => entity.id);
  const params: Record<string, unknown> = {
    accountId,
    groupId: group.id,
    now: nowSec(),
  };
  const clause = activeEntityIds.length
    ? `and member_entity_id not in (${activeEntityIds.map((_, i) => `@member${i}`).join(", ")})`
    : "";
  activeEntityIds.forEach((id, index) => {
    params[`member${index}`] = id;
  });
  db.prepare(
    `update directory_group_members set is_active = 0, updated_at = @now
     where account_id = @accountId and group_entity_id = @groupId ${clause}`,
  ).run(params);
  db.prepare(
    `update group_members set is_active = 0, updated_at = @now
       where account_id = @accountId and group_jid = @groupJid ${
         activeCanonicalJids.length
           ? `and participant_jid not in (${activeCanonicalJids.map((_, i) => `@jid${i}`).join(", ")})`
           : ""
       }`,
  ).run({
    accountId,
    groupJid: normalizeJid(groupJid),
    now: nowSec(),
    ...Object.fromEntries(
      activeCanonicalJids.map((jid, i) => [`jid${i}`, jid]),
    ),
  });
}

export function listDirectoryKnownContactJids(
  db: Database,
  accountId: string,
): string[] {
  return db
    .prepare<[string], { canonical_jid: string }>(
      `select canonical_jid from directory_entities
       where account_id = ? and entity_type = 'contact'
       order by canonical_jid`,
    )
    .all(accountId)
    .map((row) => row.canonical_jid);
}

export function getDirectoryEntityByJid(
  db: Database,
  accountId: string,
  jid: string,
  type?: DirectoryEntityType,
): DirectoryEntityRow | undefined {
  const typeClause = type ? "and e.entity_type = @type" : "";
  return db
    .prepare(
      `select e.* from directory_entities e
       left join directory_aliases a on a.entity_id = e.id
       where e.account_id = @accountId
         and (e.canonical_jid = @jid or a.alias_jid = @jid)
         ${typeClause}
       order by case when e.canonical_jid = @jid then 0 else 1 end
       limit 1`,
    )
    .get({
      accountId,
      jid: normalizeJid(jid),
      ...(type ? { type } : {}),
    }) as DirectoryEntityRow | undefined;
}

export function listDirectoryAliases(
  db: Database,
  accountId: string,
  entityId: number,
): DirectoryAliasRow[] {
  return db
    .prepare<[string, number], DirectoryAliasRow>(
      `select * from directory_aliases
       where account_id = ? and entity_id = ?
       order by alias_type, alias_jid`,
    )
    .all(accountId, entityId);
}

export function listDirectoryGroupMembers(
  db: Database,
  accountId: string,
  groupJid: string,
  limit = 200,
): DirectoryGroupMemberRow[] {
  return db
    .prepare<[string, string, number], DirectoryGroupMemberRow>(
      `select m.*, gm.group_entity_id, gm.member_entity_id,
              gm.role, gm.is_active
       from directory_group_members gm
       join directory_entities g on g.id = gm.group_entity_id
       join directory_entities m on m.id = gm.member_entity_id
       where gm.account_id = ? and g.canonical_jid = ? and gm.is_active = 1
       order by coalesce(m.name, m.canonical_jid)
       limit ?`,
    )
    .all(accountId, normalizeJid(groupJid), limit);
}

interface NameCandidate {
  value: string;
  source: DirectoryNameSource;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function bestName(
  candidates: Array<{ value: string | null; source: DirectoryNameSource }>,
): NameCandidate | null {
  const candidate = candidates.find((item) => item.value !== null);
  return candidate?.value
    ? { value: candidate.value, source: candidate.source }
    : null;
}

function selectName(
  current: DirectoryEntityRow,
  incoming: NameCandidate | null,
): { value: string | null; source: DirectoryNameSource | null } {
  const currentValue = clean(current.name);
  if (!incoming) return { value: currentValue, source: current.name_source };
  const currentRank = current.name_source
    ? (NAME_RANK[current.name_source] ?? 0)
    : 0;
  return (NAME_RANK[incoming.source] ?? 0) >= currentRank
    ? incoming
    : { value: currentValue, source: current.name_source };
}

function ensureEntity(
  db: Database,
  accountId: string,
  type: DirectoryEntityType,
  canonicalJid: string,
): DirectoryEntityRow {
  const now = nowSec();
  db.prepare(
    `insert into directory_entities (
       account_id, entity_type, canonical_jid, first_seen_at, updated_at
     ) values (@accountId, @type, @jid, @now, @now)
     on conflict (account_id, canonical_jid) do nothing`,
  ).run({ accountId, type, jid: canonicalJid, now });
  const entity = getDirectoryEntityByJid(db, accountId, canonicalJid, type);
  if (!entity) throw new Error("directory entity was not created");
  return entity;
}

function getEntityById(
  db: Database,
  id: number,
): DirectoryEntityRow | undefined {
  return db
    .prepare<
      [number],
      DirectoryEntityRow
    >("select * from directory_entities where id = ?")
    .get(id);
}

function upsertDirectoryAlias(
  db: Database,
  accountId: string,
  entityId: number,
  aliasJid: string,
  now: number,
): void {
  const alias = normalizeJid(aliasJid);
  const aliasType = alias.endsWith("@lid")
    ? "lid"
    : alias.endsWith("@s.whatsapp.net")
      ? alias === getEntityById(db, entityId)?.canonical_jid
        ? "canonical"
        : "phone"
      : "canonical";
  db.prepare(
    `insert into directory_aliases (
       account_id, alias_jid, entity_id, alias_type, first_seen_at, updated_at
     ) values (@accountId, @aliasJid, @entityId, @aliasType, @now, @now)
     on conflict (account_id, alias_jid) do update set
       entity_id = excluded.entity_id,
       alias_type = excluded.alias_type,
       updated_at = excluded.updated_at`,
  ).run({ accountId, aliasJid: alias, entityId, aliasType, now });
}

function mergeDirectoryEntity(
  db: Database,
  accountId: string,
  oldId: number,
  canonicalId: number,
): void {
  if (oldId === canonicalId) return;
  const old = getEntityById(db, oldId);
  const canonical = getEntityById(db, canonicalId);
  if (!old || !canonical) return;
  const currentName = selectName(
    canonical,
    old.name
      ? { value: old.name, source: old.name_source ?? "push_name" }
      : null,
  );
  db.prepare(
    `update directory_entities set
       name = @name, name_source = @nameSource,
       display_name = coalesce(display_name, @displayName),
       push_name = coalesce(push_name, @pushName),
       verified_name = coalesce(verified_name, @verifiedName),
       first_seen_at = min(first_seen_at, @firstSeenAt),
       updated_at = max(updated_at, @updatedAt),
       last_synced_at = coalesce(last_synced_at, @lastSyncedAt),
       raw_json = coalesce(raw_json, @rawJson)
     where id = @id`,
  ).run({
    id: canonicalId,
    name: currentName.value,
    nameSource: currentName.source,
    displayName: old.display_name,
    pushName: old.push_name,
    verifiedName: old.verified_name,
    firstSeenAt: old.first_seen_at,
    updatedAt: old.updated_at,
    lastSyncedAt: old.last_synced_at,
    rawJson: old.raw_json,
  });
  db.prepare(
    `insert into directory_aliases (
       account_id, alias_jid, entity_id, alias_type, first_seen_at, updated_at
     ) select account_id, alias_jid, @canonicalId, alias_type,
              first_seen_at, updated_at
       from directory_aliases where account_id = @accountId and entity_id = @oldId
     on conflict (account_id, alias_jid) do update set
       entity_id = excluded.entity_id,
       updated_at = max(directory_aliases.updated_at, excluded.updated_at)`,
  ).run({ accountId, oldId, canonicalId });
  db.prepare(
    `insert into directory_group_members (
       account_id, group_entity_id, member_entity_id, role, is_active,
       first_seen_at, updated_at
     ) select account_id, group_entity_id, @canonicalId, role, is_active,
              first_seen_at, updated_at
       from directory_group_members
       where account_id = @accountId and member_entity_id = @oldId
     on conflict (account_id, group_entity_id, member_entity_id) do update set
       role = coalesce(directory_group_members.role, excluded.role),
       is_active = max(directory_group_members.is_active, excluded.is_active),
       updated_at = max(directory_group_members.updated_at, excluded.updated_at)`,
  ).run({ accountId, oldId, canonicalId });
  db.prepare(
    `delete from directory_group_members
     where account_id = @accountId and member_entity_id = @oldId`,
  ).run({ accountId, oldId });
  db.prepare(
    `update messages set sender_jid = @canonical
     where account_id = @accountId and sender_jid = @old`,
  ).run({
    accountId,
    old: old.canonical_jid,
    canonical: canonical.canonical_jid,
  });
  db.prepare(
    `update messages set quoted_sender_jid = @canonical
      where account_id = @accountId and quoted_sender_jid = @old`,
  ).run({
    accountId,
    old: old.canonical_jid,
    canonical: canonical.canonical_jid,
  });
  const oldParticipant = db
    .prepare<
      [string, string],
      { jid: string }
    >("select jid from participants where account_id = ? and jid = ?")
    .get(accountId, old.canonical_jid);
  const canonicalParticipant = db
    .prepare<
      [string, string],
      { jid: string }
    >("select jid from participants where account_id = ? and jid = ?")
    .get(accountId, canonical.canonical_jid);
  if (oldParticipant && !canonicalParticipant) {
    db.prepare(
      `insert into participants (
         account_id, jid, lid, phone, display_name, push_name, verified_name,
         first_seen_at, updated_at, raw_json
       ) select account_id, @canonical, lid, phone, display_name, push_name,
                verified_name, first_seen_at, updated_at, raw_json
         from participants where account_id = @accountId and jid = @old
       on conflict (account_id, jid) do nothing`,
    ).run({
      accountId,
      old: old.canonical_jid,
      canonical: canonical.canonical_jid,
    });
  }
  db.prepare(
    `update participant_aliases set canonical_jid = @canonical
      where account_id = @accountId and canonical_jid = @old`,
  ).run({
    accountId,
    old: old.canonical_jid,
    canonical: canonical.canonical_jid,
  });
  if (oldParticipant && canonicalParticipant) {
    db.prepare(
      `update participants set
         phone = coalesce(nullif(phone, ''), (select nullif(phone, '') from participants where account_id = @accountId and jid = @old)),
         display_name = coalesce(nullif(display_name, ''), (select nullif(display_name, '') from participants where account_id = @accountId and jid = @old)),
         push_name = coalesce(nullif(push_name, ''), (select nullif(push_name, '') from participants where account_id = @accountId and jid = @old)),
         verified_name = coalesce(nullif(verified_name, ''), (select nullif(verified_name, '') from participants where account_id = @accountId and jid = @old)),
         raw_json = coalesce(raw_json, (select raw_json from participants where account_id = @accountId and jid = @old)),
         first_seen_at = min(first_seen_at, (select first_seen_at from participants where account_id = @accountId and jid = @old)),
         updated_at = max(updated_at, (select updated_at from participants where account_id = @accountId and jid = @old))
       where account_id = @accountId and jid = @canonical`,
    ).run({
      accountId,
      old: old.canonical_jid,
      canonical: canonical.canonical_jid,
    });
    db.prepare(
      `insert into group_members (
         account_id, group_jid, participant_jid, role, is_active,
         first_seen_at, updated_at
       ) select account_id, group_jid, @canonical, role, is_active,
                first_seen_at, updated_at
         from group_members
         where account_id = @accountId and participant_jid = @old
       on conflict (account_id, group_jid, participant_jid) do update set
         role = coalesce(group_members.role, excluded.role),
         is_active = max(group_members.is_active, excluded.is_active),
         first_seen_at = min(group_members.first_seen_at, excluded.first_seen_at),
         updated_at = max(group_members.updated_at, excluded.updated_at)`,
    ).run({
      accountId,
      old: old.canonical_jid,
      canonical: canonical.canonical_jid,
    });
    db.prepare(
      "delete from group_members where account_id = ? and participant_jid = ?",
    ).run(accountId, old.canonical_jid);
    db.prepare("delete from participants where account_id = ? and jid = ?").run(
      accountId,
      old.canonical_jid,
    );
  } else if (oldParticipant) {
    db.prepare(
      `insert into participants (
         account_id, jid, lid, phone, display_name, push_name, verified_name,
         first_seen_at, updated_at, raw_json
       ) select account_id, @canonical, lid, phone, display_name, push_name,
                verified_name, first_seen_at, updated_at, raw_json
         from participants where account_id = @accountId and jid = @old
       on conflict (account_id, jid) do nothing`,
    ).run({
      accountId,
      old: old.canonical_jid,
      canonical: canonical.canonical_jid,
    });
    db.prepare(
      `insert into group_members (
         account_id, group_jid, participant_jid, role, is_active,
         first_seen_at, updated_at
       ) select account_id, group_jid, @canonical, role, is_active,
                first_seen_at, updated_at
         from group_members
         where account_id = @accountId and participant_jid = @old
       on conflict (account_id, group_jid, participant_jid) do update set
         role = coalesce(group_members.role, excluded.role),
         is_active = max(group_members.is_active, excluded.is_active),
         first_seen_at = min(group_members.first_seen_at, excluded.first_seen_at),
         updated_at = max(group_members.updated_at, excluded.updated_at)`,
    ).run({
      accountId,
      old: old.canonical_jid,
      canonical: canonical.canonical_jid,
    });
    db.prepare(
      "delete from group_members where account_id = ? and participant_jid = ?",
    ).run(accountId, old.canonical_jid);
    db.prepare("delete from participants where account_id = ? and jid = ?").run(
      accountId,
      old.canonical_jid,
    );
  }
  db.prepare(
    `delete from directory_aliases
     where account_id = @accountId and entity_id = @oldId`,
  ).run({ accountId, oldId });
  db.prepare("delete from directory_entities where id = ?").run(oldId);
}

function projectContact(
  db: Database,
  accountId: string,
  entityId: number,
  inputPhone: string | null | undefined,
  inputLid: string | null,
  now: number,
): void {
  const entity = getEntityById(db, entityId);
  if (!entity) return;
  const aliases = db
    .prepare<[string, number], { alias_jid: string }>(
      "select alias_jid from directory_aliases where account_id = ? and entity_id = ?",
    )
    .all(accountId, entityId)
    .map((row) => row.alias_jid);
  const lid =
    inputLid ?? aliases.find((alias) => alias.endsWith("@lid")) ?? null;
  const phone = inputPhone ?? phoneFromJid(entity.canonical_jid) ?? null;
  db.prepare(
    `insert into participants (
       account_id, jid, lid, phone, display_name, push_name, verified_name,
       first_seen_at, updated_at, raw_json
     ) values (@accountId, @jid, @lid, @phone, @displayName, @pushName,
               @verifiedName, @firstSeenAt, @now, @rawJson)
     on conflict (account_id, jid) do update set
       lid = coalesce(excluded.lid, participants.lid),
       phone = coalesce(excluded.phone, participants.phone),
       display_name = coalesce(excluded.display_name, participants.display_name),
       push_name = coalesce(excluded.push_name, participants.push_name),
       verified_name = coalesce(excluded.verified_name, participants.verified_name),
       raw_json = coalesce(excluded.raw_json, participants.raw_json),
       first_seen_at = min(first_seen_at, excluded.first_seen_at),
       updated_at = excluded.updated_at`,
  ).run({
    accountId,
    jid: entity.canonical_jid,
    lid,
    phone,
    displayName: entity.display_name,
    pushName: entity.push_name,
    verifiedName: entity.verified_name,
    firstSeenAt: entity.first_seen_at,
    now,
    rawJson: entity.raw_json,
  });
  for (const alias of aliases) {
    db.prepare(
      `insert into participant_aliases (
         account_id, alias_jid, canonical_jid, first_seen_at, updated_at
       ) values (@accountId, @aliasJid, @canonicalJid, @now, @now)
       on conflict (account_id, alias_jid) do update set
         canonical_jid = excluded.canonical_jid,
         updated_at = excluded.updated_at`,
    ).run({
      accountId,
      aliasJid: alias,
      canonicalJid: entity.canonical_jid,
      now,
    });
  }
  db.prepare(
    `update chats set name = coalesce(nullif(trim(name), ''), @name),
       push_name = coalesce(push_name, @pushName), updated_at = @now
     where account_id = @accountId and is_group = 0
       and jid in (select alias_jid from directory_aliases
                   where account_id = @accountId and entity_id = @entityId)`,
  ).run({
    accountId,
    entityId,
    name: entity.name,
    pushName: entity.push_name,
    now,
  });
}

function projectGroup(
  db: Database,
  accountId: string,
  entityId: number,
  now: number,
): void {
  const entity = getEntityById(db, entityId);
  if (!entity) return;
  db.prepare(
    `insert into chats (
       account_id, jid, name, is_group, is_status, discovered_at, updated_at,
       raw_json
     ) values (@accountId, @jid, @name, 1, 0, @now, @now, @rawJson)
     on conflict (account_id, jid) do update set
       name = coalesce(nullif(trim(excluded.name), ''), chats.name),
       is_group = 1,
       raw_json = coalesce(excluded.raw_json, chats.raw_json),
       updated_at = excluded.updated_at`,
  ).run({
    accountId,
    jid: entity.canonical_jid,
    name: entity.name,
    now,
    rawJson: entity.raw_json,
  });
}

function projectGroupMember(
  db: Database,
  accountId: string,
  groupId: number,
  memberId: number,
  now: number,
): void {
  const group = getEntityById(db, groupId);
  const member = getEntityById(db, memberId);
  if (!group || !member) return;
  const row = db
    .prepare<
      [string, number, number],
      { role: DirectoryMemberRole | null; is_active: number }
    >(
      `select role, is_active from directory_group_members
       where account_id = ? and group_entity_id = ? and member_entity_id = ?`,
    )
    .get(accountId, groupId, memberId);
  if (!row) return;
  db.prepare(
    `insert into group_members (
       account_id, group_jid, participant_jid, role, is_active,
       first_seen_at, updated_at
     ) values (@accountId, @groupJid, @memberJid, @role, @isActive,
               @now, @now)
     on conflict (account_id, group_jid, participant_jid) do update set
       role = coalesce(excluded.role, group_members.role),
       is_active = excluded.is_active,
       updated_at = excluded.updated_at`,
  ).run({
    accountId,
    groupJid: group.canonical_jid,
    memberJid: member.canonical_jid,
    role: row.role,
    isActive: row.is_active,
    now,
  });
}
