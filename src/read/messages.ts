import type { Database } from "better-sqlite3";
import {
  directoryTablesAvailable,
  getDirectoryEntityByJid,
} from "../db/directory.js";
import type { ChatRow, MessageRow } from "../db/queries.js";
import {
  assertLimit,
  decodeCursor,
  encodeCursor,
  hasTable,
  type Page,
  McpRequestError,
  page,
} from "../mcp/types.js";

export interface MessageReadContext {
  db: Database;
  accountId: string;
}

export interface MessageView {
  chatJid: string;
  messageId: string;
  senderJid: string | null;
  senderName: string | null;
  fromMe: boolean;
  timestamp: number | null;
  receivedAt: number;
  messageType: string | null;
  text: string | null;
  textRaw: string | null;
  textCorrected: string | null;
  hasMedia: boolean;
  durationS: number | null;
  ingestionSource: string;
  quotedMessageId: string | null;
  quotedSenderJid: string | null;
  editedMessageId: string | null;
  deletedAt: number | null;
}

/** MCP-facing message shape: one effective transcript, never both variants. */
export type McpMessageView = Omit<MessageView, "textRaw">;

export function mcpMessageView(view: MessageView): McpMessageView {
  const { textRaw, textCorrected, ...rest } = view;
  return {
    ...rest,
    textCorrected:
      view.messageType === "audio" ? (textCorrected ?? textRaw) : textCorrected,
  };
}

export function getMessage(
  ctx: MessageReadContext,
  chatJid: string,
  messageId: string,
): MessageView {
  allowedChat(ctx, chatJid);
  const row = ctx.db
    .prepare<[string, string, string], MessageRow>(
      `select * from messages
       where account_id = ? and chat_jid = ? and message_id = ?`,
    )
    .get(ctx.accountId, chatJid, messageId);
  if (!row) throw new McpRequestError("message not found");
  return messageView(ctx, row, transcriptFor(ctx, chatJid, messageId));
}

export interface TranscriptRow {
  text_raw: string | null;
  text_corrected: string | null;
  language: string | null;
  confidence: number | null;
  engine: string | null;
  engine_model: string | null;
  lexicon_version: number | null;
  duration_s: number | null;
  transcribed_at: number | null;
  status?: string;
  reason?: string | null;
}

export interface MessageFilters {
  chat?: string;
  sender?: string;
  fromMe?: boolean;
  kind?: string;
  hasMedia?: boolean;
  ingestionSource?: string;
  after?: number;
  before?: number;
  limit?: number;
  cursor?: string;
}

export function allowedChat(ctx: MessageReadContext, chatJid: string): ChatRow {
  const row = ctx.db
    .prepare<[string, string], ChatRow>(
      `select * from chats
       where account_id = ? and jid = ? and is_allowed = 1 and is_blocked = 0`,
    )
    .get(ctx.accountId, chatJid);
  if (!row) throw new McpRequestError("chat is not available");
  return row;
}

function participantName(
  ctx: MessageReadContext,
  senderJid: string | null,
): string | null {
  if (!senderJid) return null;
  if (directoryTablesAvailable(ctx.db)) {
    const entity = getDirectoryEntityByJid(
      ctx.db,
      ctx.accountId,
      senderJid,
      "contact",
    );
    const name = entity?.name ?? entity?.display_name ?? entity?.push_name;
    if (name) return name;
  }
  const participant = ctx.db
    .prepare<
      [string, string],
      { display_name: string | null; push_name: string | null }
    >(
      `select display_name, push_name from participants
       where account_id = ? and jid = ?`,
    )
    .get(ctx.accountId, senderJid);
  return participant?.display_name ?? participant?.push_name ?? null;
}

export function messageView(
  ctx: MessageReadContext,
  row: MessageRow,
  transcript?: TranscriptRow | null,
): MessageView {
  return {
    chatJid: row.chat_jid,
    messageId: row.message_id,
    senderJid: row.sender_jid,
    senderName: participantName(ctx, row.sender_jid),
    fromMe: row.from_me === 1,
    timestamp: row.timestamp,
    receivedAt: row.received_at,
    messageType: row.message_type,
    text: row.text,
    textRaw: transcript?.text_raw ?? row.text,
    textCorrected: transcript?.text_corrected ?? null,
    hasMedia: row.has_media === 1,
    durationS: row.duration_s,
    ingestionSource: row.ingestion_source,
    quotedMessageId: row.quoted_message_id,
    quotedSenderJid: row.quoted_sender_jid,
    editedMessageId: row.edited_message_id,
    deletedAt: row.deleted_at,
  };
}

export function transcriptFor(
  ctx: MessageReadContext,
  chatJid: string,
  messageId: string,
): TranscriptRow | null {
  if (!hasTable(ctx.db, "transcriptions")) return null;
  return (
    ctx.db
      .prepare<[string, string, string], TranscriptRow>(
        `select text_raw, text_corrected, language, confidence, engine,
                engine_model, lexicon_version, duration_s, transcribed_at
         from transcriptions
         where account_id = ? and chat_jid = ? and message_id = ?`,
      )
      .get(ctx.accountId, chatJid, messageId) ?? null
  );
}

function messageRows(
  ctx: MessageReadContext,
  where: string,
  params: Record<string, unknown>,
  limit: number,
): Array<MessageRow & { rowid: number }> {
  return ctx.db
    .prepare(
      `select m.*, m.rowid as rowid from messages m
       join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
       ${where} order by m.rowid desc limit @limit`,
    )
    .all({ ...params, accountId: ctx.accountId, limit }) as Array<
    MessageRow & { rowid: number }
  >;
}

export function listMessages(
  ctx: MessageReadContext,
  filters: MessageFilters,
): Page<MessageView> {
  const limit = assertLimit(filters.limit);
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
  const cursor = decodeCursor<{ rowid: number }>(filters.cursor);
  const where = [
    "m.account_id = @accountId",
    "c.is_allowed = 1",
    "c.is_blocked = 0",
  ];
  const params: Record<string, unknown> = {};
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
  if (filters.ingestionSource) {
    where.push("m.ingestion_source = @ingestionSource");
    params.ingestionSource = filters.ingestionSource;
  }
  if (filters.after !== undefined) {
    where.push("m.timestamp >= @after");
    params.after = filters.after;
  }
  if (filters.before !== undefined) {
    where.push("m.timestamp <= @before");
    params.before = filters.before;
  }
  if (cursor) {
    where.push("m.rowid < @cursorRowid");
    params.cursorRowid = cursor.rowid;
  }
  const rows = messageRows(
    ctx,
    `where ${where.join(" and ")}`,
    params,
    limit + 1,
  );
  const last = rows[limit - 1];
  return page(
    rows.map((row) =>
      messageView(ctx, row, transcriptFor(ctx, row.chat_jid, row.message_id)),
    ),
    limit,
    last ? encodeCursor({ rowid: last.rowid }) : null,
  );
}
