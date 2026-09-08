import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  downloadMediaMessage,
  normalizeMessageContent,
  type WAMessage,
} from "baileys";
import type { NormalizedMessage } from "../ingest/types.js";
import {
  persistAudioIfEnabled,
  toByteCount,
  type AudioSource,
} from "../ingest/audio.js";
import type { IngestDeps } from "./ingest.js";

/** Give up on a stalled media fetch rather than hold the slot forever. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

function mediaNode(msg: WAMessage): {
  mediaType: "audio" | "image" | "video" | "document" | "sticker";
  node: Record<string, unknown>;
} | null {
  // Unwrap ephemeral / view-once envelopes the same way normalization does,
  // otherwise a disappearing voice note looks like it carries no audio node.
  const content = normalizeMessageContent(msg.message);
  const candidates = [
    ["audio", content?.audioMessage],
    ["image", content?.imageMessage],
    ["video", content?.videoMessage],
    ["document", content?.documentMessage],
    ["sticker", content?.stickerMessage],
  ] as const;
  for (const [mediaType, node] of candidates) {
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      return { mediaType, node: node as Record<string, unknown> };
    }
  }
  return null;
}

function stringField(
  node: Record<string, unknown>,
  key: string,
): string | null {
  return typeof node[key] === "string" && node[key].length > 0
    ? node[key]
    : null;
}

/**
 * Download an audio attachment after its message row is committed.
 *
 * `downloadMediaMessage` is a read: it decrypts the media stream the message
 * already points at.
 *
 * No `reuploadRequest` is wired in on purpose. Baileys would use it to recover
 * media that has expired server-side, but doing so puts a media-retry node on
 * the wire. That is not one of the calls the observe-only invariants forbid,
 * and it is invisible to the conversation, but it is still an outbound action
 * on the client's account — so it stays off until someone decides otherwise.
 * The cost is that media expired on WhatsApp's servers is simply not
 * recovered; a voice note ingested live is unaffected.
 *
 * Streamed to a scratch file rather than buffered: a reconnection delivers a
 * burst of offline messages at once, and holding every payload in memory to
 * check the size cap afterwards defeats the cap.
 */
export async function downloadAudioIfEnabled(
  msg: WAMessage,
  normalized: NormalizedMessage,
  deps: IngestDeps,
): Promise<void> {
  const media = mediaNode(msg);
  if (!media) return;
  const { node } = media;
  // View-once audio is meant to disappear. Archiving it permanently is a
  // posture change nobody decided, so leave it alone.
  if (node.viewOnce === true) {
    deps.logger.debug({ reason: "audio-view-once" }, "skipped audio download");
    return;
  }

  const source: AudioSource = {
    mediaType: media.mediaType,
    mimeType: stringField(node, "mimetype"),
    fileName: stringField(node, "fileName"),
    expectedBytes: toByteCount(node.fileLength),
    fetch: async () => {
      const stream = await downloadMediaMessage(msg, "stream", {
        options: { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
      });
      await mkdir(deps.config.paths.mediaDir, { recursive: true });
      const scratch = join(deps.config.paths.mediaDir, `.${randomUUID()}.part`);
      await pipeline(stream, createWriteStream(scratch));
      return scratch;
    },
  };

  await persistAudioIfEnabled(source, normalized, deps);
}
