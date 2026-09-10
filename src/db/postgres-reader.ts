import { relative, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import type { Pool } from "pg";
import { phoneFromJid } from "../baileys/jid.js";
import type { Config } from "../config.js";
import type { DashboardChat, DashboardChatFilter } from "../dashboard/chats.js";
import {
  contentAddressedMediaPath,
  type AudioExtensionInput,
} from "../ingest/audio.js";
import type { ChatView } from "../mcp/read.js";
import {
  McpRequestError,
  assertLimit,
  assertWindow,
  decodeCursor,
  encodeCursor,
  page,
} from "../mcp/types.js";
import { mcpMessageView, type MessageFilters, type MessageView } from "../read/messages.js";
import type {
  ChatRow,
  ConsumerOffsetRow,
  ExportRow,
  GroupMemberRow,
  HistoryJobRow,
  ParticipantRow,
} from "./queries.js";
import type { ClientDataReader, ExportSelection } from "./reader.js";

/** SQLite row shapes use 0/1 for booleans; Postgres gives real booleans. */
function bit(value: boolean | null | undefined): number {
  return value ? 1 : 0;
}

/**
 * Every chat/message join below resolves its directory name the same way:
 * one entity matched from the row's own jid (`ec`), one from an alias of it
 * (`ea`) — the same two-join, no-cross-table-OR shape as db/queries.ts's
 * selectExportMessages and dashboard/chats.ts's listDashboardChats, so index
 * usage matches. Every call site joins `directory_entities ec`/`ea` and
 * `directory_aliases da` itself; this only builds the coalesce expression.
 */
const DIRECTORY_NAME = (prefix: "ec" | "ea") =>
  `nullif(trim(${prefix}.display_name), ''), nullif(trim(${prefix}.verified_name), ''), ` +
  `nullif(trim(${prefix}.push_name), ''), nullif(trim(${prefix}.name), ''), ` +
  `nullif(trim(${prefix}.canonical_jid), '')`;

const DIRECTORY_NAME_COALESCE = `coalesce(${DIRECTORY_NAME("ec")}, ${DIRECTORY_NAME("ea")})`;

interface QueryablePool {
  query<T>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export function createPostgresReader(
  pool: Pool,
  config: Config,
  accountId: string,
): ClientDataReader {
  const p = pool as unknown as QueryablePool;

  async function one<T>(sql: string, values: unknown[]): Promise<T | undefined> {
    return (await p.query<T>(sql, values)).rows[0];
  }
  async function many<T>(sql: string, values: unknown[]): Promise<T[]> {
    return (await p.query<T>(sql, values)).rows;
  }

  async function getSchemaVersion(): Promise<string | null> {
    const schema = await one<{ name: string }>(
      "select name from schema_migrations order by name desc limit 1",
      [],
    );
    return schema?.name ?? null;
  }

  /** All known JIDs for one identity (canonical + every alias); [jid] if none. */
  async function equivalentJids(jid: string): Promise<string[]> {
    const rows = await many<{ alias_jid: string }>(
      `select alias_jid from directory_aliases
       where account_id = $1 and canonical_jid = (
         select canonical_jid from directory_aliases
         where account_id = $1 and alias_jid = $2 limit 1
       )`,
      [accountId, jid],
    );
    return rows.length > 0 ? rows.map((r) => r.alias_jid) : [jid];
  }

  async function requireAllowedChat(
    chatJid: string,
  ): Promise<{ row: PgChatRow; aliases: string[] }> {
    const row = await one<PgChatRow>(
      "select * from chats where account_id = $1 and jid = $2",
      [accountId, chatJid],
    );
    if (!row) throw new McpRequestError("chat is not available");
    const aliases = await equivalentJids(chatJid);
    const policy = await one<{ allowed: boolean | null; blocked: boolean | null }>(
      `select bool_or(is_allowed) as allowed, bool_or(is_blocked) as blocked
       from chats where account_id = $1 and jid = any($2::text[])`,
      [accountId, aliases],
    );
    if (!policy?.allowed || policy.blocked) {
      throw new McpRequestError("chat is not available");
    }
    return { row, aliases };
  }

  function toChatRow(row: PgChatRow): ChatRow {
    return {
      account_id: row.account_id,
      jid: row.jid,
      name: row.name,
      push_name: row.push_name,
      is_group: bit(row.is_group),
      is_status: bit(row.is_status),
      is_blocked: bit(row.is_blocked),
      is_allowed: bit(row.is_allowed),
      discovered_at: Number(row.discovered_at),
      updated_at: Number(row.updated_at),
      last_message_ts: row.last_message_ts === null ? null : Number(row.last_message_ts),
      raw_json: row.raw_json,
    };
  }

  function toDashboardChat(row: PgChatRow & { dir_name: string | null; dir_push_name: string | null }): DashboardChat {
    return {
      jid: row.jid,
      name: row.dir_name || row.name || row.push_name || row.jid,
      pushName: row.dir_push_name ?? row.push_name,
      kind: row.is_status ? "status" : row.is_group ? "group" : "contact",
      allowed: row.is_allowed,
      blocked: row.is_blocked,
      lastMessageTs: row.last_message_ts === null ? null : Number(row.last_message_ts),
      lastSyncedAt: null,
    };
  }

  function toMessageView(row: PgMessageRow): MessageView {
    const transcript = row.transcript_text_raw ?? row.transcript_text_corrected
      ? { text_raw: row.transcript_text_raw, text_corrected: row.transcript_text_corrected }
      : null;
    return {
      chatJid: row.chat_jid,
      messageId: row.message_id,
      senderJid: row.sender_jid,
      senderName: row.sender_name ?? null,
      fromMe: row.from_me,
      timestamp: row.timestamp === null ? null : Number(row.timestamp),
      receivedAt: Number(row.received_at),
      messageType: row.message_type,
      text: row.text,
      textRaw: transcript?.text_raw ?? row.text,
      textCorrected: transcript?.text_corrected ?? null,
      hasMedia: row.has_media,
      durationS: row.duration_s === null ? null : Number(row.duration_s),
      ingestionSource: row.ingestion_source,
      quotedMessageId: row.quoted_message_id,
      quotedSenderJid: row.quoted_sender_jid,
      editedMessageId: row.edited_message_id,
      deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    };
  }

  /** `extraSelect`, if given, must be additional `, expr as alias` column(s). */
  const messageSelectSql = (extraSelect = ""): string => `
    select m.*,
      ${DIRECTORY_NAME_COALESCE} as sender_name,
      t.text_raw as transcript_text_raw, t.text_corrected as transcript_text_corrected
      ${extraSelect}
    from messages m
    join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
    left join directory_entities ec
           on ec.account_id = m.account_id and ec.canonical_jid = m.sender_jid
    left join directory_aliases da
           on da.account_id = m.account_id and da.alias_jid = m.sender_jid
    left join directory_entities ea
           on ea.account_id = da.account_id and ea.canonical_jid = da.canonical_jid
    left join transcriptions t
           on t.account_id = m.account_id and t.chat_jid = m.chat_jid
          and t.message_id = m.message_id`;

  async function selectMessages(
    where: string,
    values: unknown[],
    limit: number,
    order: "asc" | "desc" = "desc",
  ): Promise<PgMessageRow[]> {
    return many<PgMessageRow>(
      `${messageSelectSql()} where ${where} order by m.id ${order} limit $${values.length + 1}`,
      [...values, limit],
    );
  }

  return {
    async health() {
      const counts = await one<{
        chats: string;
        allowed_chats: string;
        messages: string;
        attachments: string;
        last_message_at: string | null;
        self_jid: string | null;
      }>(
        `select
           (select count(*) from chats where account_id = $1) as chats,
           (select count(*) from chats where account_id = $1 and is_allowed) as allowed_chats,
           (select count(*) from messages where account_id = $1) as messages,
           (select count(*) from attachments where account_id = $1) as attachments,
           (select max(timestamp) from messages where account_id = $1) as last_message_at,
           (select self_jid from accounts where id = $1) as self_jid`,
        [accountId],
      );
      const schemaVersion = await getSchemaVersion();
      return {
        selfJid: counts?.self_jid ?? null,
        chats: Number(counts?.chats ?? 0),
        allowedChats: Number(counts?.allowed_chats ?? 0),
        messages: Number(counts?.messages ?? 0),
        attachments: Number(counts?.attachments ?? 0),
        lastMessageAt: counts?.last_message_at === null || counts?.last_message_at === undefined
          ? null
          : Number(counts.last_message_at),
        schemaVersion,
        // The transcriptions table is unconditional in the Postgres schema
        // (postgres-migrations/0002), unlike SQLite's optional migration.
        transcriptionAvailable: true,
      };
    },

    getSchemaVersion,

    async getChat(chatJid) {
      const row = await one<PgChatRow>(
        "select * from chats where account_id = $1 and jid = $2",
        [accountId, chatJid],
      );
      return row ? toChatRow(row) : undefined;
    },

    async listChats({ limit: limitInput, cursor: cursorInput }) {
      const limit = assertLimit(limitInput);
      const cursor = decodeCursor<{ ts: number; jid: string }>(cursorInput);
      const rows = await many<
        PgChatRow & { has_audio: boolean; dir_name: string | null; dir_push_name: string | null }
      >(
        `select c.*,
           exists(select 1 from messages m
             where m.account_id = c.account_id and m.chat_jid = c.jid
               and m.message_type = 'audio') as has_audio,
           ${DIRECTORY_NAME_COALESCE} as dir_name,
           coalesce(ec.push_name, ea.push_name) as dir_push_name
         from chats c
         left join directory_entities ec
                on ec.account_id = c.account_id and ec.canonical_jid = c.jid
         left join directory_aliases da
                on da.account_id = c.account_id and da.alias_jid = c.jid
         left join directory_entities ea
                on ea.account_id = da.account_id and ea.canonical_jid = da.canonical_jid
         where c.account_id = $1 and c.is_allowed and not c.is_blocked
           and ($2::bigint is null or
             coalesce(c.last_message_ts, 0) < $2 or
             (coalesce(c.last_message_ts, 0) = $2 and c.jid > $3))
         order by coalesce(c.last_message_ts, 0) desc, c.jid asc
         limit $4`,
        [accountId, cursor?.ts ?? null, cursor?.jid ?? "", limit + 1],
      );
      const last = rows[limit - 1];
      const items: ChatView[] = rows.map((row) => ({
        jid: row.jid,
        name: row.dir_name || row.name || row.push_name || row.jid,
        label: row.dir_name || row.name || row.push_name || row.jid,
        pushName: row.dir_push_name ?? row.push_name,
        isGroup: row.is_group,
        isStatus: row.is_status,
        lastMessageTs: row.last_message_ts === null ? null : Number(row.last_message_ts),
        hasAudio: row.has_audio,
      }));
      return page(
        items,
        limit,
        last ? encodeCursor({ ts: last.last_message_ts ?? 0, jid: last.jid }) : null,
      );
    },

    async listDashboardChats(filter: DashboardChatFilter = {}) {
      const where = ["c.account_id = $1"];
      if (filter.kind === "status") where.push("c.is_status");
      else if (filter.kind === "group") where.push("c.is_group and not c.is_status");
      else if (filter.kind === "contact") where.push("not c.is_group and not c.is_status");
      if (filter.policy === "allowed") where.push("c.is_allowed");
      else if (filter.policy === "blocked") where.push("c.is_blocked");
      else if (filter.policy === "discovered") where.push("not c.is_allowed and not c.is_blocked");

      const query = filter.query?.trim();
      const values: unknown[] = [accountId];
      if (query) {
        // One bound parameter, reused across every column: it is the same
        // pattern repeated, not five independent inputs.
        values.push(`%${query}%`);
        const term = `$${values.length}`;
        const like = (column: string): string =>
          `immutable_unaccent(lower(coalesce(${column}, ''))) like immutable_unaccent(lower(${term}))`;
        where.push(
          `(${like("c.name")} or ${like("c.push_name")} or ${like("c.jid")}` +
            ` or ${like(DIRECTORY_NAME_COALESCE)} or ${like("coalesce(ec.push_name, ea.push_name)")})`,
        );
      }
      const limit = Math.min(filter.limit ?? 200, 200);
      values.push(limit);
      const limitParam = `$${values.length}`;
      const rows = await many<
        PgChatRow & { dir_name: string | null; dir_push_name: string | null }
      >(
        `select c.*, ${DIRECTORY_NAME_COALESCE} as dir_name,
           coalesce(ec.push_name, ea.push_name) as dir_push_name
         from chats c
         left join directory_entities ec
                on ec.account_id = c.account_id and ec.canonical_jid = c.jid
         left join directory_aliases da
                on da.account_id = c.account_id and da.alias_jid = c.jid
         left join directory_entities ea
                on ea.account_id = da.account_id and ea.canonical_jid = da.canonical_jid
         where ${where.join(" and ")}
         order by coalesce(c.last_message_ts, 0) desc, c.jid asc
         limit ${limitParam}`,
        values,
      );
      return rows.map(toDashboardChat);
    },

    async searchContacts(query, limitInput) {
      const limit = assertLimit(limitInput);
      if (query.trim().length < 2) throw new McpRequestError("query is too short");
      const like = `%${query}%`;
      const rows = await many<{
        canonical_jid: string;
        display_name: string | null;
        push_name: string | null;
        verified_name: string | null;
        first_seen_at: string;
        updated_at: string;
        raw_json: string | null;
        aliases: string[] | null;
      }>(
        `select e.canonical_jid, e.display_name, e.push_name, e.verified_name,
                e.first_seen_at, e.updated_at, e.raw_json,
                array_agg(a.alias_jid) as aliases
         from directory_entities e
         left join directory_aliases a on a.account_id = e.account_id and a.canonical_jid = e.canonical_jid
         where e.account_id = $1 and e.entity_type = 'contact'
           and (exists (
             select 1 from messages m
             join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
             where m.account_id = e.account_id and c.is_allowed and not c.is_blocked
               and (m.sender_jid = e.canonical_jid or m.quoted_sender_jid = e.canonical_jid)
           ) or exists (
             select 1 from directory_group_members gm
             join chats gc on gc.account_id = gm.account_id and gc.jid = gm.group_jid
             where gm.account_id = e.account_id and gm.member_jid = e.canonical_jid
               and gm.is_active and gc.is_allowed and not gc.is_blocked
           ))
           and (immutable_unaccent(lower(e.canonical_jid)) like immutable_unaccent(lower($2))
             or immutable_unaccent(lower(coalesce(e.name,''))) like immutable_unaccent(lower($2))
             or immutable_unaccent(lower(coalesce(e.display_name,''))) like immutable_unaccent(lower($2))
             or immutable_unaccent(lower(coalesce(e.push_name,''))) like immutable_unaccent(lower($2))
             or immutable_unaccent(lower(coalesce(e.verified_name,''))) like immutable_unaccent(lower($2))
             or exists (select 1 from directory_aliases a2
                        where a2.account_id = e.account_id and a2.canonical_jid = e.canonical_jid
                          and immutable_unaccent(lower(a2.alias_jid)) like immutable_unaccent(lower($2))))
         group by e.canonical_jid, e.display_name, e.push_name, e.verified_name,
                  e.first_seen_at, e.updated_at, e.raw_json
         order by coalesce(nullif(trim(e.display_name),''), nullif(trim(e.verified_name),''),
                           nullif(trim(e.push_name),''), e.canonical_jid)
         limit $3`,
        [accountId, like, limit],
      );
      return rows.map((row): ParticipantRow => {
        const aliases = row.aliases ?? [];
        const lid = aliases.find((a) => a.endsWith("@lid")) ?? null;
        const phone =
          phoneFromJid(row.canonical_jid) ??
          aliases.map(phoneFromJid).find((v): v is string => v !== undefined) ??
          null;
        return {
          account_id: accountId,
          jid: row.canonical_jid,
          lid,
          phone,
          display_name: row.display_name,
          push_name: row.push_name,
          verified_name: row.verified_name,
          first_seen_at: Number(row.first_seen_at),
          updated_at: Number(row.updated_at),
          raw_json: row.raw_json,
        };
      });
    },

    async listGroupParticipants(chatJid, limitInput) {
      const { row: chat } = await requireAllowedChat(chatJid);
      if (!chat.is_group) throw new McpRequestError("chat is not a group");
      const limit = assertLimit(limitInput);
      const rows = await many<{
        canonical_jid: string;
        display_name: string | null;
        push_name: string | null;
        verified_name: string | null;
        first_seen_at: string;
        updated_at: string;
        raw_json: string | null;
        role: GroupMemberRow["role"];
        is_active: boolean;
        aliases: string[] | null;
      }>(
        `select m.canonical_jid, m.display_name, m.push_name, m.verified_name,
                m.first_seen_at, m.updated_at, m.raw_json,
                gm.role, gm.is_active,
                array_agg(a.alias_jid) as aliases
         from directory_group_members gm
         join directory_entities m
              on m.account_id = gm.account_id and m.canonical_jid = gm.member_jid
         left join directory_aliases a
              on a.account_id = m.account_id and a.canonical_jid = m.canonical_jid
         where gm.account_id = $1 and gm.group_jid = $2 and gm.is_active
         group by m.canonical_jid, m.display_name, m.push_name, m.verified_name,
                  m.first_seen_at, m.updated_at, m.raw_json, gm.role, gm.is_active
         order by coalesce(nullif(trim(m.display_name),''), nullif(trim(m.verified_name),''),
                           nullif(trim(m.push_name),''), m.canonical_jid)
         limit $3`,
        [accountId, chat.jid, limit],
      );
      return rows.map((row): GroupMemberRow => {
        const aliases = row.aliases ?? [];
        return {
          account_id: accountId,
          jid: row.canonical_jid,
          lid: aliases.find((a) => a.endsWith("@lid")) ?? null,
          phone: phoneFromJid(row.canonical_jid) ?? null,
          display_name: row.display_name,
          push_name: row.push_name,
          verified_name: row.verified_name,
          first_seen_at: Number(row.first_seen_at),
          updated_at: Number(row.updated_at),
          raw_json: row.raw_json,
          group_jid: chat.jid,
          role: row.role,
          is_active: bit(row.is_active),
        };
      });
    },

    async getMessage(chatJid, messageId) {
      await requireAllowedChat(chatJid);
      const row = await one<PgMessageRow>(
        `${messageSelectSql()} where m.account_id = $1 and m.chat_jid = $2 and m.message_id = $3`,
        [accountId, chatJid, messageId],
      );
      if (!row) throw new McpRequestError("message not found");
      return toMessageView(row);
    },

    async listMessages(filters: MessageFilters) {
      const limit = assertLimit(filters.limit);
      if (filters.kind && filters.hasMedia === true) {
        const mediaKinds = new Set(["image", "video", "audio", "document", "sticker"]);
        if (!mediaKinds.has(filters.kind)) {
          throw new McpRequestError("kind and hasMedia filters are contradictory");
        }
      }
      const cursor = decodeCursor<{ rowid: number }>(filters.cursor);
      const where: string[] = ["m.account_id = $1"];
      const values: unknown[] = [accountId];
      const add = (clause: string, value: unknown): void => {
        values.push(value);
        where.push(clause.replace("$$", `$${values.length}`));
      };
      if (filters.chat) {
        const aliases = await equivalentJids(filters.chat);
        await requireAllowedChat(filters.chat);
        add("m.chat_jid = any($$::text[])", aliases);
      } else {
        where.push("c.is_allowed and not c.is_blocked");
      }
      if (filters.sender) add("m.sender_jid = $$", filters.sender);
      if (filters.fromMe !== undefined) add("m.from_me = $$", filters.fromMe);
      if (filters.kind) add("m.message_type = $$", filters.kind);
      if (filters.hasMedia !== undefined) add("m.has_media = $$", filters.hasMedia);
      if (filters.ingestionSource) add("m.ingestion_source = $$", filters.ingestionSource);
      if (filters.after !== undefined) add("m.timestamp >= $$", filters.after);
      if (filters.before !== undefined) add("m.timestamp <= $$", filters.before);
      if (cursor) add("m.id < $$", cursor.rowid);
      const rows = await selectMessages(where.join(" and "), values, limit + 1);
      const last = rows[limit - 1];
      return page(
        rows.map(toMessageView),
        limit,
        last ? encodeCursor({ rowid: Number(last.id) }) : null,
      );
    },

    async searchMessages(query, filters) {
      const limit = assertLimit(filters.limit);
      if (filters.kind && filters.hasMedia === true) {
        const mediaKinds = new Set(["image", "video", "audio", "document", "sticker"]);
        if (!mediaKinds.has(filters.kind)) {
          throw new McpRequestError("kind and hasMedia filters are contradictory");
        }
      }
      const terms = query.trim();
      if (!terms) throw new McpRequestError("query is required");
      const where: string[] = [
        "m.account_id = $1",
        "c.is_allowed",
        "not c.is_blocked",
        "(m.search_vector @@ websearch_to_tsquery('simple', immutable_unaccent($2))" +
          " or t.search_vector @@ websearch_to_tsquery('simple', immutable_unaccent($2)))",
      ];
      const values: unknown[] = [accountId, terms];
      const add = (clause: string, value: unknown): void => {
        values.push(value);
        where.push(clause.replace("$$", `$${values.length}`));
      };
      if (filters.chat) {
        await requireAllowedChat(filters.chat);
        add("m.chat_jid = $$", filters.chat);
      }
      if (filters.sender) add("m.sender_jid = $$", filters.sender);
      if (filters.fromMe !== undefined) add("m.from_me = $$", filters.fromMe);
      if (filters.kind) add("m.message_type = $$", filters.kind);
      if (filters.hasMedia !== undefined) add("m.has_media = $$", filters.hasMedia);
      if (filters.after !== undefined) add("m.timestamp >= $$", filters.after);
      if (filters.before !== undefined) add("m.timestamp <= $$", filters.before);
      const cursor = decodeCursor<{ rowid: number }>(filters.cursor);
      if (cursor) add("m.id < $$", cursor.rowid);
      const rows = await many<PgMessageRow & { matched_transcript: boolean }>(
        `${messageSelectSql(
          ", (t.search_vector @@ websearch_to_tsquery('simple', immutable_unaccent($2))) as matched_transcript",
        )}
         where ${where.join(" and ")}
         order by m.id desc limit $${values.length + 1}`,
        [...values, limit + 1],
      );
      const last = rows[limit - 1];
      return page(
        rows.map((row) => ({
          ...mcpMessageView(toMessageView(row)),
          matchedTranscript: row.matched_transcript,
        })),
        limit,
        last ? encodeCursor({ rowid: Number(last.id) }) : null,
      );
    },

    async messageContext(chatJid, messageId, before, after) {
      await requireAllowedChat(chatJid);
      const center = await one<PgMessageRow>(
        `${messageSelectSql()} where m.account_id = $1 and m.chat_jid = $2 and m.message_id = $3`,
        [accountId, chatJid, messageId],
      );
      if (!center) throw new McpRequestError("message not found");
      const [beforeRows, afterRows] = await Promise.all([
        selectMessages(
          "m.account_id = $1 and m.chat_jid = $2 and c.is_allowed and not c.is_blocked and m.id < $3",
          [accountId, chatJid, center.id],
          assertWindow(before),
          "desc",
        ),
        selectMessages(
          "m.account_id = $1 and m.chat_jid = $2 and c.is_allowed and not c.is_blocked and m.id > $3",
          [accountId, chatJid, center.id],
          assertWindow(after),
          "asc",
        ),
      ]);
      return {
        before: beforeRows.reverse().map((row) => mcpMessageView(toMessageView(row))),
        message: mcpMessageView(toMessageView(center)),
        after: afterRows.map((row) => mcpMessageView(toMessageView(row))),
      };
    },

    async chatStats(chatJid) {
      const { row: chat, aliases } = await requireAllowedChat(chatJid);
      const [stats, audio, dirName] = await Promise.all([
        one<{
          message_count: string | null;
          media_message_count: string | null;
          oldest_message_ts: string | null;
          newest_message_ts: string | null;
        }>(
          `select sum(message_count) as message_count,
                  sum(media_message_count) as media_message_count,
                  min(oldest_message_ts) as oldest_message_ts,
                  max(newest_message_ts) as newest_message_ts
           from chat_message_stats
           where account_id = $1 and chat_jid = any($2::text[])`,
          [accountId, aliases],
        ),
        one<{ n: string }>(
          `select count(*) as n from messages
           where account_id = $1 and chat_jid = any($2::text[]) and message_type = 'audio'`,
          [accountId, aliases],
        ),
        one<{ dir_name: string | null }>(
          `select ${DIRECTORY_NAME_COALESCE} as dir_name
           from chats c
           left join directory_entities ec
                  on ec.account_id = c.account_id and ec.canonical_jid = c.jid
           left join directory_aliases da
                  on da.account_id = c.account_id and da.alias_jid = c.jid
           left join directory_entities ea
                  on ea.account_id = da.account_id and ea.canonical_jid = da.canonical_jid
           where c.account_id = $1 and c.jid = $2`,
          [accountId, chat.jid],
        ),
      ]);
      return {
        chatJid: chat.jid,
        name: dirName?.dir_name || chat.name || chat.push_name || chat.jid,
        isGroup: chat.is_group,
        messages: Number(stats?.message_count ?? 0),
        audio: Number(audio?.n ?? 0),
        media: Number(stats?.media_message_count ?? 0),
        firstMessageTs:
          stats?.oldest_message_ts == null ? null : Number(stats.oldest_message_ts),
        lastMessageTs:
          stats?.newest_message_ts == null ? null : Number(stats.newest_message_ts),
      };
    },

    async chatMessageStats(chatJid) {
      await requireAllowedChat(chatJid);
      const aliases = await equivalentJids(chatJid);
      const row = await one<{
        message_count: string | null;
        media_message_count: string | null;
        oldest_message_ts: string | null;
        newest_message_ts: string | null;
        updated_at: string | null;
      }>(
        `select sum(message_count) as message_count,
                sum(media_message_count) as media_message_count,
                min(oldest_message_ts) as oldest_message_ts,
                max(newest_message_ts) as newest_message_ts,
                max(updated_at) as updated_at
         from chat_message_stats where account_id = $1 and chat_jid = any($2::text[])`,
        [accountId, aliases],
      );
      return {
        messageCount: Number(row?.message_count ?? 0),
        mediaMessageCount: Number(row?.media_message_count ?? 0),
        oldestMessageTs: row?.oldest_message_ts == null ? null : Number(row.oldest_message_ts),
        newestMessageTs: row?.newest_message_ts == null ? null : Number(row.newest_message_ts),
        updatedAt: Number(row?.updated_at ?? 0),
      };
    },

    async getTranscript(chatJid, messageId) {
      await requireAllowedChat(chatJid);
      const message = await one(
        "select 1 from messages where account_id = $1 and chat_jid = $2 and message_id = $3",
        [accountId, chatJid, messageId],
      );
      if (!message) throw new McpRequestError("message not found");
      const transcript = await one<{ transcribed_at: string; [key: string]: unknown }>(
        `select text_raw, text_corrected, language, confidence, engine, engine_model,
                lexicon_version, duration_s, transcribed_at
         from transcriptions where account_id = $1 and chat_jid = $2 and message_id = $3`,
        [accountId, chatJid, messageId],
      );
      if (transcript) {
        return {
          chatJid,
          messageId,
          status: "available",
          ...transcript,
          transcribed_at: Number(transcript.transcribed_at),
        };
      }
      const job = await one<{ status: string; reason: string | null }>(
        `select status, reason from transcription_jobs
         where account_id = $1 and chat_jid = $2 and message_id = $3`,
        [accountId, chatJid, messageId],
      );
      if (job) return { chatJid, messageId, status: job.status, reason: job.reason };
      return { chatJid, messageId, status: "pending" };
    },

    async setTranscriptionCorrection({ chatJid, messageId, textCorrected }) {
      const result = await p.query(
        `update transcriptions set text_corrected = $1
         where account_id = $2 and chat_jid = $3 and message_id = $4 and text_raw is not null`,
        [textCorrected, accountId, chatJid, messageId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async getMediaMetadata(chatJid, messageId) {
      await requireAllowedChat(chatJid);
      const attachments = await many<{
        media_type: string | null;
        mime_type: string | null;
        file_name: string | null;
        sha256: string | null;
        size_bytes: string | null;
        downloaded_at: string | null;
      }>(
        `select media_type, mime_type, file_name, sha256, size_bytes, downloaded_at
         from attachments where account_id = $1 and chat_jid = $2 and message_id = $3
         order by attachment_index`,
        [accountId, chatJid, messageId],
      );
      if (attachments.length === 0) {
        const message = await one<{ has_media: boolean; message_type: string | null }>(
          `select has_media, message_type from messages
           where account_id = $1 and chat_jid = $2 and message_id = $3`,
          [accountId, chatJid, messageId],
        );
        if (!message) throw new McpRequestError("message not found");
        return {
          chatJid,
          messageId,
          mediaType: message.message_type,
          hasMedia: message.has_media,
          status: message.has_media ? "metadata-only" : "none",
          downloadTriggered: false,
        };
      }
      const withAvailability = attachments.map((item) => ({
        mediaType: item.media_type,
        mimeType: item.mime_type,
        fileName: item.file_name,
        sha256: item.sha256,
        sizeBytes: item.size_bytes === null ? null : Number(item.size_bytes),
        downloadedAt: item.downloaded_at === null ? null : Number(item.downloaded_at),
        available: localAttachmentAvailable(config, item),
      }));
      return {
        chatJid,
        messageId,
        status: withAvailability.some((a) => a.available) ? "available" : "metadata-only",
        downloadTriggered: false,
        attachments: withAvailability,
      };
    },

    async resolveLocalMediaFile(chatJid, messageId, attachmentIndex) {
      await requireAllowedChat(chatJid);
      const attachment = await one<{
        mime_type: string | null;
        file_name: string | null;
        media_type: string | null;
        sha256: string | null;
      }>(
        `select mime_type, file_name, media_type, sha256 from attachments
         where account_id = $1 and chat_jid = $2 and message_id = $3 and attachment_index = $4`,
        [accountId, chatJid, messageId, attachmentIndex],
      );
      if (!attachment) return null;
      const path = contentAddressedMediaPath(
        config.paths.mediaDir,
        attachment.sha256,
        extensionInput(attachment),
      );
      if (!path || !withinMediaRoot(config.paths.mediaDir, path) || !existsSync(path)) {
        return null;
      }
      return { path, mimeType: attachment.mime_type, fileName: attachment.file_name };
    },

    async getHistoryJob(jobId) {
      const row = await one<PgHistoryJobRow>(
        "select * from history_jobs where account_id = $1 and id = $2",
        [accountId, jobId],
      );
      return row ? toHistoryJobRow(row) : undefined;
    },

    async getActiveHistoryJob() {
      const row = await one<PgHistoryJobRow>(
        `select * from history_jobs where account_id = $1
         and status in ('queued', 'waiting_connection', 'running')
         order by created_at asc limit 1`,
        [accountId],
      );
      return row ? toHistoryJobRow(row) : undefined;
    },

    async exportRows(selection: ExportSelection) {
      const where: string[] = ["m.account_id = $1", "c.is_blocked = false"];
      const values: unknown[] = [accountId];
      const add = (clause: string, value: unknown): void => {
        values.push(value);
        where.push(clause.replace("$$", `$${values.length}`));
      };
      if (selection.sinceTs != null) add("m.timestamp >= $$", selection.sinceTs);
      if (selection.beforeTs != null) add("m.timestamp <= $$", selection.beforeTs);
      if (selection.afterRowid != null) add("m.id > $$", selection.afterRowid);
      const blocked = selection.blockedChats ?? [];
      if (blocked.length > 0) add("m.chat_jid <> all($$::text[])", blocked);
      if (selection.allowedOnly) {
        const allow = selection.allowedChats ?? [];
        values.push(allow);
        where.push(`(c.is_allowed or m.chat_jid = any($${values.length}::text[]))`);
      }
      const limitClause = selection.limit != null ? `limit $${values.length + 1}` : "";
      if (selection.limit != null) values.push(selection.limit);
      const rows = await many<PgExportRow>(
        `select m.id as export_rowid, m.*,
           ${DIRECTORY_NAME_COALESCE} as chat_name,
           c.is_group as chat_is_group, c.is_status as chat_is_status, c.is_allowed as chat_is_allowed
         from messages m
         join chats c on c.account_id = m.account_id and c.jid = m.chat_jid
         left join directory_entities ec
                on ec.account_id = c.account_id and ec.canonical_jid = c.jid
         left join directory_aliases da
                on da.account_id = c.account_id and da.alias_jid = c.jid
         left join directory_entities ea
                on ea.account_id = da.account_id and ea.canonical_jid = da.canonical_jid
         where ${where.join(" and ")}
         order by m.id asc ${limitClause}`,
        values,
      );
      return rows.map(
        (row): ExportRow => ({
          account_id: row.account_id,
          chat_jid: row.chat_jid,
          message_id: row.message_id,
          sender_jid: row.sender_jid,
          from_me: bit(row.from_me),
          timestamp: row.timestamp === null ? null : Number(row.timestamp),
          received_at: Number(row.received_at),
          message_type: row.message_type,
          text: row.text,
          normalized_text: row.normalized_text,
          has_media: bit(row.has_media),
          duration_s: row.duration_s === null ? null : Number(row.duration_s),
          ingestion_source: row.ingestion_source,
          quoted_message_id: row.quoted_message_id,
          quoted_sender_jid: row.quoted_sender_jid,
          edited_message_id: row.edited_message_id,
          deleted_at: row.deleted_at === null ? null : Number(row.deleted_at),
          raw_json: row.raw_json,
          export_rowid: Number(row.export_rowid),
          chat_name: row.chat_name || null,
          chat_is_group: bit(row.chat_is_group),
          chat_is_status: bit(row.chat_is_status),
          chat_is_allowed: bit(row.chat_is_allowed),
        }),
      );
    },

    async getConsumerOffset(consumerName) {
      const row = await one<{
        consumer_name: string;
        last_seen_timestamp: string | null;
        last_seen_event_id: string | null;
        updated_at: string;
      }>(
        "select * from consumer_offsets where consumer_name = $1",
        [consumerName],
      );
      return row
        ? ({
            consumer_name: row.consumer_name,
            last_seen_timestamp:
              row.last_seen_timestamp === null ? null : Number(row.last_seen_timestamp),
            last_seen_event_id:
              row.last_seen_event_id === null ? null : Number(row.last_seen_event_id),
            updated_at: Number(row.updated_at),
          } satisfies ConsumerOffsetRow)
        : undefined;
    },

    async setConsumerOffset(consumerName, offset) {
      await p.query(
        `insert into consumer_offsets (consumer_name, last_seen_timestamp, last_seen_event_id, updated_at)
         values ($1, $2, $3, $4)
         on conflict (consumer_name) do update set
           last_seen_timestamp = coalesce(excluded.last_seen_timestamp, consumer_offsets.last_seen_timestamp),
           last_seen_event_id = coalesce(excluded.last_seen_event_id, consumer_offsets.last_seen_event_id),
           updated_at = excluded.updated_at`,
        [
          consumerName,
          offset.lastSeenTimestamp ?? null,
          offset.lastSeenEventId ?? null,
          Math.floor(Date.now() / 1000),
        ],
      );
    },
  };
}

interface AttachmentMediaColumns {
  sha256: string | null;
  mime_type: string | null;
  file_name: string | null;
  media_type: string | null;
}

const AUDIO_MEDIA_TYPES = [
  "audio",
  "image",
  "video",
  "document",
  "sticker",
] satisfies Array<NonNullable<AudioExtensionInput["mediaType"]>>;

function extensionInput(item: AttachmentMediaColumns): AudioExtensionInput {
  const mediaType = (
    AUDIO_MEDIA_TYPES as readonly string[]
  ).includes(item.media_type ?? "")
    ? (item.media_type as NonNullable<AudioExtensionInput["mediaType"]>)
    : undefined;
  return {
    mimeType: item.mime_type,
    fileName: item.file_name,
    ...(mediaType ? { mediaType } : {}),
  };
}

function localAttachmentAvailable(
  config: Config,
  item: AttachmentMediaColumns,
): boolean {
  const path = contentAddressedMediaPath(
    config.paths.mediaDir,
    item.sha256,
    extensionInput(item),
  );
  return path !== null && withinMediaRoot(config.paths.mediaDir, path) && existsSync(path);
}

function withinMediaRoot(mediaDir: string, path: string): boolean {
  const mediaRoot = resolvePath(mediaDir);
  return !relative(mediaRoot, resolvePath(path)).startsWith("..");
}

function toHistoryJobRow(row: PgHistoryJobRow): HistoryJobRow {
  return {
    id: row.id,
    account_id: row.account_id,
    chat_jid: row.chat_jid,
    since_ts: Number(row.since_ts),
    until_ts: Number(row.until_ts),
    status: row.status,
    phase: row.phase,
    progress_percent: row.progress_percent,
    anchor_sender_jid: row.anchor_sender_jid,
    anchor_message_id: row.anchor_message_id,
    anchor_timestamp: row.anchor_timestamp === null ? null : Number(row.anchor_timestamp),
    oldest_seen_ts: row.oldest_seen_ts === null ? null : Number(row.oldest_seen_ts),
    batches_requested: row.batches_requested,
    batches_completed: row.batches_completed,
    messages_received: row.messages_received,
    messages_inserted: row.messages_inserted,
    coverage_complete: bit(row.coverage_complete),
    completion_reason: row.completion_reason,
    error_code: row.error_code,
    created_at: Number(row.created_at),
    started_at: row.started_at === null ? null : Number(row.started_at),
    updated_at: Number(row.updated_at),
    completed_at: row.completed_at === null ? null : Number(row.completed_at),
  };
}

interface PgChatRow {
  account_id: string;
  jid: string;
  name: string | null;
  push_name: string | null;
  is_group: boolean;
  is_status: boolean;
  is_blocked: boolean;
  is_allowed: boolean;
  discovered_at: string;
  updated_at: string;
  last_message_ts: string | null;
  raw_json: string | null;
}

interface PgMessageRow {
  id: string;
  account_id: string;
  chat_jid: string;
  message_id: string;
  sender_jid: string | null;
  from_me: boolean;
  timestamp: string | null;
  received_at: string;
  message_type: string | null;
  text: string | null;
  normalized_text: string | null;
  has_media: boolean;
  duration_s: number | null;
  ingestion_source: "live" | "history" | "backup";
  quoted_message_id: string | null;
  quoted_sender_jid: string | null;
  edited_message_id: string | null;
  deleted_at: string | null;
  raw_json: string | null;
  sender_name: string | null;
  transcript_text_raw: string | null;
  transcript_text_corrected: string | null;
}

type PgExportRow = PgMessageRow & {
  export_rowid: string;
  chat_name: string | null;
  chat_is_group: boolean;
  chat_is_status: boolean;
  chat_is_allowed: boolean;
};

interface PgHistoryJobRow {
  id: string;
  account_id: string;
  chat_jid: string;
  since_ts: string;
  until_ts: string;
  status: HistoryJobRow["status"];
  phase: HistoryJobRow["phase"];
  progress_percent: number | null;
  anchor_sender_jid: string | null;
  anchor_message_id: string | null;
  anchor_timestamp: string | null;
  oldest_seen_ts: string | null;
  batches_requested: number;
  batches_completed: number;
  messages_received: number;
  messages_inserted: number;
  coverage_complete: boolean;
  completion_reason: string | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
}
