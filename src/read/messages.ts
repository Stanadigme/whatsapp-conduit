import type { Database } from "better-sqlite3";
import {
  directoryDisplayName,
  directoryTablesAvailable,
  getDirectoryEntityByJid,
  listEquivalentJids,
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
  chat?: string | undefined;
  sender?: string | undefined;
  fromMe?: boolean | undefined;
  kind?: string | undefined;
  hasMedia?: boolean | undefined;
  ingestionSource?: string | undefined;
  after?: number | undefined;
  before?: number | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export function allowedChat(ctx: MessageReadContext, chatJid: string): ChatRow {
  return allowedChatWithAliases(ctx, chatJid).row;
}

/**
 * Same guard as `allowedChat`, returning the alias expansion it already had to
 * compute. Callers that filter messages by chat need those aliases too, and
 * resolving them twice was two wasted queries per page.
 */
function allowedChatWithAliases(
  ctx: MessageReadContext,
  chatJid: string,
): { row: ChatRow; aliases: string[] } {
  const row = ctx.db
    .prepare<[string, string], ChatRow>(
      `select * from chats
       where account_id = ? and jid = ?`,
    )
    .get(ctx.accountId, chatJid);
  if (!row) throw new McpRequestError("chat is not available");
  const aliases = listEquivalentJids(ctx.db, ctx.accountId, chatJid);
  const placeholders = aliases.map((_, index) => `@alias${index}`);
  const policy = ctx.db
    .prepare(
      `select max(is_allowed) as allowed, max(is_blocked) as blocked
       from chats where account_id = @accountId
       and jid in (${placeholders.join(", ")})`,
    )
    .get({
      accountId: ctx.accountId,
      ...Object.fromEntries(
        aliases.map((alias, index) => [`alias${index}`, alias]),
      ),
    }) as { allowed: number | null; blocked: number | null };
  if (policy.allowed !== 1 || policy.blocked === 1) {
    throw new McpRequestError("chat is not available");
  }
  return { row, aliases };
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
    const name = directoryDisplayName(entity);
    if (name) return name;
  }
  const participant = ctx.db
    .prepare<
      [string, string],
      {
        display_name: string | null;
        verified_name: string | null;
        push_name: string | null;
      }
    >(
      `select display_name, verified_name, push_name from participants
       where account_id = ? and jid = ?`,
    )
    .get(ctx.accountId, senderJid);
  return (
    participant?.display_name ||
    participant?.verified_name ||
    participant?.push_name ||
    null
  );
}

/**
 * The projection itself, with the sender name already resolved. Both the
 * per-row path (`messageView`) and the joined path (`resolvedMessageView`) go
 * through here so a page and a single message can never diverge.
 */
function buildMessageView(
  row: MessageRow,
  senderName: string | null,
  transcript?: Pick<TranscriptRow, "text_raw" | "text_corrected"> | null,
): MessageView {
  return {
    chatJid: row.chat_jid,
    messageId: row.message_id,
    senderJid: row.sender_jid,
    senderName,
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

export function messageView(
  ctx: MessageReadContext,
  row: MessageRow,
  transcript?: TranscriptRow | null,
): MessageView {
  return buildMessageView(
    row,
    participantName(ctx, row.sender_jid),
    transcript,
  );
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

/**
 * Sender name and transcript resolved in SQL rather than per row.
 *
 * Resolving them in JavaScript cost three to five queries per message, which
 * SQLite hid but a remote database would not. The joins reproduce
 * `participantName` exactly: canonical directory entity first, alias second —
 * the same canonical-over-alias precedence `listDashboardChats` uses — then the
 * `participants` fallback, which only applies when no entity matched at all
 * (an entity always yields at least its canonical JID via
 * `directoryDisplayName`).
 *
 * Every join must stay a LEFT JOIN: an inner join would silently drop messages
 * whose sender has no directory entry.
 */
function resolvedMessageJoins(db: Database): {
  joins: string;
  senderName: string;
} {
  const directory = directoryTablesAvailable(db);
  const entityName = (alias: string): string =>
    `nullif(trim(${alias}.display_name), ''), nullif(trim(${alias}.verified_name), ''), ` +
    `nullif(trim(${alias}.push_name), ''), nullif(trim(${alias}.name), ''), ` +
    `nullif(trim(${alias}.canonical_jid), '')`;
  const directoryJoins = directory
    ? `left join directory_entities ec
              on ec.account_id = m.account_id and ec.canonical_jid = m.sender_jid
             and ec.entity_type = 'contact'
       left join directory_aliases da
              on da.account_id = m.account_id and da.alias_jid = m.sender_jid
       left join directory_entities ea
              on ea.id = da.entity_id and ea.entity_type = 'contact'`
    : "";
  // `participants` is only consulted when neither directory entity matched,
  // mirroring the JavaScript fallback order.
  const participantName =
    "coalesce(nullif(p.display_name, ''), nullif(p.verified_name, ''), " +
    "nullif(p.push_name, ''))";
  const senderName = directory
    ? `coalesce(${entityName("ec")}, ${entityName("ea")}, ${participantName})`
    : participantName;
  return {
    joins: `${directoryJoins}
       left join participants p
              on p.account_id = m.account_id and p.jid = m.sender_jid`,
    senderName,
  };
}

/** Columns of the transcript join, in the shape `messageView` consumes. */
const TRANSCRIPT_COLUMNS =
  "t.text_raw as transcript_text_raw, t.text_corrected as transcript_text_corrected";

const TRANSCRIPT_JOIN = `left join transcriptions t
              on t.account_id = m.account_id and t.chat_jid = m.chat_jid
             and t.message_id = m.message_id`;

/** A message row carrying its sender name and transcript already resolved. */
export type ResolvedMessageRow = MessageRow & {
  rowid: number;
  sender_name: string | null;
  transcript_text_raw: string | null;
  transcript_text_corrected: string | null;
};

export function messageRows(
  ctx: MessageReadContext,
  where: string,
  params: Record<string, unknown>,
  limit: number,
  order: "asc" | "desc" = "desc",
  extraSelect = "",
): ResolvedMessageRow[] {
  const { joins, senderName } = resolvedMessageJoins(ctx.db);
  const transcripts = hasTable(ctx.db, "transcriptions");
  return ctx.db
    .prepare(
      `select m.*, m.rowid as rowid,
              ${senderName} as sender_name,
              ${transcripts ? TRANSCRIPT_COLUMNS : "null as transcript_text_raw, null as transcript_text_corrected"}
              ${extraSelect ? `, ${extraSelect}` : ""}
       from messages m
       join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
       ${joins}
       ${transcripts ? TRANSCRIPT_JOIN : ""}
       ${where} order by m.rowid ${order === "asc" ? "asc" : "desc"} limit @limit`,
    )
    .all({
      ...params,
      accountId: ctx.accountId,
      limit,
    }) as ResolvedMessageRow[];
}

/** Build a view from a row whose sender name and transcript are already joined. */
export function resolvedMessageView(row: ResolvedMessageRow): MessageView {
  return buildMessageView(row, row.sender_name, {
    text_raw: row.transcript_text_raw,
    text_corrected: row.transcript_text_corrected,
  });
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
  const where = ["m.account_id = @accountId"];
  const params: Record<string, unknown> = {};
  if (filters.chat) {
    const { aliases } = allowedChatWithAliases(ctx, filters.chat);
    const placeholders = aliases.map((_, index) => `@chat${index}`);
    where.push(`m.chat_jid in (${placeholders.join(", ")})`);
    aliases.forEach((alias, index) => {
      params[`chat${index}`] = alias;
    });
  } else {
    where.push("c.is_allowed = 1", "c.is_blocked = 0");
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
    rows.map(resolvedMessageView),
    limit,
    last ? encodeCursor({ rowid: last.rowid }) : null,
  );
}
