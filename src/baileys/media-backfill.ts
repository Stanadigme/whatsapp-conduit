import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { proto, type WASocket, type WAMessage } from "baileys";
import type { MessageRow } from "../db/queries.js";
import type { NormalizedMessage } from "../ingest/types.js";
import { persistAudioIfEnabled, toByteCount, type AudioSource } from "../ingest/audio.js";
import {
  mediaNode,
  stringField,
  fetchMediaStream,
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

  const source: AudioSource = {
    mediaType: media.mediaType,
    mimeType: stringField(node, "mimetype"),
    fileName: stringField(node, "fileName"),
    expectedBytes: toByteCount(node.fileLength),
    fetch: async () => {
      // The directory first: Baileys hands back a Transform that is already
      // being piped into, so any `await` between receiving it and `pipeline`
      // leaves a window where a short body reaches `final()` and emits
      // 'error' with no listener — which takes the whole daemon down.
      await mkdir(deps.config.paths.mediaDir, { recursive: true });
      const scratch = join(deps.config.paths.mediaDir, `.${randomUUID()}.part`);
      const stream = await fetchMediaStream(msg, deps, sock);
      await pipeline(stream, createWriteStream(scratch));
      return scratch;
    },
  };

  await persistAudioIfEnabled(source, normalized, deps);
  return true;
}
