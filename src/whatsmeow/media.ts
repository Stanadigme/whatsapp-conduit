import type { IngestDeps } from "../baileys/ingest.js";
import type { NormalizedMessage } from "../ingest/types.js";
import {
  persistAudioIfEnabled,
  toByteCount,
  type AudioSource,
} from "../ingest/audio.js";
import type { TransportMessageEvent } from "../transport/types.js";
import type { WhatsmeowTransport } from "./transport.js";

function audioNode(
  event: TransportMessageEvent,
): Record<string, unknown> | null {
  const node = event.message.audioMessage;
  return typeof node === "object" && node !== null && !Array.isArray(node)
    ? (node as Record<string, unknown>)
    : null;
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
  const node = audioNode(event);
  if (!node) return;

  const source: AudioSource = {
    mimeType: stringField(node, "mimetype"),
    fileName: stringField(node, "fileName"),
    expectedBytes: toByteCount(node.fileLength),
    fetch: () => transport.downloadAny(event.message),
  };

  await persistAudioIfEnabled(source, normalized, deps);
}
