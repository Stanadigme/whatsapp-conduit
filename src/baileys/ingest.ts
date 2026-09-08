import {
  proto,
  type Chat,
  type Contact,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { Database } from "../db/index.js";
import {
  directoryTablesAvailable,
  listEquivalentJids,
  upsertDirectoryContact,
  upsertDirectoryGroup,
} from "../db/directory.js";
import {
  getChat,
  insertEvent,
  upsertChat,
  upsertMessage,
  upsertParticipant,
  resolveParticipantJid,
} from "../db/queries.js";
import { nowSec } from "../util/time.js";
import { isGroupJid, isStatusJid, normalizeJid, phoneFromJid } from "./jid.js";
import { downloadAudioIfEnabled } from "./media.js";
import {
  normalizeMessage,
  normalizeReaction,
  resolveSender,
  type NormalizedMessage,
  type NormalizeResult,
} from "./normalize.js";
import { chatAllowedAtSync, senderAllowedAtSync } from "../privacy/filters.js";
import type { IngestionSource } from "../db/queries.js";

export interface IngestDeps {
  db: Database;
  accountId: string;
  config: Config;
  logger: Logger;
}

export interface IngestionEventClassification {
  source: IngestionSource;
  store: boolean;
}

/** Reasons that warrant an auditable `ignored` event row (vs. bulk categories). */
const AUDITED_IGNORE_REASONS: ReadonlySet<string> = new Set([
  "chat-blocked",
  "chat-blocked-db",
  "sender-blocked",
  "sender-unknown",
  "not-in-allowlist",
  "sender-not-in-allowlist",
]);

/** True if the chat was blocked via `chats block` (DB policy flag). */
function chatBlockedInDb(deps: IngestDeps, chatJid: string): boolean {
  return getChat(deps.db, deps.accountId, chatJid)?.is_blocked === 1;
}

/**
 * Register observe-only ingestion handlers on a socket. Strictly read-side:
 * it listens to message events and writes to SQLite. It never sends, reads, or
 * marks anything.
 */
export interface BaileysIngestionOptions {
  classify?: (message: WAMessage) => IngestionEventClassification;
  onStored?: (
    message: WAMessage,
    stored: boolean,
    classification: IngestionEventClassification,
  ) => void;
}

export function registerIngestion(
  sock: WASocket,
  deps: IngestDeps,
  options: BaileysIngestionOptions = {},
): void {
  const ingestMessages = (
    messages: readonly WAMessage[],
    useClassifier: boolean,
  ): void => {
    for (const msg of messages) {
      try {
        const classification =
          (useClassifier ? options.classify?.(msg) : undefined) ??
          ({ source: "live", store: true } as const);
        if (!classification.store) continue;
        const stored = ingestMessage(deps, msg, classification.source);
        options.onStored?.(msg, stored !== null, classification);
        // Fire-and-forget: a media outage must never stall ingestion.
        if (stored && classification.source === "live") {
          void downloadAudioIfEnabled(msg, stored, deps).catch(
            (err: unknown) => {
              deps.logger.error(
                { err: err instanceof Error ? err.message : String(err) },
                "failed to schedule audio download",
              );
            },
          );
        }
      } catch (err) {
        deps.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to ingest message",
        );
      }
    }
  };

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    ingestMessages(messages, true);
  });

  sock.ev.on("messages.update", (updates) => {
    for (const update of updates) {
      try {
        ingestUpdate(deps, update);
      } catch (err) {
        deps.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to ingest message update",
        );
      }
    }
  });

  // Reactions to already-synced messages arrive via a dedicated event.
  sock.ev.on("messages.reaction", (reactions) => {
    for (const { key, reaction } of reactions) {
      try {
        ingestReaction(deps, key, reaction);
      } catch (err) {
        deps.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "failed to ingest reaction",
        );
      }
    }
  });

  sock.ev.on("lid-mapping.update", (mapping) => {
    persistLidMapping(deps, mapping.pn, mapping.lid);
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    persistContactMetadataList(deps, contacts);
  });

  sock.ev.on("contacts.update", (contacts) => {
    persistContactMetadataList(deps, contacts);
  });

  sock.ev.on(
    "messaging-history.set",
    ({
      contacts = [],
      chats = [],
      messages = [],
      lidPnMappings = [],
      syncType,
    }) => {
      for (const mapping of lidPnMappings) {
        if (mapping.pn && mapping.lid) {
          persistLidMapping(deps, mapping.pn, mapping.lid);
        }
      }
      // History carries contact and chat metadata separately from the message
      // upserts. Persist both so the first dashboard view uses the local name
      // even when no recent message has supplied a push name yet.
      persistChatMetadataList(deps, chats);
      persistContactMetadataList(deps, contacts);
      // Baileys v7 carries reconnect catch-up and on-demand history in this
      // event; it does not replay those rows through `messages.upsert`.
      ingestMessages(
        messages,
        syncType === proto.HistorySync.HistorySyncType.ON_DEMAND,
      );
    },
  );

  sock.ev.on("chats.upsert", (chats) => {
    persistChatMetadataList(deps, chats);
  });

  sock.ev.on("chats.update", (chats) => {
    persistChatMetadataList(deps, chats);
  });

  // Group subject changes arrive here rather than through `chats.*`.
  const persistGroupSubjects = (
    groups: readonly Partial<{ id: string; subject: string }>[],
  ): void => {
    for (const group of groups) {
      if (typeof group.id !== "string" || !group.subject?.trim()) continue;
      try {
        persistChatMetadata(deps, { id: group.id, name: group.subject.trim() });
      } catch (error) {
        deps.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "failed to persist group subject",
        );
      }
    }
  };
  sock.ev.on("groups.upsert", persistGroupSubjects);
  sock.ev.on("groups.update", persistGroupSubjects);
}

function persistContactMetadataList(
  deps: IngestDeps,
  contacts: readonly Partial<Contact>[],
): void {
  for (const contact of contacts) {
    try {
      persistContactMetadata(deps, contact);
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to persist contact metadata",
      );
    }
  }
}

/** Persist all contact names while keeping local, public, and verified names separate. */
function persistContactMetadata(
  deps: IngestDeps,
  contact: Partial<Contact>,
): void {
  const id = typeof contact.id === "string" ? contact.id : null;
  const phoneJid =
    typeof contact.phoneNumber === "string" ? contact.phoneNumber : null;
  const jid = phoneJid ?? id;
  if (!jid) return;

  const normalizedJid = normalizeJid(jid);
  if (isGroupJid(normalizedJid) || isStatusJid(normalizedJid)) return;

  const lid =
    typeof contact.lid === "string"
      ? contact.lid
      : id?.endsWith("@lid")
        ? id
        : null;
  const phone = phoneFromJid(normalizedJid);
  upsertParticipant(deps.db, {
    accountId: deps.accountId,
    jid: normalizedJid,
    ...(lid ? { lid: normalizeJid(lid) } : {}),
    ...(phone ? { phone } : {}),
    ...(contact.name !== undefined ? { displayName: contact.name } : {}),
    ...(contact.notify !== undefined ? { pushName: contact.notify } : {}),
    ...(contact.verifiedName !== undefined
      ? { verifiedName: contact.verifiedName }
      : {}),
  });
}

function persistChatMetadataList(
  deps: IngestDeps,
  chats: readonly Partial<Chat>[],
): void {
  for (const chat of chats) {
    try {
      persistChatMetadata(deps, chat);
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to persist chat metadata",
      );
    }
  }
}

/** Persist chat names and project direct-chat names into the directory. */
export function persistChatMetadata(
  deps: IngestDeps,
  chat: Partial<Chat>,
): void {
  if (typeof chat.id !== "string" || chat.id.length === 0) return;
  const jid = normalizeJid(chat.id);
  const name = chat.displayName || chat.name || null;
  const isGroup = isGroupJid(jid);
  const isStatus = isStatusJid(jid);

  upsertChat(deps.db, {
    accountId: deps.accountId,
    jid,
    ...(name !== null ? { name } : {}),
    isGroup,
    isStatus,
  });

  if (!directoryTablesAvailable(deps.db) || isStatus) return;
  if (isGroup) {
    upsertDirectoryGroup(deps.db, {
      accountId: deps.accountId,
      jid,
      ...(name !== null ? { name, nameSource: "group_info" } : {}),
    });
    return;
  }

  const phoneJid = typeof chat.pnJid === "string" ? chat.pnJid : jid;
  const lid =
    typeof chat.lidJid === "string"
      ? chat.lidJid
      : typeof chat.accountLid === "string"
        ? chat.accountLid
        : jid.endsWith("@lid")
          ? jid
          : null;
  upsertDirectoryContact(deps.db, {
    accountId: deps.accountId,
    jid: phoneJid,
    ...(lid ? { lid } : {}),
    ...(name !== null ? { displayName: name } : {}),
  });
}

function persistLidMapping(
  deps: IngestDeps,
  phoneJid: string,
  lid: string,
  displayName: string | null = null,
): void {
  const jid = normalizeJid(phoneJid);
  const normalizedLid = normalizeJid(lid);
  if (!jid || !normalizedLid.endsWith("@lid")) return;
  upsertParticipant(deps.db, {
    accountId: deps.accountId,
    jid,
    lid: normalizedLid,
    phone: phoneFromJid(jid) ?? null,
    displayName,
  });
}

interface ChatContext {
  jid: string;
  isGroup: boolean;
  isStatus: boolean;
}

/**
 * Apply chat-level filters (config category/allow/block plus the DB `is_blocked`
 * flag set by `chats block`). Records an audited ignored event and returns false
 * when the chat is filtered out.
 */
function chatPasses(
  deps: IngestDeps,
  ctx: ChatContext,
  messageId: string | null,
): boolean {
  const aliases = listEquivalentJids(deps.db, deps.accountId, ctx.jid);
  const blockedAlias = aliases.find((jid) =>
    deps.config.filters.blockedChats.includes(jid),
  );
  const allowedAlias = aliases.find((jid) =>
    deps.config.filters.allowedChats.includes(jid),
  );
  const decision = chatAllowedAtSync(deps.config, {
    ...ctx,
    jid: blockedAlias ?? allowedAlias ?? ctx.jid,
  });
  if (!decision.store) {
    recordIgnored(deps, ctx.jid, messageId, decision.reason);
    return false;
  }
  if (aliases.some((jid) => chatBlockedInDb(deps, jid))) {
    recordIgnored(deps, ctx.jid, messageId, "chat-blocked-db");
    return false;
  }
  return true;
}

/** Apply the sender filter; record an ignored event and return false on reject. */
function senderPasses(
  deps: IngestDeps,
  chatJid: string,
  senderJid: string | null,
  messageId: string | null,
): boolean {
  const decision = senderAllowedAtSync(deps.config, senderJid);
  if (!decision.store) {
    recordIgnored(deps, chatJid, messageId, decision.reason);
    return false;
  }
  return true;
}

/** Ingest a single message from `messages.upsert`. */
/**
 * Normalize and persist one inbound message.
 *
 * Returns the stored message, or `null` when nothing was written — a skip, or
 * a chat/sender the filters reject. Callers use that to decide whether to
 * follow up on the message: media is only ever fetched for a conversation we
 * actually persisted.
 */
export function ingestMessage(
  deps: IngestDeps,
  msg: WAMessage,
  ingestionSource: IngestionSource = "live",
): NormalizedMessage | null {
  const result = normalizeMessage(msg);
  if (result.action === "skip") {
    deps.logger.debug({ reason: result.reason }, "skipped message");
    return null;
  }

  const stored = ingestNormalizedResult(
    deps,
    result,
    rawJsonOf(deps.config, msg),
    ingestionSource,
  );
  return stored && result.action === "store" ? result.message : null;
}

/** Persist a transport-independent normalized event. */
export function ingestNormalizedResult(
  deps: IngestDeps,
  result: NormalizeResult,
  rawJson: string | null,
  ingestionSource: IngestionSource = "live",
): boolean {
  if (result.action === "skip") return false;

  const ctx: ChatContext =
    result.action === "store"
      ? {
          jid: result.message.chatJid,
          isGroup: result.message.isGroup,
          isStatus: result.message.isStatus,
        }
      : {
          jid: result.chatJid,
          isGroup: result.isGroup,
          isStatus: result.isStatus,
        };

  const messageId = messageIdOf(result);
  if (!chatPasses(deps, ctx, messageId)) return false;

  // The sender filter applies to stores AND protocol edits/revokes alike — a
  // blocked sender must not be able to write edited text or tombstones either.
  const senderJid =
    result.action === "store" ? result.message.senderJid : result.senderJid;
  const resolvedSenderJid = senderJid
    ? resolveParticipantJid(deps.db, deps.accountId, senderJid)
    : null;
  if (!senderPasses(deps, ctx.jid, resolvedSenderJid, messageId)) return false;

  if (result.action === "store") {
    persistStore(
      deps,
      result.message,
      rawJson,
      resolvedSenderJid,
      ingestionSource,
    );
    return true;
  }

  if (result.action === "revoke") {
    persistRevoke(
      deps,
      result.chatJid,
      result.targetId,
      ctx.isGroup,
      ctx.isStatus,
    );
    return true;
  }

  // edit
  persistEdit(deps, result, ctx.isGroup, ctx.isStatus, rawJson);
  return true;
}

/** Ingest a reaction from the dedicated `messages.reaction` event. */
export function ingestReaction(
  deps: IngestDeps,
  key: proto.IMessageKey,
  reaction: proto.IReaction,
): void {
  const result = normalizeReaction(key, reaction);
  if (result.action !== "store") return;
  const { message } = result;
  const ctx: ChatContext = {
    jid: message.chatJid,
    isGroup: message.isGroup,
    isStatus: message.isStatus,
  };
  if (!chatPasses(deps, ctx, message.messageId)) return;
  const resolvedSenderJid = message.senderJid
    ? resolveParticipantJid(deps.db, deps.accountId, message.senderJid)
    : null;
  if (!senderPasses(deps, ctx.jid, resolvedSenderJid, message.messageId))
    return;
  persistStore(deps, message, null, resolvedSenderJid);
}

/** Handle `messages.update` — used here only to capture delete-for-everyone. */
export function ingestUpdate(
  deps: IngestDeps,
  update: { key: proto.IMessageKey; update: Partial<proto.IWebMessageInfo> },
): void {
  const chatJid = update.key?.remoteJid ?? null;
  const targetId = update.key?.id ?? null;
  if (!chatJid || !targetId) return;

  const revokeStub = proto.WebMessageInfo.StubType.REVOKE;
  const isRevoke =
    update.update?.messageStubType === revokeStub ||
    update.update?.message === null;
  if (!isRevoke) return;

  const ctx: ChatContext = {
    jid: chatJid,
    isGroup: isGroupJid(chatJid),
    isStatus: isStatusJid(chatJid),
  };
  if (!chatPasses(deps, ctx, targetId)) return;

  // The live revoke route must honor the sender filter too. Derive the sender
  // from the update key when present; otherwise null fails closed under a
  // configured sender allowlist.
  const senderJid = resolveSender(
    update.key,
    ctx.isGroup,
    Boolean(update.key.fromMe),
  );
  const resolvedSenderJid = senderJid
    ? resolveParticipantJid(deps.db, deps.accountId, senderJid)
    : null;
  if (!senderPasses(deps, chatJid, resolvedSenderJid, targetId)) return;

  persistRevoke(deps, chatJid, targetId, ctx.isGroup, ctx.isStatus);
}

function persistStore(
  deps: IngestDeps,
  n: NormalizedMessage,
  rawJson: string | null,
  resolvedSenderJid: string | null = n.senderJid,
  ingestionSource: IngestionSource = "live",
): void {
  const storeText = deps.config.privacy.storeMessageText;
  const text = storeText ? n.text : null;
  const tx = deps.db.transaction(() => {
    upsertChat(deps.db, {
      accountId: deps.accountId,
      jid: n.chatJid,
      isGroup: n.isGroup,
      isStatus: n.isStatus,
      lastMessageTs: n.timestamp,
      // pushName from a 1:1 inbound message is the other party's display name.
      pushName: !n.isGroup && !n.fromMe ? n.pushName : null,
    });
    if (n.senderJid) {
      upsertParticipant(deps.db, {
        accountId: deps.accountId,
        jid: resolvedSenderJid ?? n.senderJid,
        lid: n.senderJid.endsWith("@lid") ? n.senderJid : null,
        phone: phoneFromJid(resolvedSenderJid ?? n.senderJid) ?? null,
        pushName: n.fromMe ? null : n.pushName,
      });
    }
    upsertMessage(deps.db, {
      accountId: deps.accountId,
      chatJid: n.chatJid,
      messageId: n.messageId,
      senderJid: resolvedSenderJid,
      fromMe: n.fromMe,
      timestamp: n.timestamp,
      messageType: n.messageType,
      text,
      hasMedia: n.hasMedia,
      durationS: n.durationS,
      quotedMessageId: n.quotedMessageId,
      quotedSenderJid: n.quotedSenderJid
        ? resolveParticipantJid(deps.db, deps.accountId, n.quotedSenderJid)
        : null,
      rawJson,
      ingestionSource,
    });
  });
  tx();
}

function persistRevoke(
  deps: IngestDeps,
  chatJid: string,
  targetId: string,
  isGroup: boolean,
  isStatus: boolean,
): void {
  const tx = deps.db.transaction(() => {
    upsertChat(deps.db, {
      accountId: deps.accountId,
      jid: chatJid,
      isGroup,
      isStatus,
    });
    upsertMessage(deps.db, {
      accountId: deps.accountId,
      chatJid,
      messageId: targetId,
      deletedAt: nowSec(),
    });
  });
  tx();
}

function persistEdit(
  deps: IngestDeps,
  result: Extract<NormalizeResult, { action: "edit" }>,
  isGroup: boolean,
  isStatus: boolean,
  rawJson: string | null,
): void {
  const storeText = deps.config.privacy.storeMessageText;
  const text = storeText ? result.text : null;
  // Explicit loss over invented data: if the edited content could not be
  // parsed, keep the raw edit payload (when enabled) as an event so it stays
  // recoverable rather than discarding the only copy of the new content.
  const preserveRaw = result.text === null && rawJson !== null;
  const tx = deps.db.transaction(() => {
    upsertChat(deps.db, {
      accountId: deps.accountId,
      jid: result.chatJid,
      isGroup,
      isStatus,
    });
    upsertMessage(deps.db, {
      accountId: deps.accountId,
      chatJid: result.chatJid,
      messageId: result.targetId,
      text,
      editedMessageId: result.editId,
    });
    if (preserveRaw) {
      insertEvent(deps.db, {
        accountId: deps.accountId,
        eventType: "edit_unparsed",
        eventTs: nowSec(),
        rawJson,
      });
    }
  });
  tx();
}

function recordIgnored(
  deps: IngestDeps,
  chatJid: string,
  messageId: string | null,
  reason: string | undefined,
): void {
  deps.logger.debug({ reason, chatJid }, "ignored message at sync filter");
  if (!reason || !AUDITED_IGNORE_REASONS.has(reason)) return;
  // Metadata only — never the message body, even for a blocked chat.
  insertEvent(deps.db, {
    accountId: deps.accountId,
    eventType: "ignored",
    eventTs: nowSec(),
    rawJson: JSON.stringify({ chatJid, messageId, reason }),
  });
}

function messageIdOf(result: NormalizeResult): string | null {
  if (result.action === "store") return result.message.messageId;
  if (result.action === "revoke" || result.action === "edit") {
    return result.targetId;
  }
  return null;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isLongLike(
  value: unknown,
): value is { low: number; high: number; toNumber: () => number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "low" in value &&
    "high" in value &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  );
}

/**
 * Serialize the raw Baileys payload for `raw_json` when enabled. Converts binary
 * fields to base64 and Long timestamps to numbers so the JSON stays compact and
 * lossless-enough to recover from parser gaps later.
 *
 * The raw payload contains message text, so `store_message_text: false` is
 * authoritative: it suppresses raw_json too. Disabling text storage must not be
 * silently undone by the (default-on) raw payload.
 */
export function rawJsonOf(config: Config, msg: WAMessage): string | null {
  return rawJsonOfValue(config, msg);
}

/** Serialize any transport payload under the same privacy policy. */
export function rawJsonOfValue(config: Config, value: unknown): string | null {
  if (!config.privacy.storeRawJson || !config.privacy.storeMessageText) {
    return null;
  }
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (isUint8Array(nested)) return Buffer.from(nested).toString("base64");
    if (isLongLike(nested)) return nested.toNumber();
    return nested;
  });
}
