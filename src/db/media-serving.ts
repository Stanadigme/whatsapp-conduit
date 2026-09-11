import { existsSync, createReadStream } from "node:fs";
import { resolve as resolvePath, relative } from "node:path";
import type { Readable } from "node:stream";
import type { Config } from "../config.js";
import {
  contentAddressedMediaPath,
  type AudioExtensionInput,
} from "../ingest/audio.js";
import { gcsObjectKey, getOrCreateGcsBucket, openGcsMediaStream } from "./gcs.js";
import type { AttachmentRow } from "./queries.js";

/** The attachment fields both backends already fetch, needed to serve bytes. */
export interface AttachmentMediaColumns extends AudioExtensionInput {
  sha256: string | null;
  gcsUploadedAt: number | null;
  sizeBytes: number | null;
}

const AUDIO_MEDIA_TYPES = [
  "audio",
  "image",
  "video",
  "document",
  "sticker",
] satisfies Array<NonNullable<AudioExtensionInput["mediaType"]>>;

/** Adapts db/queries.ts's snake_case AttachmentRow to this module's shape. */
export function fromAttachmentRow(row: AttachmentRow): AttachmentMediaColumns {
  const mediaType = (AUDIO_MEDIA_TYPES as readonly string[]).includes(
    row.media_type ?? "",
  )
    ? (row.media_type as NonNullable<AudioExtensionInput["mediaType"]>)
    : undefined;
  return {
    sha256: row.sha256,
    mimeType: row.mime_type,
    fileName: row.file_name,
    gcsUploadedAt: row.gcs_uploaded_at,
    sizeBytes: row.size_bytes,
    ...(mediaType ? { mediaType } : {}),
  };
}

export interface LocalMediaFile {
  path: string;
  mimeType: string | null;
  fileName: string | null;
}

export interface MediaStream {
  stream: Readable;
  mimeType: string | null;
  fileName: string | null;
  /** From the already-verified download, not a fresh stat/metadata call. */
  sizeBytes: number | null;
  /** Fallback download name when fileName is unknown. */
  sha256: string | null;
}

/** Reject a path that would escape the configured media root (defense in depth). */
function withinMediaRoot(mediaDir: string, path: string): boolean {
  const mediaRoot = resolvePath(mediaDir);
  return !relative(mediaRoot, resolvePath(path)).startsWith("..");
}

/**
 * Whether an attachment's bytes can actually be served right now. Once GCS is
 * configured (ADR-0033 phase 3), that upload confirmation is the only source
 * of truth — the local file is a transient download buffer, not something a
 * reader should trust on its own once a client bucket owns the bytes.
 */
export function attachmentAvailable(
  config: Config,
  attachment: AttachmentMediaColumns,
): boolean {
  if (config.persistence.gcs) return attachment.gcsUploadedAt !== null;
  return resolveLocalMediaFile(config, attachment) !== null;
}

/** Local-disk path, recomputed from content (never trusted from a stored value). */
export function resolveLocalMediaFile(
  config: Config,
  attachment: AttachmentMediaColumns,
): LocalMediaFile | null {
  const path = contentAddressedMediaPath(
    config.paths.mediaDir,
    attachment.sha256,
    attachment,
  );
  if (!path || !withinMediaRoot(config.paths.mediaDir, path) || !existsSync(path)) {
    return null;
  }
  return { path, mimeType: attachment.mimeType, fileName: attachment.fileName };
}

/**
 * Open a stream for one attachment's bytes, from GCS once configured and
 * confirmed uploaded, from local disk otherwise — the one place a dashboard
 * download route needs to know which. Never returns a URL or an object key:
 * the runtime always proxies the bytes itself (ADR-0033).
 */
export function openAttachmentStream(
  config: Config,
  accountId: string,
  attachment: AttachmentMediaColumns,
): MediaStream | null {
  const gcs = config.persistence.gcs;
  if (gcs) {
    if (attachment.gcsUploadedAt === null || !attachment.sha256) return null;
    const objectKey = gcsObjectKey(accountId, attachment.sha256, attachment);
    return {
      stream: openGcsMediaStream(getOrCreateGcsBucket(gcs), objectKey),
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
    };
  }
  const local = resolveLocalMediaFile(config, attachment);
  if (!local) return null;
  return {
    stream: createReadStream(local.path),
    mimeType: local.mimeType,
    fileName: local.fileName,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
  };
}
