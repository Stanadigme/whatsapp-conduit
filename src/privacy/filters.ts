import type { Config } from "../config.js";

/**
 * ADR-0037 §1: the capture scope (`privacy.include_groups/include_status`,
 * `filters.allowed_chats/blocked_chats`, `chats.is_allowed/is_blocked`) no
 * longer decides whether a message is stored — every message the phone
 * delivers is written to SQLite. It decides **exposure**, and the single,
 * durable definition of exposure is `chatExposureAllowed`
 * (`src/db/directory.ts`, ADR-0037 §2).
 *
 * `chatAllowedAtSync` survives here only as the config-category/allow/block
 * half of an interim guard (`exposedForSideEffects`, `src/baileys/ingest.ts`)
 * that still has to bound media download and outbox enqueue before
 * `chatExposureAllowed` covers the whole capture scope (S3b). It no longer
 * gates storage, and its former sibling `senderAllowedAtSync` was removed:
 * sender-level exclusion isn't applied to exposure yet either (ADR-0037 §6),
 * so nothing reuses it.
 */
export interface ChatContext {
  jid: string;
  isGroup: boolean;
  isStatus: boolean;
}

export interface FilterDecision {
  store: boolean;
  reason?: string;
}

export function chatAllowedAtSync(
  config: Config,
  ctx: ChatContext,
): FilterDecision {
  if (ctx.isStatus && !config.privacy.includeStatus) {
    return { store: false, reason: "status-excluded" };
  }
  if (ctx.isGroup && !config.privacy.includeGroups) {
    return { store: false, reason: "groups-excluded" };
  }
  if (config.filters.blockedChats.includes(ctx.jid)) {
    return { store: false, reason: "chat-blocked" };
  }
  const allow = config.filters.allowedChats;
  if (allow.length > 0 && !allow.includes(ctx.jid)) {
    return { store: false, reason: "not-in-allowlist" };
  }
  return { store: true };
}
