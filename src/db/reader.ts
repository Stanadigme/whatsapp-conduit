import type { DashboardChat, DashboardChatFilter } from "../dashboard/chats.js";
import type { ChatView } from "../mcp/read.js";
import type { Page } from "../mcp/types.js";
import type { ChatMessageStats } from "../read/chat-stats.js";
import type {
  McpMessageView,
  MessageFilters,
  MessageView,
} from "../read/messages.js";
import type {
  ChatRow,
  ConsumerOffsetRow,
  ExportRow,
  GroupMemberRow,
  HistoryJobRow,
  ParticipantRow,
  TranscriptionCorrectionInput,
} from "./queries.js";

/**
 * Client data, read behind one interface with two backends: SQLite (today's
 * default, and the profile used whenever `persistence.postgres` is unset) and
 * PostgreSQL (ADR-0033 phase 2 — the client's own database, once configured,
 * with no SQLite read fallback). MCP, the dashboard, and export all read
 * through this instead of opening a database handle themselves, so which
 * backend is active is decided once, at process start, in one place.
 *
 * Every method reflects the account fixed at construction time; none take an
 * `accountId` parameter.
 */
export interface ClientDataReader {
  health(): Promise<HealthCounts>;

  getChat(chatJid: string): Promise<ChatRow | undefined>;
  listChats(opts: { limit?: number; cursor?: string }): Promise<Page<ChatView>>;
  listDashboardChats(filter?: DashboardChatFilter): Promise<DashboardChat[]>;
  /** Apply an allow/block decision and return the chat's new dashboard view. */
  setChatPolicy(
    chatJid: string,
    action: "allow" | "block",
  ): Promise<DashboardChat>;

  searchContacts(query: string, limit?: number): Promise<ParticipantRow[]>;
  listGroupParticipants(
    chatJid: string,
    limit?: number,
  ): Promise<GroupMemberRow[]>;

  /** Policy-checked single message. Throws McpRequestError if not visible. */
  getMessage(chatJid: string, messageId: string): Promise<MessageView>;
  listMessages(filters: MessageFilters): Promise<Page<MessageView>>;
  /**
   * MCP-shaped (no `textRaw`): search has no dashboard consumer today, unlike
   * `listMessages`, which the dashboard also calls for its own message list.
   */
  searchMessages(
    query: string,
    filters: MessageFilters,
  ): Promise<Page<McpMessageView & { matchedTranscript: boolean }>>;
  /** MCP-shaped (no `textRaw`): only wa_message_context consumes this today. */
  messageContext(
    chatJid: string,
    messageId: string,
    before: number,
    after: number,
  ): Promise<{
    before: McpMessageView[];
    message: McpMessageView;
    after: McpMessageView[];
  }>;

  /** `wa_chat_stats`'s richer, single-conversation shape. */
  chatStats(chatJid: string): Promise<McpChatStatsView>;
  /** The dashboard's materialized, alias-summed shape. */
  chatMessageStats(chatJid: string): Promise<ChatMessageStats>;

  getTranscript(
    chatJid: string,
    messageId: string,
  ): Promise<Record<string, unknown>>;
  setTranscriptionCorrection(
    input: Omit<TranscriptionCorrectionInput, "accountId">,
  ): Promise<boolean>;

  /** Metadata only, `available` reflects the local cache — never a raw path. */
  getMediaMetadata(
    chatJid: string,
    messageId: string,
  ): Promise<Record<string, unknown>>;
  /** Resolve one attachment to a local file to stream, or null if absent. */
  resolveLocalMediaFile(
    chatJid: string,
    messageId: string,
    attachmentIndex: number,
  ): Promise<LocalMediaFile | null>;

  getHistoryJob(jobId: string): Promise<HistoryJobRow | undefined>;
  getActiveHistoryJob(): Promise<HistoryJobRow | undefined>;

  exportRows(selection: ExportSelection): Promise<ExportRow[]>;
  getConsumerOffset(consumerName: string): Promise<ConsumerOffsetRow | undefined>;
  setConsumerOffset(
    consumerName: string,
    offset: { lastSeenTimestamp?: number | null; lastSeenEventId?: number | null },
  ): Promise<void>;
}

export interface HealthCounts {
  selfJid: string | null;
  chats: number;
  allowedChats: number;
  messages: number;
  attachments: number;
  lastMessageAt: number | null;
  schemaVersion: string | null;
  transcriptionAvailable: boolean;
}

export interface McpChatStatsView {
  chatJid: string;
  name: string;
  isGroup: boolean;
  messages: number;
  audio: number;
  media: number;
  firstMessageTs: number | null;
  lastMessageTs: number | null;
}

export interface LocalMediaFile {
  path: string;
  mimeType: string | null;
  fileName: string | null;
}

/** Mirrors db/queries.ts's ExportSelect, minus the SQLite-only `accountId`. */
export interface ExportSelection {
  sinceTs?: number | null | undefined;
  beforeTs?: number | null | undefined;
  afterRowid?: number | null | undefined;
  allowedOnly?: boolean | undefined;
  allowedChats?: string[] | undefined;
  blockedChats?: string[] | undefined;
  limit?: number | undefined;
}
