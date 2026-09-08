import type { IngestDeps } from "../baileys/ingest.js";
import type { NormalizedMessage } from "../ingest/types.js";
import {
  persistAudioIfEnabled,
  toByteCount,
  type AudioSource,
} from "../ingest/audio.js";
import type { TransportMessageEvent } from "../transport/types.js";
import type { WhatsmeowTransport } from "./transport.js";

function mediaNode(event: TransportMessageEvent): {
  mediaType: "audio" | "image" | "video" | "document" | "sticker";
  node: Record<string, unknown>;
} | null {
  const candidates = [
    ["audio", event.message.audioMessage],
    ["image", event.message.imageMessage],
    ["video", event.message.videoMessage],
    ["document", event.message.documentMessage],
    ["sticker", event.message.stickerMessage],
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
 * whatsmeow-node shells out and already hands back a temporary file, which is
 * exactly the contract the shared persistence path wants.
 */
export async function downloadAudioIfEnabled(
  transport: WhatsmeowTransport,
  event: TransportMessageEvent,
  normalized: NormalizedMessage,
  deps: IngestDeps,
): Promise<void> {
  const media = mediaNode(event);
  if (!media) return;

  const source: AudioSource = {
    mediaType: media.mediaType,
    mimeType: stringField(media.node, "mimetype"),
    fileName: stringField(media.node, "fileName"),
    expectedBytes: toByteCount(media.node.fileLength),
    fetch: () => transport.downloadAny(event.message),
  };

  await persistAudioIfEnabled(source, normalized, deps);
}
