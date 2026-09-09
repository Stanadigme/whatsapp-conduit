import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Database } from "./index.js";
import { nowSec } from "../util/time.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const AAD_PREFIX = "whatsapp-conduit/outbox/v1";

export interface OutboxOperation {
  /** Stable operation family, for example `message.upsert`. */
  operation: string;
  /** Stable natural key. It is HMACed before it reaches SQLite. */
  dedupeKey: string;
  /** Sensitive serializable content consumed by the future forwarder. */
  payload: unknown;
}

export interface LeasedOutboxOperation {
  id: number;
  operation: string;
  payload: unknown;
  attempts: number;
  leaseToken: string;
}

export interface LeaseOutboxOptions {
  /** Maximum operations to hand to one forwarder pass. */
  limit?: number | undefined;
  /** Lease duration in seconds before a crashed forwarder can be resumed. */
  leaseS?: number | undefined;
  /** Injectable clock for deterministic tests. */
  now?: number | undefined;
}

interface OutboxRow {
  id: number;
  operation: string;
  dedupe_key: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  attempts: number;
}

/**
 * Load or create the 256-bit local outbox key.
 *
 * The key is deliberately a local owner-only file. Production still requires
 * the encrypted isolated volume specified by ADR-0028; this prevents a copied
 * SQLite file alone from revealing queued payloads without adding a hosted key
 * dependency.
 */
export function ensureOutboxKey(path: string): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("outbox key file must not be a symbolic link");
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
    const key = readFileSync(path);
    if (key.length !== KEY_BYTES) throw new Error("outbox key file is invalid");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const key = randomBytes(KEY_BYTES);
  try {
    writeFileSync(path, key, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return ensureOutboxKey(path);
  }
}

/** Add or replace an operation atomically with the caller's SQLite writes. */
export function enqueueOutbox(
  db: Database,
  key: Buffer,
  input: OutboxOperation,
  createdAt = nowSec(),
): number {
  validateKey(key);
  if (!input.operation) throw new Error("outbox operation is required");
  if (!input.dedupeKey) throw new Error("outbox dedupe key is required");

  const dedupeKey = opaqueDedupeKey(key, input.dedupeKey);
  const encrypted = encryptPayload(
    key,
    input.operation,
    dedupeKey,
    input.payload,
  );
  db.prepare(
    `insert into outbox (
       operation, dedupe_key, nonce, ciphertext, auth_tag, created_at
     ) values (
       @operation, @dedupeKey, @nonce, @ciphertext, @authTag, @createdAt
     ) on conflict (dedupe_key) do update set
       operation = excluded.operation,
       nonce = excluded.nonce,
       ciphertext = excluded.ciphertext,
       auth_tag = excluded.auth_tag,
       created_at = excluded.created_at,
       attempts = 0,
       lease_token = null,
       lease_until = null`,
  ).run({
    operation: input.operation,
    dedupeKey,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    authTag: encrypted.authTag,
    createdAt,
  });
  const row = db
    .prepare<
      [Buffer],
      { id: number }
    >("select id from outbox where dedupe_key = ?")
    .get(dedupeKey);
  if (!row) throw new Error("outbox operation was not persisted");
  return row.id;
}

/**
 * Lease the oldest available operations. A lease survives a process crash and
 * expires deterministically, so the next forwarder pass can retry it.
 */
export function leaseOutbox(
  db: Database,
  key: Buffer,
  options: LeaseOutboxOptions = {},
): LeasedOutboxOperation[] {
  validateKey(key);
  const limit = options.limit ?? 100;
  const leaseS = options.leaseS ?? 60;
  const now = options.now ?? nowSec();
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("outbox lease limit must be a positive integer");
  }
  if (!Number.isInteger(leaseS) || leaseS < 1) {
    throw new Error("outbox lease duration must be a positive integer");
  }

  return db.transaction(() => {
    const rows = db
      .prepare<[number, number], OutboxRow>(
        `select id, operation, dedupe_key, nonce, ciphertext, auth_tag, attempts
         from outbox
         where lease_until is null or lease_until <= ?
         order by id asc
         limit ?`,
      )
      .all(now, limit);
    const leaseToken = randomUUID();
    const leaseUntil = now + leaseS;
    const lease = db.prepare<[string, number, number, number]>(
      `update outbox
       set lease_token = ?, lease_until = ?, attempts = attempts + 1
       where id = ? and (lease_until is null or lease_until <= ?)`,
    );

    const leased: LeasedOutboxOperation[] = [];
    for (const row of rows) {
      if (lease.run(leaseToken, leaseUntil, row.id, now).changes !== 1)
        continue;
      const payload = decryptPayload(key, row.operation, row.dedupe_key, row);
      leased.push({
        id: row.id,
        operation: row.operation,
        payload,
        attempts: row.attempts + 1,
        leaseToken,
      });
    }
    return leased;
  })();
}

/** Delete only an operation that the calling forwarder currently owns. */
export function acknowledgeOutbox(
  db: Database,
  id: number,
  leaseToken: string,
): boolean {
  return (
    db
      .prepare<
        [number, string]
      >("delete from outbox where id = ? and lease_token = ?")
      .run(id, leaseToken).changes === 1
  );
}

/** Release a failed operation without discarding it. */
export function retryOutbox(
  db: Database,
  id: number,
  leaseToken: string,
): boolean {
  return (
    db
      .prepare<[number, string]>(
        `update outbox set lease_token = null, lease_until = null
         where id = ? and lease_token = ?`,
      )
      .run(id, leaseToken).changes === 1
  );
}

export interface OutboxCounts {
  pending: number;
  encryptedBytes: number;
}

/** Queue accounting used by the future explicit saturation policy. */
export function countOutbox(db: Database): OutboxCounts {
  const row = db
    .prepare<[], { pending: number; encrypted_bytes: number }>(
      `select count(*) as pending,
              coalesce(sum(length(nonce) + length(ciphertext) + length(auth_tag)), 0)
                as encrypted_bytes
       from outbox`,
    )
    .get();
  return {
    pending: row?.pending ?? 0,
    encryptedBytes: row?.encrypted_bytes ?? 0,
  };
}

function validateKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error("outbox key must be 32 bytes");
}

function opaqueDedupeKey(key: Buffer, dedupeKey: string): Buffer {
  return createHmac("sha256", key)
    .update("whatsapp-conduit/outbox/dedupe/v1\\0")
    .update(dedupeKey)
    .digest();
}

function aad(operation: string, dedupeKey: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${AAD_PREFIX}\\0${operation}\\0`, "utf8"),
    dedupeKey,
  ]);
}

function encryptPayload(
  key: Buffer,
  operation: string,
  dedupeKey: Buffer,
  payload: unknown,
): { nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
  let plaintext: string | undefined;
  try {
    plaintext = JSON.stringify(payload);
  } catch {
    throw new Error("outbox payload is not JSON serializable");
  }
  if (plaintext === undefined) throw new Error("outbox payload is required");

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad(operation, dedupeKey));
  return {
    nonce,
    ciphertext: Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]),
    authTag: cipher.getAuthTag(),
  };
}

function decryptPayload(
  key: Buffer,
  operation: string,
  dedupeKey: Buffer,
  row: Pick<OutboxRow, "nonce" | "ciphertext" | "auth_tag">,
): unknown {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, row.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad(operation, dedupeKey));
    decipher.setAuthTag(row.auth_tag);
    return JSON.parse(
      Buffer.concat([
        decipher.update(row.ciphertext),
        decipher.final(),
      ]).toString("utf8"),
    ) as unknown;
  } catch {
    throw new Error("outbox payload authentication failed");
  }
}
