import type { Database } from "better-sqlite3";
import type { Config } from "../config.js";
import { attachmentAvailable, fromAttachmentRow } from "../db/media-serving.js";
import type {
  AttachmentRow,
  ChatRow,
  GroupMemberRow,
  MessageRow,
  ParticipantRow,
} from "../db/queries.js";
import {
  buildExposureSqlFragment,
  directoryDisplayName,
  directoryTablesAvailable,
  exposureScopeFromConfig,
  getDirectoryEntityByJid,
  listDirectoryAliases,
  listDirectoryGroupMembers,
  listEquivalentJids,
  type DirectoryEntityRow,
} from "../db/directory.js";
import {
  countAllowedChats,
  countChats,
  countMessages,
  getAccount,
  latestMessageTimestamp,
} from "../db/queries.js";
import type { RuntimeStatus } from "../runtime-status.js";
import {
  allowedChat,
  mcpMessageView,
  messageRows,
  messageView,
  resolvedMessageView,
  type ResolvedMessageRow,
  transcriptFor,
  type MessageFilters,
  type McpMessageView,
} from "../read/messages.js";
import { nowSec } from "../util/time.js";
import {
  assertLimit,
  assertWindow,
  decodeCursor,
  encodeCursor,
  hasTable,
  hasVirtualTable,
  McpRequestError,
  page,
  type Page,
} from "./types.js";

/**
 * Context for this file's functions only — direct SQLite access. Used
 * exclusively by db/sqlite-reader.ts to implement ClientDataReader; the
 * running MCP server never sees this type (see mcp/types.ts's McpContext).
 */
export interface SqliteMcpContext {
  db: Database;
  config: Config;
  accountId: string;
  runtimeStatus: RuntimeStatus | null;
}

export interface ChatView {
  jid: string;
  name: string | null;
  label: string;
  pushName: string | null;
  isGroup: boolean;
  isStatus: boolean;
  lastMessageTs: number | null;
  hasAudio: boolean;
}

export interface ChatListFilters {
  limit?: number;
  cursor?: string;
  query?: string;
  kind?: "contact" | "group" | "status";
  hasAudio?: boolean;
}

function chatView(
  row: ChatRow,
  hasAudio: boolean,
  entity?: DirectoryEntityRow,
): ChatView {
  return {
    jid: row.jid,
    name: directoryDisplayName(entity) || row.name || row.push_name || row.jid,
    label: directoryDisplayName(entity) || row.name || row.push_name || row.jid,
    pushName: entity?.push_name ?? row.push_name,
    isGroup: row.is_group === 1,
    isStatus: row.is_status === 1,
    lastMessageTs: row.last_message_ts,
    hasAudio,
  };
}

export function listChats(
  ctx: SqliteMcpContext,
  filters: ChatListFilters = {},
): Page<ChatView> {
  const limit = assertLimit(filters.limit);
  const cursor = decodeCursor<{ ts: number; jid: string }>(filters.cursor);
  const fragment = buildExposureSqlFragment(
    ctx.db,
    ctx.accountId,
    exposureScopeFromConfig(ctx.config),
  );
  const directory = directoryTablesAvailable(ctx.db);
  const joins = directory
    ? `left join directory_entities ec on ec.account_id = c.account_id and ec.canonical_jid = c.jid
       left join directory_aliases da on da.account_id = c.account_id and da.alias_jid = c.jid
       left join directory_entities ea on ea.id = da.entity_id`
    : "";
  const directoryName = directory
    ? `coalesce(nullif(trim(ec.display_name), ''), nullif(trim(ec.verified_name), ''),
        nullif(trim(ec.push_name), ''), nullif(trim(ec.name), ''), nullif(trim(ec.canonical_jid), ''),
        nullif(trim(ea.display_name), ''), nullif(trim(ea.verified_name), ''),
        nullif(trim(ea.push_name), ''), nullif(trim(ea.name), ''), nullif(trim(ea.canonical_jid), ''))`
    : "null";
  const directoryPushName = directory ? "coalesce(ec.push_name, ea.push_name)" : "null";
  const audio = `exists(select 1 from messages m
    where m.account_id = c.account_id and m.chat_jid = c.jid and m.message_type = 'audio')`;
  const where = ["c.account_id = @accountId", fragment.sql];
  if (filters.kind === "status") where.push("c.is_status = 1");
  else if (filters.kind === "group") where.push("c.is_group = 1 and c.is_status = 0");
  else if (filters.kind === "contact") where.push("c.is_group = 0 and c.is_status = 0");
  const query = filters.query?.trim().toLocaleLowerCase();
  if (query) {
    const columns = ["c.name", "c.push_name", "c.jid", directoryName, directoryPushName];
    where.push(`(${columns.map((column) => `lower_u(${column}) like @query`).join(" or ")})`);
  }

  // Same one-entity-per-conversation collapse as dashboard/chats.ts's
  // listDashboardChats (ST2, backlog/phases/2026-09-18-identite-unique-par-conversation.md):
  // a contact split across a LID and a phone-JID chat row must not surface
  // twice. Grouping runs inside the query, before the cursor comparison and
  // `limit`, so a page can never contain the same entity twice or drop it for
  // lack of room — `hasAudio` is filtered on the grouped, alias-summed value
  // for the same reason: either alias carrying a voice note makes it true for
  // the whole conversation.
  const groupKey = directory ? "coalesce(da.entity_id, c.jid)" : "c.jid";
  const isCanonical = directory
    ? "case when da.alias_type = 'canonical' then 1 else 0 end"
    : "1";
  const rows = ctx.db
    .prepare(
      `with visible as (
         select c.*,
                ${audio} as has_audio_row,
                ${groupKey} as group_key,
                ${isCanonical} as is_canonical
         from chats c
         ${joins}
         where ${where.join(" and ")}
       ),
       grouped as (
         select group_key,
                max(last_message_ts) as group_last_ts,
                max(has_audio_row) as group_has_audio
         from visible
         group by group_key
       ),
       ranked as (
         select v.*, row_number() over (
           partition by v.group_key
           order by v.is_canonical desc, coalesce(v.last_message_ts, 0) desc, v.jid asc
         ) as rn
         from visible v
       )
       select r.*, g.group_last_ts, g.group_has_audio
       from ranked r
       join grouped g on g.group_key = r.group_key
       where r.rn = 1
         and (@hasAudio is null or g.group_has_audio = @hasAudio)
         and (@cursorTs is null or
           coalesce(g.group_last_ts, 0) < @cursorTs or
           (coalesce(g.group_last_ts, 0) = @cursorTs and r.jid > @cursorJid))
       order by coalesce(g.group_last_ts, 0) desc, r.jid asc
       limit @limit`,
    )
    .all({
      accountId: ctx.accountId,
      cursorTs: cursor ? cursor.ts : null,
      cursorJid: cursor?.jid ?? "",
      hasAudio: filters.hasAudio === undefined ? null : filters.hasAudio ? 1 : 0,
      query: query ? `%${query}%` : "",
      limit: limit + 1,
      ...fragment.params,
    }) as Array<
      ChatRow & {
        group_key: string;
        is_canonical: number;
        group_last_ts: number | null;
        group_has_audio: number;
      }
    >;
  const last = rows[limit - 1];
  return page(
    rows.map((row) =>
      chatView(
        { ...row, last_message_ts: row.group_last_ts },
        row.group_has_audio === 1,
        directory
          ? getDirectoryEntityByJid(ctx.db, ctx.accountId, row.jid)
          : undefined,
      ),
    ),
    limit,
    last
      ? encodeCursor({ ts: last.group_last_ts ?? 0, jid: last.jid })
      : null,
  );
}

export function searchContacts(
  ctx: SqliteMcpContext,
  query: string,
  limitInput?: number,
): ParticipantRow[] {
  const limit = assertLimit(limitInput);
  if (query.trim().length < 2) throw new McpRequestError("query is too short");
  const scope = exposureScopeFromConfig(ctx.config);
  // Two exposure checks land in the same statement (the messages' chat under
  // `c`, the group membership's chat under `gc`); prefixed params keep their
  // bindings from colliding.
  const chatExposure = buildExposureSqlFragment(ctx.db, ctx.accountId, scope, "c", "chat_");
  const groupExposure = buildExposureSqlFragment(ctx.db, ctx.accountId, scope, "gc", "group_");
  if (directoryTablesAvailable(ctx.db)) {
    const like = `%${query}%`;
    return ctx.db
      .prepare(
        `select distinct p.* from directory_entities e
         left join participants p on p.account_id = e.account_id and p.jid = e.canonical_jid
         where e.account_id = @accountId and e.entity_type = 'contact'
           and (exists (
             select 1 from messages m
             join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
             where m.account_id = e.account_id and ${chatExposure.sql}
               and (m.sender_jid = e.canonical_jid or m.quoted_sender_jid = e.canonical_jid)
           ) or exists (
             select 1 from directory_group_members gm
             join directory_entities g on g.id = gm.group_entity_id
             join chats gc on gc.account_id = g.account_id and gc.jid = g.canonical_jid
             where gm.account_id = e.account_id and gm.member_entity_id = e.id
               and gm.is_active = 1 and ${groupExposure.sql}
           ))
           and (lower(coalesce(e.canonical_jid, '')) like lower(@like)
             or lower(coalesce(e.name, '')) like lower(@like)
             or lower(coalesce(e.display_name, '')) like lower(@like)
             or lower(coalesce(e.push_name, '')) like lower(@like)
             or lower(coalesce(e.verified_name, '')) like lower(@like)
             or exists (select 1 from directory_aliases a
                        where a.entity_id = e.id and lower(a.alias_jid) like lower(@like)))
         order by coalesce(e.display_name, e.verified_name, e.push_name,
                           e.name, e.canonical_jid)
         limit @limit`,
      )
      .all({
        accountId: ctx.accountId,
        like,
        limit,
        ...chatExposure.params,
        ...groupExposure.params,
      }) as ParticipantRow[];
  }
  return ctx.db
    .prepare(
      `select distinct p.* from participants p
       where p.account_id = @accountId
         and (exists (
           select 1 from messages m
           join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
           where m.account_id = p.account_id
             and ${chatExposure.sql}
           and (m.sender_jid = p.jid or m.quoted_sender_jid = p.jid)
           )
         or exists (
           select 1 from group_members gm
           join chats gc on gc.account_id = gm.account_id
             and gc.jid = gm.group_jid
           where gm.account_id = p.account_id
             and gm.participant_jid = p.jid
             and gm.is_active = 1
             and ${groupExposure.sql}
          ))
          and (lower(coalesce(p.jid, '')) like lower(@like)
            or lower(coalesce(p.lid, '')) like lower(@like)
            or lower(coalesce(p.display_name, '')) like lower(@like)
            or lower(coalesce(p.push_name, '')) like lower(@like)
            or lower(coalesce(p.verified_name, '')) like lower(@like))
       order by coalesce(p.display_name, p.verified_name, p.push_name, p.jid)
       limit @limit`,
    )
    .all({
      accountId: ctx.accountId,
      like: `%${query}%`,
      limit,
      ...chatExposure.params,
      ...groupExposure.params,
    }) as ParticipantRow[];
}

export function listGroupParticipants(
  ctx: SqliteMcpContext,
  chatJid: string,
  limitInput?: number,
): GroupMemberRow[] {
  const chat = allowedChat(ctx, chatJid);
  if (chat.is_group !== 1) throw new McpRequestError("chat is not a group");
  const limit = assertLimit(limitInput);
  if (directoryTablesAvailable(ctx.db)) {
    return listDirectoryGroupMembers(
      ctx.db,
      ctx.accountId,
      chat.jid,
      limit,
    ).map((member) => {
      const aliases = listDirectoryAliases(
        ctx.db,
        ctx.accountId,
        member.member_entity_id,
      );
      const projection = ctx.db
        .prepare<
          [string, string],
          Pick<ParticipantRow, "phone">
        >("select phone from participants where account_id = ? and jid = ?")
        .get(ctx.accountId, member.canonical_jid);
      return {
        account_id: ctx.accountId,
        jid: member.canonical_jid,
        lid:
          aliases.find((alias) => alias.alias_type === "lid")?.alias_jid ??
          null,
        phone: projection?.phone ?? null,
        display_name: directoryDisplayName(member),
        push_name: member.push_name,
        verified_name: member.verified_name,
        first_seen_at: member.first_seen_at,
        updated_at: member.updated_at,
        raw_json: member.raw_json,
        group_jid: chat.jid,
        role: member.role,
        is_active: member.is_active,
      } satisfies GroupMemberRow;
    });
  }
  return ctx.db
    .prepare<[string, string, string, string, string, number], GroupMemberRow>(
      `select * from (
         select p.*, gm.group_jid, gm.role, gm.is_active
         from group_members gm
         join participants p on p.account_id = gm.account_id
           and p.jid = gm.participant_jid
         where gm.account_id = ? and gm.group_jid = ? and gm.is_active = 1
         union all
         select p.*, ? as group_jid, null as role, 1 as is_active
         from participants p
         join messages m on m.account_id = p.account_id
           and (m.sender_jid = p.jid or m.quoted_sender_jid = p.jid)
         where m.account_id = ? and m.chat_jid = ?
           and not exists (
             select 1 from group_members gm2
             where gm2.account_id = p.account_id
               and gm2.group_jid = m.chat_jid
               and gm2.participant_jid = p.jid
               and gm2.is_active = 1
           )
       )
         order by coalesce(display_name, verified_name, push_name, jid)
       limit ?`,
    )
    .all(ctx.accountId, chat.jid, chat.jid, ctx.accountId, chat.jid, limit);
}

export function messageContext(
  ctx: SqliteMcpContext,
  chatJid: string,
  messageId: string,
  before: number,
  after: number,
): {
  before: McpMessageView[];
  message: McpMessageView;
  after: McpMessageView[];
} {
  allowedChat(ctx, chatJid);
  const center = ctx.db
    .prepare<
      [string, string, string],
      MessageRow & { rowid: number }
    >("select m.*, m.rowid as rowid from messages m where m.account_id = ? and m.chat_jid = ? and m.message_id = ?")
    .get(ctx.accountId, chatJid, messageId);
  if (!center) throw new McpRequestError("message not found");
  // `allowedChat` above already threw for a chat that is not exposed; this
  // fragment re-checks the same rule defensively rather than the bare DB
  // flags, so a future change to `allowedChat` cannot silently widen it here.
  const fragment = buildExposureSqlFragment(
    ctx.db,
    ctx.accountId,
    exposureScopeFromConfig(ctx.config),
  );
  const window = {
    chat: chatJid,
    center: center.rowid,
    ...fragment.params,
  };
  const beforeRows = messageRows(
    ctx,
    `where m.account_id = @accountId and m.chat_jid = @chat
       and ${fragment.sql} and m.rowid < @center`,
    window,
    assertWindow(before),
  );
  const afterRows = messageRows(
    ctx,
    `where m.account_id = @accountId and m.chat_jid = @chat
       and ${fragment.sql} and m.rowid > @center`,
    window,
    assertWindow(after),
    "asc",
  );
  return {
    before: beforeRows
      .reverse()
      .map((row) => mcpMessageView(resolvedMessageView(row))),
    message: mcpMessageView(
      messageView(
        ctx,
        center,
        transcriptFor(ctx, center.chat_jid, center.message_id),
      ),
    ),
    after: afterRows.map((row) => mcpMessageView(resolvedMessageView(row))),
  };
}

function ftsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) throw new McpRequestError("query is required");
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
}

export function searchMessages(
  ctx: SqliteMcpContext,
  query: string,
  filters: MessageFilters = {},
): Page<McpMessageView & { matchedTranscript: boolean }> {
  const limit = assertLimit(filters.limit);
  if (!hasVirtualTable(ctx.db, "messages_fts")) {
    throw new McpRequestError("message search is not available yet");
  }
  const hasTranscriptions = hasTable(ctx.db, "transcriptions");
  if (filters.kind && filters.hasMedia === true) {
    const mediaKinds = new Set([
      "image",
      "video",
      "audio",
      "document",
      "sticker",
    ]);
    if (!mediaKinds.has(filters.kind)) {
      throw new McpRequestError("kind and hasMedia filters are contradictory");
    }
  }
  const fragment = buildExposureSqlFragment(
    ctx.db,
    ctx.accountId,
    exposureScopeFromConfig(ctx.config),
  );
  const where = [
    "m.account_id = @accountId",
    fragment.sql,
    // The FTS constraint goes through a rowid subquery rather than a direct
    // `messages_fts match`: SQLite rejects MATCH inside an `or` ("unable to use
    // function MATCH in the requested context"), which is exactly the shape the
    // transcription branch needs.
    "(m.rowid in (select rowid from messages_fts where messages_fts match @query)" +
      (hasTranscriptions
        ? " or lower(coalesce(t.text_raw, '')) like lower(@like) or lower(coalesce(t.text_corrected, '')) like lower(@like)"
        : "") +
      ")",
  ];
  const params: Record<string, unknown> = {
    query: ftsQuery(query),
    like: `%${query}%`,
    ...fragment.params,
  };
  if (filters.chat) {
    allowedChat(ctx, filters.chat);
    where.push("m.chat_jid = @chat");
    params.chat = filters.chat;
  }
  if (filters.sender) {
    where.push("m.sender_jid = @sender");
    params.sender = filters.sender;
  }
  if (filters.fromMe !== undefined) {
    where.push("m.from_me = @fromMe");
    params.fromMe = filters.fromMe ? 1 : 0;
  }
  if (filters.kind) {
    where.push("m.message_type = @kind");
    params.kind = filters.kind;
  }
  if (filters.hasMedia !== undefined) {
    where.push("m.has_media = @hasMedia");
    params.hasMedia = filters.hasMedia ? 1 : 0;
  }
  if (filters.after !== undefined) {
    where.push("m.timestamp >= @after");
    params.after = filters.after;
  }
  if (filters.before !== undefined) {
    where.push("m.timestamp <= @before");
    params.before = filters.before;
  }
  const cursor = decodeCursor<{ rowid: number }>(filters.cursor);
  if (cursor) {
    where.push("m.rowid < @cursorRowid");
    params.cursorRowid = cursor.rowid;
  }
  const rows = messageRows(
    ctx,
    `where ${where.join(" and ")}`,
    params,
    limit + 1,
    "desc",
    `${hasTranscriptions ? "(lower(coalesce(t.text_raw, '')) like lower(@like) or lower(coalesce(t.text_corrected, '')) like lower(@like))" : "0"} as matched_transcript`,
  ) as Array<ResolvedMessageRow & { matched_transcript: number }>;
  const last = rows[limit - 1];
  return page(
    rows.map((row) => ({
      ...mcpMessageView(resolvedMessageView(row)),
      matchedTranscript: row.matched_transcript === 1,
    })),
    limit,
    last ? encodeCursor({ rowid: last.rowid }) : null,
  );
}

export function getMedia(
  ctx: SqliteMcpContext,
  chatJid: string,
  messageId: string,
): Record<string, unknown> {
  allowedChat(ctx, chatJid);
  const row = ctx.db
    .prepare<
      [string, string, string],
      AttachmentRow
    >("select * from attachments where account_id = ? and chat_jid = ? and message_id = ? order by attachment_index")
    .all(ctx.accountId, chatJid, messageId);
  if (row.length === 0) {
    const message = ctx.db
      .prepare<
        [string, string, string],
        Pick<MessageRow, "has_media" | "message_type">
      >("select has_media, message_type from messages where account_id = ? and chat_jid = ? and message_id = ?")
      .get(ctx.accountId, chatJid, messageId);
    if (!message) throw new McpRequestError("message not found");
    return {
      chatJid,
      messageId,
      mediaType: message.message_type,
      hasMedia: message.has_media === 1,
      status: message.has_media === 1 ? "metadata-only" : "none",
      downloadTriggered: false,
    };
  }
  const availability = row.map((item) =>
    attachmentAvailable(ctx.config, fromAttachmentRow(item)),
  );
  return {
    chatJid,
    messageId,
    status: availability.some(Boolean) ? "available" : "metadata-only",
    downloadTriggered: false,
    // Never a raw path or GCS object key: `available` is everything a
    // caller needs, and the runtime always proxies the bytes itself.
    attachments: row.map((item, index) => ({
      mediaType: item.media_type,
      mimeType: item.mime_type,
      fileName: item.file_name,
      sha256: item.sha256,
      sizeBytes: item.size_bytes,
      downloadedAt: item.downloaded_at,
      available: availability[index],
    })),
  };
}

export function getTranscript(
  ctx: SqliteMcpContext,
  chatJid: string,
  messageId: string,
): Record<string, unknown> {
  allowedChat(ctx, chatJid);
  const message = ctx.db
    .prepare<
      [string, string, string],
      MessageRow
    >("select * from messages where account_id = ? and chat_jid = ? and message_id = ?")
    .get(ctx.accountId, chatJid, messageId);
  if (!message) throw new McpRequestError("message not found");
  if (!hasTable(ctx.db, "transcriptions")) {
    return {
      chatJid,
      messageId,
      status: "unavailable",
      reason: "transcription service not installed",
    };
  }
  const transcript = transcriptFor(ctx, chatJid, messageId);
  if (transcript) {
    return { chatJid, messageId, status: "available", ...transcript };
  }
  if (hasTable(ctx.db, "transcription_jobs")) {
    const job = ctx.db
      .prepare<
        [string, string, string],
        { status: string; reason: string | null }
      >("select status, reason from transcription_jobs where account_id = ? and chat_jid = ? and message_id = ? order by id desc limit 1")
      .get(ctx.accountId, chatJid, messageId);
    if (job)
      return { chatJid, messageId, status: job.status, reason: job.reason };
  }
  return { chatJid, messageId, status: "pending" };
}

export function chatStats(
  ctx: SqliteMcpContext,
  chatJid: string,
): Record<string, unknown> {
  const chat = allowedChat(ctx, chatJid);
  const entity = directoryTablesAvailable(ctx.db)
    ? getDirectoryEntityByJid(ctx.db, ctx.accountId, chat.jid)
    : undefined;
  // One contact may hold messages under both its LID and phone JID
  // (history arrives under one, live traffic under the other): count them
  // together, as the dashboard's chatMessageStats already does.
  const aliases = listEquivalentJids(ctx.db, ctx.accountId, chat.jid);
  const row =
    ctx.db
      .prepare<string[], Record<string, number | null>>(
        `select count(*) as messages,
          sum(case when message_type = 'audio' then 1 else 0 end) as audio,
          sum(case when has_media = 1 then 1 else 0 end) as media,
          min(timestamp) as first_message_ts,
          max(timestamp) as last_message_ts
       from messages where account_id = ?
         and chat_jid in (${aliases.map(() => "?").join(", ")})`,
      )
      .get(ctx.accountId, ...aliases) ?? {};
  return {
    chatJid: chat.jid,
    name:
      directoryDisplayName(entity) || chat.name || chat.push_name || chat.jid,
    isGroup: chat.is_group === 1,
    messages: row.messages ?? 0,
    audio: row.audio ?? 0,
    media: row.media ?? 0,
    firstMessageTs: row.first_message_ts,
    lastMessageTs: row.last_message_ts,
  };
}

export function health(ctx: SqliteMcpContext): Record<string, unknown> {
  const account = getAccount(ctx.db, ctx.accountId);
  const schema =
    ctx.db
      .prepare<
        [],
        { name: string }
      >("select name from schema_migrations order by name desc limit 1")
      .get()?.name ?? null;
  const attachmentCount =
    ctx.db
      .prepare<[], { n: number }>("select count(*) as n from attachments")
      .get()?.n ?? 0;
  return {
    transport: ctx.runtimeStatus?.transport ?? ctx.config.transport,
    connection: ctx.runtimeStatus?.connection ?? "unknown",
    authLinked: ctx.runtimeStatus?.authLinked ?? Boolean(account?.self_jid),
    lastEventAt: ctx.runtimeStatus?.lastEventAt ?? null,
    lastEventAge:
      ctx.runtimeStatus?.lastEventAt === null ||
      ctx.runtimeStatus?.lastEventAt === undefined
        ? null
        : Math.max(0, nowSec() - ctx.runtimeStatus.lastEventAt),
    lastMessageAt: latestMessageTimestamp(ctx.db, ctx.accountId),
    account: account?.self_jid ?? null,
    chats: countChats(ctx.db, ctx.accountId),
    allowedChats: countAllowedChats(ctx.db, ctx.accountId),
    messages: countMessages(ctx.db, ctx.accountId),
    attachments: attachmentCount,
    schema,
    transcription: hasTable(ctx.db, "transcriptions")
      ? "available"
      : "unavailable",
  };
}
