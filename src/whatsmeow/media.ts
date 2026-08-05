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
import { getAttachment, upsertAttachment } from "../db/queries.js";
import type { NormalizedMessage } from "../ingest/types.js";
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

function extensionFor(node: Record<string, unknown>): string {
  const mime = stringField(node, "mimetype") ?? "";
  if (mime.includes("ogg") || mime.includes("opus")) return ".opus";
  const name = stringField(node, "fileName");
  const extension = name ? extname(name).toLowerCase() : "";
  return extension && /^[.][a-z0-9]{1,8}$/.test(extension)
    ? extension
    : ".audio";
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function removeTemp(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/**
 * Download an audio attachment after its message row is committed. This is
 * deliberately fire-and-forget from the message handler so a media outage
 * cannot block message ingestion.
 */
export async function downloadAudioIfEnabled(
  transport: WhatsmeowTransport,
  event: TransportMessageEvent,
  normalized: NormalizedMessage,
  deps: IngestDeps,
): Promise<void> {
  if (!deps.config.privacy.storeMedia || normalized.messageType !== "audio")
    return;
  if (
    normalized.durationS !== null &&
    normalized.durationS > deps.config.media.maxAudioDurationS
  ) {
    deps.logger.debug({ reason: "audio-too-long" }, "skipped audio download");
    return;
  }

  const node = audioNode(event);
  if (!node) return;
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
  upsertAttachment(deps.db, {
    accountId: deps.accountId,
    chatJid: normalized.chatJid,
    messageId: normalized.messageId,
    mediaType: "audio",
    mimeType: stringField(node, "mimetype"),
    fileName: stringField(node, "fileName"),
  });

  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= deps.config.media.maxAttempts;
    attempt += 1
  ) {
    let temporaryPath: string | undefined;
    try {
      temporaryPath = await transport.downloadAny(event.message);
      const details = await stat(temporaryPath);
      if (details.size > deps.config.media.maxAudioBytes) {
        throw new Error("audio exceeds configured size limit");
      }
      const hash = await sha256File(temporaryPath);
      await mkdir(deps.config.paths.mediaDir, { recursive: true });
      const destination = join(
        deps.config.paths.mediaDir,
        `${hash}${extensionFor(node)}`,
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
        mediaType: "audio",
        mimeType: stringField(node, "mimetype"),
        fileName: stringField(node, "fileName"),
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
}
