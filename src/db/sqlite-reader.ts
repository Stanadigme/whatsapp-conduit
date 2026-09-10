import { existsSync } from "node:fs";
import { resolve as resolvePath, relative } from "node:path";
import type { Database } from "better-sqlite3";
import type { Config } from "../config.js";
import { listDashboardChats } from "../dashboard/chats.js";
import { flushPostgresProjection } from "./postgres-projection.js";
import {
  chatStats as sqliteChatStats,
  getMedia as sqliteGetMedia,
  getTranscript as sqliteGetTranscript,
  health as sqliteHealth,
  listChats as sqliteListChats,
  listGroupParticipants as sqliteListGroupParticipants,
  messageContext as sqliteMessageContext,
  searchContacts as sqliteSearchContacts,
  searchMessages as sqliteSearchMessages,
  type SqliteMcpContext,
} from "../mcp/read.js";
import { getChatMessageStats } from "../read/chat-stats.js";
import {
  allowedChat,
  getMessage as sqliteGetMessage,
  listMessages as sqliteListMessages,
  type MessageFilters,
} from "../read/messages.js";
import {
  getActiveHistoryJob,
  getAttachment,
  getChat,
  getConsumerOffset,
  getHistoryJob,
  selectExportMessages,
  setConsumerOffset as sqliteSetConsumerOffset,
  setTranscriptionCorrection as sqliteSetTranscriptionCorrection,
} from "./queries.js";
import type {
  ClientDataReader,
  ExportSelection,
  LocalMediaFile,
  McpChatStatsView,
} from "./reader.js";

/**
 * The SQLite backend: a thin async wrapper around the existing, tested,
 * synchronous read layer. No query behavior changes here — the point of this
 * file is to expose the same {@link ClientDataReader} shape a PostgreSQL
 * backend can also implement, not to alter what SQLite mode returns.
 */
export function createSqliteReader(
  db: Database,
  config: Config,
  accountId: string,
): ClientDataReader {
  const ctx: SqliteMcpContext = {
    db,
    config,
    accountId,
    runtimeStatus: null,
  };
  const readCtx = { db, accountId };

  return {
    async health() {
      const full = sqliteHealth(ctx);
      return {
        selfJid: full.account as string | null,
        chats: full.chats as number,
        allowedChats: full.allowedChats as number,
        messages: full.messages as number,
        attachments: full.attachments as number,
        lastMessageAt: full.lastMessageAt as number | null,
        schemaVersion: full.schema as string | null,
        transcriptionAvailable: full.transcription === "available",
      };
    },

    async getSchemaVersion() {
      return (
        db
          .prepare<
            [],
            { name: string }
          >("select name from schema_migrations order by name desc limit 1")
          .get()?.name ?? null
      );
    },

    async getChat(chatJid) {
      return getChat(db, accountId, chatJid);
    },

    async listChats(opts) {
      return sqliteListChats(ctx, opts.limit, opts.cursor);
    },

    async listDashboardChats(filter) {
      return listDashboardChats(db, accountId, filter ?? {});
    },

    async searchContacts(query, limit) {
      return sqliteSearchContacts(ctx, query, limit);
    },

    async listGroupParticipants(chatJid, limit) {
      return sqliteListGroupParticipants(ctx, chatJid, limit);
    },

    async getMessage(chatJid, messageId) {
      return sqliteGetMessage(readCtx, chatJid, messageId);
    },

    async listMessages(filters: MessageFilters) {
      return sqliteListMessages(readCtx, filters);
    },

    async searchMessages(query, filters) {
      return sqliteSearchMessages(ctx, query, filters);
    },

    async messageContext(chatJid, messageId, before, after) {
      return sqliteMessageContext(ctx, chatJid, messageId, before, after);
    },

    async chatStats(chatJid) {
      // mcp/read.ts's chatStats always builds exactly this shape; it stays
      // loosely typed there since it is also a direct MCP tool return value.
      return sqliteChatStats(ctx, chatJid) as unknown as McpChatStatsView;
    },

    async chatMessageStats(chatJid) {
      return getChatMessageStats(readCtx, chatJid);
    },

    async getTranscript(chatJid, messageId) {
      return sqliteGetTranscript(ctx, chatJid, messageId);
    },

    async setTranscriptionCorrection(input) {
      const applied = sqliteSetTranscriptionCorrection(db, {
        accountId,
        ...input,
      });
      // The dashboard reads its own write back in the same request; it must
      // not see the pre-correction text depending on projection timing.
      if (applied) await flushPostgresProjection();
      return applied;
    },

    async getMediaMetadata(chatJid, messageId) {
      // Never forward the raw local path a client has no use for (it revealed
      // server filesystem layout for no functional benefit); `available`
      // already conveys everything a caller needs.
      const full = sqliteGetMedia(ctx, chatJid, messageId);
      const attachments = full.attachments as
        | Array<Record<string, unknown>>
        | undefined;
      if (!attachments) return full;
      return {
        ...full,
        attachments: attachments.map(({ filePath: _filePath, ...rest }) => rest),
      };
    },

    async resolveLocalMediaFile(chatJid, messageId, attachmentIndex) {
      allowedChat(readCtx, chatJid);
      const attachment = getAttachment(
        db,
        accountId,
        chatJid,
        messageId,
        attachmentIndex,
      );
      return resolveWithinMediaRoot(
        config.paths.mediaDir,
        attachment?.file_path ?? null,
        attachment?.mime_type ?? null,
        attachment?.file_name ?? null,
      );
    },

    async getHistoryJob(jobId) {
      return getHistoryJob(db, accountId, jobId);
    },

    async getActiveHistoryJob() {
      return getActiveHistoryJob(db, accountId);
    },

    async exportRows(selection: ExportSelection) {
      return selectExportMessages(db, { accountId, ...selection });
    },

    async getConsumerOffset(consumerName) {
      return getConsumerOffset(db, consumerName);
    },

    async setConsumerOffset(consumerName, offset) {
      sqliteSetConsumerOffset(db, consumerName, offset);
    },
  };
}

/** Reject a path that would escape the configured media root (defense in depth). */
function resolveWithinMediaRoot(
  mediaDir: string,
  filePath: string | null,
  mimeType: string | null,
  fileName: string | null,
): LocalMediaFile | null {
  if (!filePath) return null;
  const mediaRoot = resolvePath(mediaDir);
  const path = resolvePath(filePath);
  if (relative(mediaRoot, path).startsWith("..")) return null;
  if (!existsSync(path)) return null;
  return { path, mimeType, fileName };
}
