import { getChat, getHistoryJob, type HistoryJobRow } from "../db/queries.js";
import { McpRequestError, type McpContext } from "./types.js";

export interface HistoryJobView {
  jobId: string;
  chat: string;
  since: number;
  until: number;
  status: string;
  phase: string;
  progressPercent: number | null;
  oldestSeenAt: number | null;
  batchesRequested: number;
  batchesCompleted: number;
  messagesReceived: number;
  messagesInserted: number;
  coverageComplete: boolean;
  completionReason: string | null;
  errorCode: string | null;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
}

export async function startHistoryDownload(
  ctx: McpContext,
  chat: string,
  since: number,
): Promise<{ jobId: string; status: string; reused: boolean }> {
  if (!ctx.historyControl) {
    throw new McpRequestError("history control unavailable");
  }
  if (
    !Number.isInteger(since) ||
    since < 0 ||
    since > Math.floor(Date.now() / 1000)
  ) {
    throw new McpRequestError("since must be a valid past Unix timestamp");
  }
  const chatRow = getChat(ctx.db, ctx.accountId, chat);
  if (!chatRow || chatRow.is_allowed !== 1 || chatRow.is_blocked !== 0) {
    throw new McpRequestError("chat is not available");
  }
  if (chatRow.is_group === 1 && !ctx.config.privacy.includeGroups) {
    throw new McpRequestError("chat is not available");
  }
  if (chatRow.is_status === 1 && !ctx.config.privacy.includeStatus) {
    throw new McpRequestError("chat is not available");
  }
  try {
    return await ctx.historyControl(chat, since);
  } catch {
    throw new McpRequestError("history download could not be started");
  }
}

export function historyStatus(ctx: McpContext, jobId: string): HistoryJobView {
  if (!jobId) throw new McpRequestError("jobId is required");
  const row = getHistoryJob(ctx.db, ctx.accountId, jobId);
  if (!row) throw new McpRequestError("history job not found");
  return historyJobView(row);
}

function historyJobView(row: HistoryJobRow): HistoryJobView {
  return {
    jobId: row.id,
    chat: row.chat_jid,
    since: row.since_ts,
    until: row.until_ts,
    status: row.status,
    phase: row.phase,
    progressPercent: row.progress_percent,
    oldestSeenAt: row.oldest_seen_ts,
    batchesRequested: row.batches_requested,
    batchesCompleted: row.batches_completed,
    messagesReceived: row.messages_received,
    messagesInserted: row.messages_inserted,
    coverageComplete: row.coverage_complete === 1,
    completionReason: row.completion_reason,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
