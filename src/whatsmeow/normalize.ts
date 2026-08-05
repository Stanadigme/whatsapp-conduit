import { isGroupJid, isStatusJid, normalizeJid } from "../baileys/jid.js";
import type { NormalizeResult, NormalizedMessage } from "../ingest/types.js";
import type { TransportMessageEvent } from "../transport/types.js";

const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);
const CONTENT_TYPES = new Map<string, NormalizedMessage["messageType"]>([
  ["conversation", "text"],
  ["extendedTextMessage", "text"],
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["audioMessage", "audio"],
  ["documentMessage", "document"],
  ["stickerMessage", "sticker"],
  ["contactMessage", "contact"],
  ["contactsArrayMessage", "contact"],
  ["locationMessage", "location"],
  ["liveLocationMessage", "location"],
  ["pollCreationMessage", "poll"],
  ["pollCreationMessageV2", "poll"],
  ["pollCreationMessageV3", "poll"],
  ["pollCreationMessageV4", "poll"],
  ["pollCreationMessageV5", "poll"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isRecord(value) && typeof value.toNumber === "function") {
    const n = value.toNumber as () => unknown;
    const result = n();
    return typeof result === "number" && Number.isFinite(result)
      ? result
      : null;
  }
  return null;
}

function contentType(message: Record<string, unknown>): string | null {
  for (const key of Object.keys(message)) {
    if (key !== "messageContextInfo") return key;
  }
  return null;
}

function extractText(type: string, node: unknown): string | null {
  if (type === "conversation") return typeof node === "string" ? node : null;
  if (!isRecord(node)) return null;
  if (type === "extendedTextMessage") {
    return typeof node.text === "string" ? node.text : null;
  }
  if (["imageMessage", "videoMessage", "documentMessage"].includes(type)) {
    return typeof node.caption === "string" ? node.caption : null;
  }
  if (type.startsWith("pollCreationMessage")) {
    return typeof node.name === "string" ? node.name : null;
  }
  return null;
}

function extractContext(node: unknown): {
  quotedMessageId: string | null;
  quotedSenderJid: string | null;
} {
  if (!isRecord(node) || !isRecord(node.contextInfo)) {
    return { quotedMessageId: null, quotedSenderJid: null };
  }
  const context = node.contextInfo;
  return {
    quotedMessageId:
      typeof context.stanzaId === "string" ? context.stanzaId : null,
    quotedSenderJid:
      typeof context.participant === "string"
        ? normalizeJid(context.participant)
        : null,
  };
}

function senderJid(event: TransportMessageEvent): string | null {
  return event.info.sender ? normalizeJid(event.info.sender) : null;
}

function protocolType(value: unknown, name: string, numeric: number): boolean {
  return value === name || value === name.toLowerCase() || value === numeric;
}

function protocolResult(
  event: TransportMessageEvent,
  node: Record<string, unknown>,
): NormalizeResult {
  const targetKey = isRecord(node.key) ? node.key : null;
  const targetId =
    targetKey && typeof targetKey.id === "string" ? targetKey.id : null;
  if (!targetId) return { action: "skip", reason: "protocol-missing-target" };

  const type = node.type;
  const isGroup = event.info.isGroup || isGroupJid(event.info.chat);
  const isStatus = isStatusJid(event.info.chat);
  const sender = senderJid(event);
  if (protocolType(type, "REVOKE", 0)) {
    return {
      action: "revoke",
      chatJid: normalizeJid(event.info.chat),
      targetId,
      senderJid: sender,
      isGroup,
      isStatus,
    };
  }
  if (protocolType(type, "MESSAGE_EDIT", 14)) {
    const edited = isRecord(node.editedMessage) ? node.editedMessage : null;
    const editedType = edited ? contentType(edited) : null;
    const editedNode = editedType && edited ? edited[editedType] : null;
    return {
      action: "edit",
      chatJid: normalizeJid(event.info.chat),
      targetId,
      text: editedType ? extractText(editedType, editedNode) : null,
      editId: event.info.id,
      senderJid: sender,
      isGroup,
      isStatus,
    };
  }
  return { action: "skip", reason: "protocol-noop" };
}

function reactionResult(
  event: TransportMessageEvent,
  node: Record<string, unknown>,
): NormalizeResult {
  const targetKey = isRecord(node.key) ? node.key : null;
  const targetId =
    targetKey && typeof targetKey.id === "string" ? targetKey.id : null;
  if (!targetId) return { action: "skip", reason: "reaction-missing-target" };
  const isGroup = event.info.isGroup || isGroupJid(event.info.chat);
  const reactor = senderJid(event);
  const reactorToken = reactor ?? (event.info.isFromMe ? "self" : "unknown");
  return {
    action: "store",
    message: {
      chatJid: normalizeJid(event.info.chat),
      messageId: `reaction:${targetId}:${reactorToken}`,
      senderJid: reactor,
      fromMe: event.info.isFromMe,
      timestamp: event.info.timestamp,
      messageType: "reaction",
      text: typeof node.text === "string" ? node.text : "",
      hasMedia: false,
      durationS: null,
      quotedMessageId: targetId,
      quotedSenderJid:
        targetKey && typeof targetKey.participant === "string"
          ? normalizeJid(targetKey.participant)
          : null,
      isGroup,
      isStatus: isStatusJid(event.info.chat),
      pushName: null,
    },
  };
}

export function normalizeWhatsmeowMessage(
  event: TransportMessageEvent,
): NormalizeResult {
  if (!event.info.id || !event.info.chat || !isRecord(event.message)) {
    return { action: "skip", reason: "missing-message-identity" };
  }
  const type = contentType(event.message);
  if (!type) return { action: "skip", reason: "message-metadata-only" };
  const node = event.message[type];
  if (type === "protocolMessage" && isRecord(node)) {
    return protocolResult(event, node);
  }
  if (type === "reactionMessage" && isRecord(node)) {
    return reactionResult(event, node);
  }

  const messageType = CONTENT_TYPES.get(type) ?? "unknown";
  const context = extractContext(node);
  const duration =
    type === "audioMessage" && isRecord(node)
      ? numberValue(node.seconds)
      : null;
  const normalized: NormalizedMessage = {
    chatJid: normalizeJid(event.info.chat),
    messageId: event.info.id,
    senderJid: senderJid(event),
    fromMe: event.info.isFromMe,
    timestamp: numberValue(event.info.timestamp),
    messageType,
    text: extractText(type, node),
    hasMedia: MEDIA_TYPES.has(messageType),
    durationS: duration === null ? null : Math.max(0, Math.floor(duration)),
    quotedMessageId: context.quotedMessageId,
    quotedSenderJid: context.quotedSenderJid,
    isGroup: event.info.isGroup || isGroupJid(event.info.chat),
    isStatus: isStatusJid(event.info.chat),
    pushName: event.info.pushName || null,
  };
  return { action: "store", message: normalized };
}
