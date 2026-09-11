import { lstatSync } from "node:fs";
import type { Readable } from "node:stream";
import { Storage, type Bucket } from "@google-cloud/storage";
import type { GcsPersistenceConfig } from "../config.js";
import type { AudioExtensionInput } from "../ingest/audio.js";
import { extensionFor } from "../ingest/audio.js";

/** Every remote call is bounded: the alpha never blocks on a slow bucket. */
export const GCS_TIMEOUT_MS = 10_000;

/**
 * Refuse a service-account key readable by another local account, the same
 * refusal-not-repair posture as db/postgres.ts's readSecretFile: a wrong
 * permission is an operator mistake that must surface at startup, not be
 * silently tightened behind their back.
 */
function checkCredentialsFilePermissions(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(
      "persistence.gcs.credentials_file must not be a symbolic link",
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      "persistence.gcs.credentials_file must not be readable by group or others (0600)",
    );
  }
}

/** Open the client's bucket handle. The SDK reads the key file itself. */
export function createGcsBucket(config: GcsPersistenceConfig): Bucket {
  checkCredentialsFilePermissions(config.credentialsFile);
  const storage = new Storage({ keyFilename: config.credentialsFile });
  return storage.bucket(config.bucket);
}

// One bucket handle per process: constructing the client re-reads and
// re-authenticates the credentials file, which a per-call instance would pay
// for on every upload and every read. Both the ingestion daemon and a reader
// process (MCP, dashboard, export) each keep their own cache, since each is a
// separate process — same shape as postgres-projection.ts's `active` pool.
let cachedBucket: Bucket | null = null;
let cachedBucketConfig: GcsPersistenceConfig | null = null;

/** Reference equality on `config` is enough: it is loaded once per process. */
export function getOrCreateGcsBucket(config: GcsPersistenceConfig): Bucket {
  if (cachedBucket && cachedBucketConfig === config) return cachedBucket;
  cachedBucket = createGcsBucket(config);
  cachedBucketConfig = config;
  return cachedBucket;
}

/**
 * Object key for one attachment's bytes: content-addressed, exactly like the
 * local cache filename (src/ingest/audio.ts), so it is derived rather than
 * stored and can never drift from the file it names. The account prefix
 * keeps the bucket layout tenant-safe even though the alpha bucket is
 * dedicated to one account.
 */
export function gcsObjectKey(
  accountId: string,
  sha256: string,
  meta: AudioExtensionInput,
): string {
  return `${accountId}/${sha256}${extensionFor(meta)}`;
}

/** Upload one local file, keyed by its content hash. Overwrite-safe: the key IS the content. */
export async function uploadMediaToGcs(
  bucket: Bucket,
  objectKey: string,
  localPath: string,
  mimeType: string | null,
): Promise<void> {
  await bucket.upload(localPath, {
    destination: objectKey,
    // Small voice notes and images: resumable upload's extra round trips cost
    // more than they save at this size.
    resumable: false,
    timeout: GCS_TIMEOUT_MS,
    ...(mimeType ? { metadata: { contentType: mimeType } } : {}),
  });
}

/** Stream one object's bytes, for the runtime to proxy — never a signed URL. */
export function openGcsMediaStream(bucket: Bucket, objectKey: string): Readable {
  return bucket.file(objectKey).createReadStream();
}
