import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  downloadMediaMessage,
  normalizeMessageContent,
  type WASocket,
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
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Extra budget granted only when a media-retry round trip (ADR-0039) is on
 * the table: Baileys' `sock.updateMediaMessage` waits on a
 * `messages.media-update` event through `bindWaitForEvent`/`promiseTimeout`
 * called with no `ms` argument (baileys/lib/Utils/generics.js) — that wait
 * has no timeout of its own. `AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)` only
 * bounds the initial stream fetch; without this second bound a phone that
 * never answers the retry would hang the fetch forever.
 */
export const REUPLOAD_TIMEOUT_MS = 60_000;

/**
 * Bounds the whole `downloadMediaMessage` call — initial attempt plus any
 * media-retry round trip — so it can never hang past `ms` regardless of what
 * Baileys itself does or does not time out internally. Exported so
 * `media-backfill.ts` shares the same bound instead of a second copy.
 */
export async function withOverallTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`media download timed out after ${String(ms)}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `downloadMediaMessage` folds the full mmg.whatsapp.net URL — query string
 * included — straight into its error message (Baileys,
 * `messages-media.js`: `` `Failed to fetch stream from ${url}` ``), and that
 * URL carries a live `oh=` access token. The message-reupload retry can
 * throw its own Boom with a device-reported reason, no URL involved, but is
 * sanitized the same way for uniformity. Both eventually reach
 * `download_last_error` (`src/ingest/audio.ts`), which the dashboard reads
 * back — strip the query string and keep only the first line before that
 * happens.
 */
export function sanitizeMediaError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0] ?? message;
  const withoutQuery = firstLine.split("?")[0] ?? firstLine;
  return new Error(withoutQuery);
}

export function mediaNode(msg: WAMessage): {
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

export function stringField(
  node: Record<string, unknown>,
  key: string,
): string | null {
  return typeof node[key] === "string" && node[key].length > 0
    ? node[key]
    : null;
}

/** HTTP statuses for which WhatsApp's CDN has dropped the media and only the
 * phone can bring it back (Baileys' own `REUPLOAD_REQUIRED_STATUS`). */
const REUPLOAD_REQUIRED_STATUS = new Set([404, 410]);

/**
 * One bounded media download, with the ADR-0039 media-retry round trip when
 * `sock` is given. Shared by the live path and the backfill so both behave
 * identically.
 *
 * Baileys' `downloadMediaMessage` accepts a `reuploadRequest` context and is
 * passed one here, but its retry condition reads `error.status`, which the
 * Boom it throws never sets (`error.output.statusCode` does) — so upstream
 * never actually retries. The catch below does what upstream intends: on a
 * 404/410, ask the phone (`sock.updateMediaMessage`, which refreshes the
 * message's media keys and URL) and download once more. Keep the `ctx`
 * argument anyway so an upstream fix simply short-circuits ours.
 */
export async function fetchMediaStream(
  msg: WAMessage,
  deps: IngestDeps,
  sock?: WASocket,
): Promise<Awaited<ReturnType<typeof downloadMediaMessage>>> {
  const options = { options: { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) } };
  const ctx = sock
    ? {
        logger: deps.logger,
        reuploadRequest: (message: WAMessage) => sock.updateMediaMessage(message),
      }
    : undefined;
  const attempt = async (): Promise<Awaited<ReturnType<typeof downloadMediaMessage>>> => {
    try {
      return await downloadMediaMessage(msg, "stream", options, ctx);
    } catch (error: unknown) {
      const status = (error as { output?: { statusCode?: unknown } }).output?.statusCode;
      if (!sock || typeof status !== "number" || !REUPLOAD_REQUIRED_STATUS.has(status)) {
        throw error;
      }
      deps.logger.info({ status }, "media expired server-side, requesting reupload");
      const refreshed = await sock.updateMediaMessage(msg);
      return downloadMediaMessage(refreshed, "stream", options);
    }
  };
  return withOverallTimeout(
    attempt(),
    sock ? DOWNLOAD_TIMEOUT_MS + REUPLOAD_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS,
  ).catch((error: unknown) => {
    throw sanitizeMediaError(error);
  });
}

/**
 * Download an audio attachment after its message row is committed.
 *
 * `downloadMediaMessage` is a read: it decrypts the media stream the message
 * already points at.
 *
 * `sock`, when given, wires Baileys' `reuploadRequest` (ADR-0039): a media
 * whose server-side copy has expired triggers a media-retry node asking the
 * phone to reupload it, then retries the download once. It is an outbound
 * action on the client's account, but it sends nothing to any interlocutor,
 * marks nothing read, and sets no presence — see ADR-0039 for why this does
 * not touch invariants 1-3. `sock` is optional because it is not part of
 * `IngestDeps` (the socket is reconnect-scoped, obtained by the caller); a
 * caller with no live socket in scope still gets a plain download, exactly
 * today's behaviour.
 *
 * Streamed to a scratch file rather than buffered: a reconnection delivers a
 * burst of offline messages at once, and holding every payload in memory to
 * check the size cap afterwards defeats the cap.
 */
export async function downloadAudioIfEnabled(
  msg: WAMessage,
  normalized: NormalizedMessage,
  deps: IngestDeps,
  sock?: WASocket,
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
}
