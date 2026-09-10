import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { extname, join } from "node:path";
import type { IngestDeps } from "../baileys/ingest.js";
import { chatExposureAllowed } from "../db/directory.js";
import { getAttachment, upsertAttachment } from "../db/queries.js";
import type { NormalizedMessage } from "../ingest/types.js";

/**
 * A transport-independent handle on one audio attachment.
 *
 * `fetch` yields a path rather than a payload on purpose: the size cap has to
 * be enforceable without the whole file resident in memory, and both
 * transports already produce a file — whatsmeow shells out to one, Baileys
 * streams to one.
 */
export interface AudioSource {
  /** WhatsApp normalized media kind; defaults to audio for existing callers. */
  mediaType?: "audio" | "image" | "video" | "document" | "sticker";
  mimeType: string | null;
  fileName: string | null;
  /** Declared size, when the message carries one. Checked before fetching. */
  expectedBytes: number | null;
  /** Download to a temporary file and return its path. Called once per attempt. */
  fetch: () => Promise<string>;
}

/** Coerce a protobuf size field (number, Long, or absent) to a byte count. */
export function toByteCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Extension for the content-addressed local filename `${sha256}${extension}`.
 * Exported so a read path (Postgres carries no `file_path`, see
 * postgres-migrations/0002) can recompute the same on-disk name from
 * attachment metadata instead of trusting a stored path.
 */
export function extensionFor(source: AudioSource): string {
  const mime = source.mimeType ?? "";
  if (mime.includes("ogg") || mime.includes("opus")) return ".opus";
  const extension = source.fileName
    ? extname(source.fileName).toLowerCase()
    : "";
  if (extension && /^[.][a-z0-9]{1,8}$/.test(extension)) return extension;
  return source.mediaType === "audio" || source.mediaType === undefined
    ? ".audio"
    : ".bin";
}

async function removeTemp(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

/**
 * Downloads already running, keyed by message.
 *
 * Baileys delivers the same message twice in normal operation (`notify` then
 * `append`), and both deliveries pass the resumable check before either has
 * written `downloaded_at`. Without this, two downloads race onto the same
 * content-addressed temporary path and corrupt the stored file.
 */
const inFlight = new Set<string>();

/**
 * Persist an audio attachment after its message row is committed.
 *
 * Callers invoke this fire-and-forget so a media outage cannot block message
 * ingestion, and only once the message row exists: `attachments` carries a
 * foreign key onto `messages`.
 *
 * Media is content-addressed by SHA-256, so the same voice note forwarded to
 * several chats is stored once.
 */
export async function persistAudioIfEnabled(
  source: AudioSource,
  normalized: NormalizedMessage,
  deps: IngestDeps,
): Promise<void> {
  const mediaType = source.mediaType ?? "audio";
  if (
    !deps.config.privacy.storeMedia ||
    !new Set(["audio", "image", "video", "document", "sticker"]).has(
      normalized.messageType,
    )
  )
    return;
  // Discovery persists a chat's messages before anyone authorises it, so that
  // it can be found and reviewed. Media is different: the file is the content,
  // it is never exposed and never transcribed for an unauthorised chat, and
  // nothing evicts it. Downloading it would accumulate private recordings with
  // no use for them.
  if (!chatExposureAllowed(deps.db, deps.accountId, normalized.chatJid)) {
    deps.logger.debug({ reason: "chat-not-allowed" }, "skipped media download");
    return;
  }
  if (
    mediaType === "audio" &&
    normalized.durationS !== null &&
    normalized.durationS > deps.config.media.maxAudioDurationS
  ) {
    deps.logger.debug({ reason: "audio-too-long" }, "skipped audio download");
    return;
  }
  // The only point where the size cap costs no bandwidth.
  if (
    source.expectedBytes !== null &&
    source.expectedBytes > deps.config.media.maxAudioBytes
  ) {
    deps.logger.debug({ reason: "audio-too-large" }, "skipped audio download");
    return;
  }

  const existing = getAttachment(
    deps.db,
    deps.accountId,
    normalized.chatJid,
    normalized.messageId,
  );
  if (existing?.file_path && existing.downloaded_at !== null) {
    try {
      await access(existing.file_path);
      return;
    } catch {
      // The database row is retained, but a missing file is resumable.
    }
  }

  const key = `${normalized.chatJid}\0${normalized.messageId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    upsertAttachment(deps.db, {
      accountId: deps.accountId,
      chatJid: normalized.chatJid,
      messageId: normalized.messageId,
      mediaType,
      mimeType: source.mimeType,
      fileName: source.fileName,
    });

    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= deps.config.media.maxAttempts;
      attempt += 1
    ) {
      let temporaryPath: string | undefined;
      try {
        temporaryPath = await source.fetch();
        const details = await stat(temporaryPath);
        if (details.size > deps.config.media.maxAudioBytes) {
          throw new Error("audio exceeds configured size limit");
        }
        const hash = await sha256File(temporaryPath);
        await mkdir(deps.config.paths.mediaDir, { recursive: true });
        const destination = join(
          deps.config.paths.mediaDir,
          `${hash}${extensionFor(source)}`,
        );
        try {
          await access(destination);
        } catch {
          const temporaryDestination = join(
            deps.config.paths.mediaDir,
            `.${hash}.${process.pid}.${attempt}.tmp`,
          );
          await copyFile(temporaryPath, temporaryDestination);
          await rename(temporaryDestination, destination).catch(async () => {
            await removeTemp(temporaryDestination);
          });
        }
        upsertAttachment(deps.db, {
          accountId: deps.accountId,
          chatJid: normalized.chatJid,
          messageId: normalized.messageId,
          mediaType,
          mimeType: source.mimeType,
          fileName: source.fileName,
          filePath: destination,
          sha256: hash,
          sizeBytes: details.size,
          downloadedAt: Math.floor(Date.now() / 1000),
        });
        await removeTemp(temporaryPath);
        return;
      } catch (error) {
        lastError = error;
        if (temporaryPath) await removeTemp(temporaryPath);
        if (attempt < deps.config.media.maxAttempts) continue;
      }
    }
    deps.logger.warn(
      {
        err: lastError instanceof Error ? lastError.message : String(lastError),
        attempts: deps.config.media.maxAttempts,
      },
      "audio download failed",
    );
  } finally {
    inFlight.delete(key);
  }
}
