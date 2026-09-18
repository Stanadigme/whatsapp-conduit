import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { downloadMediaMessage, proto, type WASocket, type WAMessage } from "baileys";
import type { MessageRow } from "../db/queries.js";
import type { NormalizedMessage } from "../ingest/types.js";
import { persistAudioIfEnabled, toByteCount, type AudioSource } from "../ingest/audio.js";
import {
  DOWNLOAD_TIMEOUT_MS,
  REUPLOAD_TIMEOUT_MS,
  mediaNode,
  sanitizeMediaError,
  stringField,
  withOverallTimeout,
} from "./media.js";
import type { IngestDeps } from "./ingest.js";

const MEDIA_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "audio",
  "image",
  "video",
  "document",
  "sticker",
]);

/**
 * Reverses `rawJsonOfValue` (src/baileys/ingest.ts): that serializer walks
 * the whole message and turns every `Uint8Array` (mediaKey, fileEncSha256,
 * ...) into a base64 string, so a plain `JSON.parse` leaves those fields as
 * strings and `downloadMediaMessage` cannot decrypt anything with them.
 * `proto.WebMessageInfo.fromObject` is protobufjs's own reverse of that: it
 * knows from the .proto schema which fields are `bytes` and converts a
 * base64 string back to a `Uint8Array`, so there is no hand-maintained list
 * of binary field names to keep in sync here.
 */
export function reconstructMessageFromRawJson(
  rawJson: string | null,
): WAMessage | null {
  if (!rawJson) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const message = proto.WebMessageInfo.fromObject(
      parsed as Record<string, unknown>,
    );
    if (!message.key?.id || !message.message) return null;
    // proto.WebMessageInfo satisfies IWebMessageInfo; WAMessage only adds
    // optional fields (messageStubParameters, category, retryCount) plus a
    // narrower `key` that this early return already guarantees is present.
    return message as unknown as WAMessage;
  } catch {
    return null;
  }
}

function normalizedMessageFromRow(row: MessageRow): NormalizedMessage | null {
  if (!MEDIA_MESSAGE_TYPES.has(row.message_type ?? "")) return null;
  return {
    chatJid: row.chat_jid,
    messageId: row.message_id,
    // Only chatJid/messageId/messageType/durationS reach persistAudioIfEnabled
    // (src/ingest/audio.ts); the rest of NormalizedMessage is structurally
    // required but unused on this path.
    senderJid: row.sender_jid,
    fromMe: row.from_me === 1,
    timestamp: row.timestamp,
    messageType: row.message_type as NormalizedMessage["messageType"],
    text: row.text,
    hasMedia: row.has_media === 1,
    durationS: row.duration_s,
    quotedMessageId: row.quoted_message_id,
    quotedSenderJid: row.quoted_sender_jid,
    isGroup: false,
    isStatus: false,
    pushName: null,
  };
}

/**
 * Attempt to download the media of a message already in the database,
 * using only what was captured in `raw_json` at ingestion time — no live
 * WhatsApp connection is needed or used (see ADR-0035). Returns false
 * without treating it as a failure when there is nothing to attempt: no
 * `raw_json`, no media node, or a message type backfill does not cover.
 *
 * `sock`, when given, wires the same `reuploadRequest` as `media.ts`
 * (ADR-0039): a backfilled voice note whose server-side copy has since
 * expired — exactly the 91 RHSS history vocals this was written for — gets
 * one media-retry round trip before the fetch is given up on.
 */
export async function downloadStoredMedia(
  row: MessageRow,
  deps: IngestDeps,
  sock?: WASocket,
): Promise<boolean> {
  const normalized = normalizedMessageFromRow(row);
  if (!normalized) return false;
  const msg = reconstructMessageFromRawJson(row.raw_json);
  if (!msg) return false;
  const media = mediaNode(msg);
  if (!media) return false;
  const { node } = media;
  if (node.viewOnce === true) return false;

  const ctx = sock
    ? {
        logger: deps.logger,
        reuploadRequest: (message: WAMessage) => sock.updateMediaMessage(message),
      }
    : undefined;
  const timeoutMs = ctx
    ? DOWNLOAD_TIMEOUT_MS + REUPLOAD_TIMEOUT_MS
    : DOWNLOAD_TIMEOUT_MS;

  const source: AudioSource = {
    mediaType: media.mediaType,
    mimeType: stringField(node, "mimetype"),
    fileName: stringField(node, "fileName"),
    expectedBytes: toByteCount(node.fileLength),
    fetch: async () => {
      const stream = await withOverallTimeout(
        downloadMediaMessage(
          msg,
          "stream",
          { options: { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) } },
          ctx,
        ),
        timeoutMs,
      ).catch((error: unknown) => {
        throw sanitizeMediaError(error);
      });
      await mkdir(deps.config.paths.mediaDir, { recursive: true });
      const scratch = join(deps.config.paths.mediaDir, `.${randomUUID()}.part`);
      await pipeline(stream, createWriteStream(scratch));
      return scratch;
    },
  };

  await persistAudioIfEnabled(source, normalized, deps);
  return true;
}
