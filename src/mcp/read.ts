import { existsSync } from "node:fs";
import { toExportRecord, type ExportConfig } from "../commands/export.js";
import type {
  AttachmentRow,
  ChatRow,
  GroupMemberRow,
  MessageRow,
  ParticipantRow,
} from "../db/queries.js";
import {
  directoryTablesAvailable,
  getDirectoryEntityByJid,
  listDirectoryAliases,
  listDirectoryGroupMembers,
  type DirectoryEntityRow,
} from "../db/directory.js";
import {
  countAllowedChats,
  countChats,
  countMessages,
  getAccount,
  latestMessageTimestamp,
  selectExportMessages,
} from "../db/queries.js";
import { loadRedactionSalt } from "../privacy/redact.js";
import {
  allowedChat,
  messageView,
  transcriptFor,
  type MessageFilters,
  type MessageView,
} from "../read/messages.js";
import { nowSec } from "../util/time.js";

export { listMessages } from "../read/messages.js";
import {
  assertLimit,
  assertWindow,
  decodeCursor,
  encodeCursor,
  hasTable,
  hasVirtualTable,
  type McpContext,
  type Page,
  McpRequestError,
  page,
} from "./types.js";

interface ChatView {
  jid: string;
  name: string | null;
  label: string;
  pushName: string | null;
  isGroup: boolean;
  isStatus: boolean;
  lastMessageTs: number | null;
  hasAudio: boolean;
}

function chatView(
  row: ChatRow,
  hasAudio: boolean,
  entity?: DirectoryEntityRow,
): ChatView {
  return {
    jid: row.jid,
    name: row.name ?? entity?.name ?? row.push_name ?? row.jid,
    label: row.name ?? entity?.name ?? row.push_name ?? row.jid,
    pushName: entity?.push_name ?? row.push_name,
    isGroup: row.is_group === 1,
    isStatus: row.is_status === 1,
    lastMessageTs: row.last_message_ts,
    hasAudio,
  };
}

export function listChats(
  ctx: McpContext,
  limitInput?: number,
  cursorInput?: string,
): Page<ChatView> {
  const limit = assertLimit(limitInput);
  const cursor = decodeCursor<{ ts: number; jid: string }>(cursorInput);
  const rows = ctx.db
    .prepare<
      [string, number | null, number | null, number | null, string, number],
      ChatRow & { has_audio: number }
    >(
      `select c.*,
         exists(select 1 from messages m
          where m.account_id = c.account_id and m.chat_jid = c.jid
            and m.message_type = 'audio') as has_audio
       from chats c
       where c.account_id = ? and c.is_allowed = 1 and c.is_blocked = 0
         and (? is null or
           coalesce(c.last_message_ts, 0) < ? or
           (coalesce(c.last_message_ts, 0) = ? and c.jid > ?))
       order by coalesce(c.last_message_ts, 0) desc, c.jid asc
       limit ?`,
    )
    .all(
      ctx.accountId,
      cursor ? cursor.ts : null,
      cursor ? cursor.ts : null,
      cursor ? cursor.ts : null,
      cursor?.jid ?? "",
      limit + 1,
    );
  const last = rows[limit - 1];
  return page(
    rows.map((row) =>
      chatView(
        row,
        row.has_audio === 1,
        directoryTablesAvailable(ctx.db)
          ? getDirectoryEntityByJid(ctx.db, ctx.accountId, row.jid)
          : undefined,
      ),
    ),
    limit,
    last
      ? encodeCursor({ ts: last.last_message_ts ?? 0, jid: last.jid })
      : null,
  );
}

export function searchContacts(
  ctx: McpContext,
  query: string,
  limitInput?: number,
): ParticipantRow[] {
  const limit = assertLimit(limitInput);
  if (query.trim().length < 2) throw new McpRequestError("query is too short");
  if (directoryTablesAvailable(ctx.db)) {
    const like = `%${query}%`;
    return ctx.db
      .prepare<
        [string, string, string, string, string, string, string, number],
        ParticipantRow
      >(
        `select distinct p.* from directory_entities e
         left join participants p on p.account_id = e.account_id and p.jid = e.canonical_jid
         where e.account_id = ? and e.entity_type = 'contact'
           and (exists (
             select 1 from messages m
             join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
             where m.account_id = e.account_id and c.is_allowed = 1 and c.is_blocked = 0
               and (m.sender_jid = e.canonical_jid or m.quoted_sender_jid = e.canonical_jid)
           ) or exists (
             select 1 from directory_group_members gm
             join directory_entities g on g.id = gm.group_entity_id
             join chats gc on gc.account_id = g.account_id and gc.jid = g.canonical_jid
             where gm.account_id = e.account_id and gm.member_entity_id = e.id
               and gm.is_active = 1 and gc.is_allowed = 1 and gc.is_blocked = 0
           ))
           and (lower(coalesce(e.canonical_jid, '')) like lower(?)
             or lower(coalesce(e.name, '')) like lower(?)
             or lower(coalesce(e.display_name, '')) like lower(?)
             or lower(coalesce(e.push_name, '')) like lower(?)
             or lower(coalesce(e.verified_name, '')) like lower(?)
             or exists (select 1 from directory_aliases a
                        where a.entity_id = e.id and lower(a.alias_jid) like lower(?)))
         order by coalesce(e.name, e.canonical_jid)
         limit ?`,
      )
      .all(ctx.accountId, like, like, like, like, like, like, limit);
  }
  return ctx.db
    .prepare<
      [string, string, string, string, string, string, number],
      ParticipantRow
    >(
      `select distinct p.* from participants p
       where p.account_id = ?
         and (exists (
           select 1 from messages m
           join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
           where m.account_id = p.account_id
             and c.is_allowed = 1 and c.is_blocked = 0
           and (m.sender_jid = p.jid or m.quoted_sender_jid = p.jid)
           )
         or exists (
           select 1 from group_members gm
           join chats gc on gc.account_id = gm.account_id
             and gc.jid = gm.group_jid
           where gm.account_id = p.account_id
             and gm.participant_jid = p.jid
             and gm.is_active = 1
             and gc.is_allowed = 1 and gc.is_blocked = 0
          ))
          and (lower(coalesce(p.jid, '')) like lower(?)
            or lower(coalesce(p.lid, '')) like lower(?)
            or lower(coalesce(p.display_name, '')) like lower(?)
            or lower(coalesce(p.push_name, '')) like lower(?)
            or lower(coalesce(p.verified_name, '')) like lower(?))
       order by coalesce(p.display_name, p.push_name, p.jid)
       limit ?`,
    )
    .all(
      ctx.accountId,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      limit,
    );
}

export function listGroupParticipants(
  ctx: McpContext,
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
        display_name: member.display_name ?? member.name,
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
       order by coalesce(display_name, push_name, jid)
       limit ?`,
    )
    .all(ctx.accountId, chat.jid, chat.jid, ctx.accountId, chat.jid, limit);
}

export function messageContext(
  ctx: McpContext,
  chatJid: string,
  messageId: string,
  before: number,
  after: number,
): { before: MessageView[]; message: MessageView; after: MessageView[] } {
  allowedChat(ctx, chatJid);
  const center = ctx.db
    .prepare<
      [string, string, string],
      MessageRow & { rowid: number }
    >("select m.*, m.rowid as rowid from messages m where m.account_id = ? and m.chat_jid = ? and m.message_id = ?")
    .get(ctx.accountId, chatJid, messageId);
  if (!center) throw new McpRequestError("message not found");
  const beforeRows = ctx.db
    .prepare<[string, string, number, number], MessageRow & { rowid: number }>(
      `select m.*, m.rowid as rowid from messages m
       join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
       where m.account_id = ? and m.chat_jid = ? and c.is_allowed = 1
         and m.rowid < ? order by m.rowid desc limit ?`,
    )
    .all(ctx.accountId, chatJid, center.rowid, assertWindow(before));
  const afterRows = ctx.db
    .prepare<[string, string, number, number], MessageRow & { rowid: number }>(
      `select m.*, m.rowid as rowid from messages m
       join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
       where m.account_id = ? and m.chat_jid = ? and c.is_allowed = 1
         and m.rowid > ? order by m.rowid asc limit ?`,
    )
    .all(ctx.accountId, chatJid, center.rowid, assertWindow(after));
  return {
    before: beforeRows
      .reverse()
      .map((row) =>
        messageView(ctx, row, transcriptFor(ctx, row.chat_jid, row.message_id)),
      ),
    message: messageView(
      ctx,
      center,
      transcriptFor(ctx, center.chat_jid, center.message_id),
    ),
    after: afterRows.map((row) =>
      messageView(ctx, row, transcriptFor(ctx, row.chat_jid, row.message_id)),
    ),
  };
}

function ftsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) throw new McpRequestError("query is required");
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
}

export function searchMessages(
  ctx: McpContext,
  query: string,
  filters: MessageFilters = {},
): Page<MessageView & { matchedTranscript: boolean }> {
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
  const where = [
    "m.account_id = @accountId",
    "c.is_allowed = 1",
    "c.is_blocked = 0",
    "(messages_fts match @query" +
      (hasTranscriptions
        ? " or lower(coalesce(t.text_raw, '')) like lower(@like) or lower(coalesce(t.text_corrected, '')) like lower(@like)"
        : "") +
      ")",
  ];
  const params: Record<string, unknown> = {
    query: ftsQuery(query),
    like: `%${query}%`,
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
  const joinTranscriptions = hasTranscriptions
    ? "left join transcriptions t on t.account_id = m.account_id and t.chat_jid = m.chat_jid and t.message_id = m.message_id"
    : "";
  const rows = ctx.db
    .prepare(
      `select m.*, m.rowid as rowid,
          ${hasTranscriptions ? "(lower(coalesce(t.text_raw, '')) like lower(@like) or lower(coalesce(t.text_corrected, '')) like lower(@like))" : "0"} as matched_transcript
       from messages_fts
       join messages m on m.rowid = messages_fts.rowid
       join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
       ${joinTranscriptions}
       where ${where.join(" and ")}
       order by m.rowid desc limit @limit`,
    )
    .all({ ...params, accountId: ctx.accountId, limit: limit + 1 }) as Array<
    MessageRow & { rowid: number; matched_transcript: number }
  >;
  const last = rows[limit - 1];
  return page(
    rows.map((row) => ({
      ...messageView(
        ctx,
        row,
        transcriptFor(ctx, row.chat_jid, row.message_id),
      ),
      matchedTranscript: row.matched_transcript === 1,
    })),
    limit,
    last ? encodeCursor({ rowid: last.rowid }) : null,
  );
}

export function getMedia(
  ctx: McpContext,
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
  return {
    chatJid,
    messageId,
    status: row.some((item) => item.file_path && existsSync(item.file_path))
      ? "available"
      : "metadata-only",
    downloadTriggered: false,
    attachments: row.map((item) => ({
      mediaType: item.media_type,
      mimeType: item.mime_type,
      fileName: item.file_name,
      sha256: item.sha256,
      sizeBytes: item.size_bytes,
      downloadedAt: item.downloaded_at,
      available: Boolean(item.file_path && existsSync(item.file_path)),
      ...(item.file_path && existsSync(item.file_path)
        ? { filePath: item.file_path }
        : {}),
    })),
  };
}

export function getTranscript(
  ctx: McpContext,
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
  ctx: McpContext,
  chatJid: string,
): Record<string, unknown> {
  const chat = allowedChat(ctx, chatJid);
  const row =
    ctx.db
      .prepare<[string, string], Record<string, number | null>>(
        `select count(*) as messages,
          sum(case when message_type = 'audio' then 1 else 0 end) as audio,
          sum(case when has_media = 1 then 1 else 0 end) as media,
          min(timestamp) as first_message_ts,
          max(timestamp) as last_message_ts
       from messages where account_id = ? and chat_jid = ?`,
      )
      .get(ctx.accountId, chat.jid) ?? {};
  return {
    chatJid: chat.jid,
    name: chat.name,
    isGroup: chat.is_group === 1,
    messages: row.messages ?? 0,
    audio: row.audio ?? 0,
    media: row.media ?? 0,
    firstMessageTs: row.first_message_ts,
    lastMessageTs: row.last_message_ts,
  };
}

export function health(ctx: McpContext): Record<string, unknown> {
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

export function exportMessages(
  ctx: McpContext,
  filters: { after?: number; before?: number; limit?: number; cursor?: string },
): Page<Record<string, unknown>> {
  const limit = assertLimit(filters.limit);
  const cursor = decodeCursor<{ rowid: number }>(filters.cursor);
  const rows = selectExportMessages(ctx.db, {
    accountId: ctx.accountId,
    sinceTs: filters.after,
    beforeTs: filters.before,
    afterRowid: cursor?.rowid ?? null,
    allowedOnly: true,
    allowedChats: ctx.config.filters.allowedChats,
    blockedChats: ctx.config.filters.blockedChats,
    limit: limit + 1,
  });
  const cfg: ExportConfig = {
    redactPhoneNumbers: ctx.config.exports.redactPhoneNumbers,
    includeRawJson: false,
    salt: ctx.config.exports.redactPhoneNumbers
      ? loadRedactionSalt(ctx.config.paths.dataDir)
      : "",
  };
  const items = rows.map(
    (row) => toExportRecord(row, cfg) as unknown as Record<string, unknown>,
  );
  const last = rows[limit - 1];
  return page(
    items,
    limit,
    last ? encodeCursor({ rowid: last.export_rowid }) : null,
  );
}

export function databaseAccount(ctx: McpContext): void {
  if (!getAccount(ctx.db, ctx.accountId)) {
    throw new McpRequestError("account is not available");
  }
}
