import type { Database } from "better-sqlite3";
import { listEquivalentJids } from "../db/directory.js";
import { allowedChat, type MessageReadContext } from "./messages.js";

export interface ChatMessageStats {
  messageCount: number;
  mediaMessageCount: number;
  oldestMessageTs: number | null;
  newestMessageTs: number | null;
  updatedAt: number;
}

interface ChatMessageStatsRow {
  message_count: number;
  media_message_count: number;
  oldest_message_ts: number | null;
  newest_message_ts: number | null;
  updated_at: number;
}

/** Read the materialized row only; never aggregate `messages` for a view. */
export function getChatMessageStats(
  ctx: MessageReadContext,
  chatJid: string,
): ChatMessageStats {
  allowedChat(ctx, chatJid);
  const aliases = listEquivalentJids(ctx.db, ctx.accountId, chatJid);
  const placeholders = aliases.map((_, index) => `@alias${index}`);
  const row = ctx.db
    .prepare(
      `select sum(message_count) as message_count,
              sum(media_message_count) as media_message_count,
              min(oldest_message_ts) as oldest_message_ts,
              max(newest_message_ts) as newest_message_ts,
              max(updated_at) as updated_at
       from chat_message_stats where account_id = @accountId
       and chat_jid in (${placeholders.join(", ")})`,
    )
    .get({
      accountId: ctx.accountId,
      ...Object.fromEntries(
        aliases.map((alias, index) => [`alias${index}`, alias]),
      ),
    }) as ChatMessageStatsRow | undefined;
  return {
    messageCount: row?.message_count ?? 0,
    mediaMessageCount: row?.media_message_count ?? 0,
    oldestMessageTs: row?.oldest_message_ts ?? null,
    newestMessageTs: row?.newest_message_ts ?? null,
    updatedAt: row?.updated_at ?? 0,
  };
}

export type { Database };
