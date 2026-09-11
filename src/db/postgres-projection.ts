import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { Database } from "./index.js";
import { createPostgresPool, POSTGRES_TIMEOUT_MS } from "./postgres.js";

/**
 * Direct client-database projection for the alpha profile (ADR-0033).
 *
 * Deliberate limits, all of them accepted by that ADR:
 *   * the queue is in memory. It is not durable, not replayed and not resumed
 *     after a restart. A refused write is lost remotely and logged once;
 *   * nothing here reports success to a user-visible surface, so a missing
 *     remote row is never presented as present;
 *   * SQLite stays the synchronous write path. A slow or dead VPS delays this
 *     queue, never ingestion.
 *
 * Jobs carry natural keys only and re-read SQLite when they run, so a rolled
 * back transaction projects the state that actually survived, and repeated
 * events on one key collapse into a single write.
 */

export interface PostgresProjectionClient {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
  release(destroy?: Error): void;
}

export interface PostgresProjectionPool {
  connect(): Promise<PostgresProjectionClient>;
  end(): Promise<void>;
}

type Job =
  | { kind: "chat"; chatJid: string }
  | { kind: "message"; chatJid: string; messageId: string }
  | { kind: "entity"; canonicalJid: string }
  | { kind: "member"; groupJid: string; memberJid: string }
  | { kind: "group-members"; groupJid: string }
  | { kind: "history-job"; jobId: string };

interface QueuedJob {
  db: Database;
  accountId: string;
  job: Job;
}

type Row = Record<string, unknown>;

/**
 * SQLite stores booleans as 0/1. The client schema uses real booleans, so the
 * few flag columns are converted by name rather than by a per-table mapping.
 */
const BOOLEAN_COLUMNS: ReadonlySet<string> = new Set([
  "is_group",
  "is_status",
  "is_blocked",
  "is_allowed",
  "from_me",
  "has_media",
  "is_active",
  "coverage_complete",
]);

const ACCOUNT_SQL = `select id, label, self_jid, phone_number, created_at, updated_at
  from accounts where id = ?`;

const CHAT_SQL = `select account_id, jid, name, push_name, is_group, is_status,
    is_blocked, is_allowed, discovered_at, updated_at, last_message_ts, raw_json
  from chats where account_id = ? and jid = ?`;

const CHAT_STATS_SQL = `select account_id, chat_jid, message_count,
    media_message_count, oldest_message_ts, newest_message_ts, updated_at
  from chat_message_stats where account_id = ? and chat_jid = ?`;

const MESSAGE_SQL = `select account_id, chat_jid, message_id, sender_jid, from_me,
    timestamp, received_at, message_type, text, normalized_text, has_media,
    duration_s, ingestion_source, quoted_message_id, quoted_sender_jid,
    edited_message_id, deleted_at, raw_json
  from messages where account_id = ? and chat_jid = ? and message_id = ?`;

// No file_path: the bytes belong in the client bucket, not on our disk.
// gcs_uploaded_at, unlike downloaded_at, is genuinely about that bucket: it is
// how a read path knows the client's own copy exists, once phase 3 is active.
const ATTACHMENTS_SQL = `select account_id, chat_jid, message_id, attachment_index,
    media_type, mime_type, file_name, sha256, size_bytes, downloaded_at,
    gcs_uploaded_at, raw_json
  from attachments where account_id = ? and chat_jid = ? and message_id = ?`;

const TRANSCRIPTION_SQL = `select account_id, chat_jid, message_id, audio_sha256,
    text_raw, text_corrected, language, confidence, engine, engine_model,
    lexicon_version, duration_s, cost_usd, transcribed_at, raw_json
  from transcriptions where account_id = ? and chat_jid = ? and message_id = ?`;

const TRANSCRIPTION_JOB_SQL = `select account_id, chat_jid, message_id, status,
    reason, attempts, target_lexicon_version, created_at, updated_at
  from transcription_jobs where account_id = ? and chat_jid = ? and message_id = ?`;

const HISTORY_JOB_SQL = `select id, account_id, chat_jid, since_ts, until_ts, status,
    phase, progress_percent, anchor_sender_jid, anchor_message_id,
    anchor_timestamp, oldest_seen_ts, batches_requested, batches_completed,
    messages_received, messages_inserted, coverage_complete, completion_reason,
    error_code, created_at, started_at, updated_at, completed_at
  from history_jobs where account_id = ? and id = ?`;

const ENTITY_SQL = `select account_id, canonical_jid, entity_type, name, display_name,
    push_name, verified_name, name_source, first_seen_at, updated_at,
    last_synced_at, raw_json
  from directory_entities where account_id = ? and canonical_jid = ?`;

// Aliases and memberships travel as canonical JIDs. The SQLite autoincrement
// entity id is a local cache detail and must never reach the client database.
const ALIASES_SQL = `select a.account_id, a.alias_jid, e.canonical_jid, a.alias_type,
    a.first_seen_at, a.updated_at
  from directory_aliases a
  join directory_entities e on e.id = a.entity_id
  where a.account_id = ? and e.canonical_jid = ?`;

const MEMBER_SQL = `select m.account_id, g.canonical_jid as group_jid,
    c.canonical_jid as member_jid, m.role, m.is_active, m.first_seen_at,
    m.updated_at
  from directory_group_members m
  join directory_entities g on g.id = m.group_entity_id
  join directory_entities c on c.id = m.member_entity_id
  where m.account_id = ? and g.canonical_jid = ?`;

function one(db: Database, sql: string, params: unknown[]): Row | undefined {
  return db.prepare<unknown[], Row>(sql).get(...params);
}

function many(db: Database, sql: string, params: unknown[]): Row[] {
  return db.prepare<unknown[], Row>(sql).all(...params);
}

/**
 * Idempotent upsert on a natural key.
 *
 * Table, key and column names come from the literal selects above — never from
 * WhatsApp data — and every value travels as a bound parameter.
 */
async function upsert(
  client: PostgresProjectionClient,
  table: string,
  keys: readonly string[],
  row: Row,
): Promise<void> {
  const columns = Object.keys(row);
  const updates = columns.filter((column) => !keys.includes(column));
  await client.query(
    `insert into ${table} (${columns.join(", ")}) values (${columns
      .map((_, index) => `$${String(index + 1)}`)
      .join(", ")}) on conflict (${keys.join(", ")}) ${
      updates.length
        ? `do update set ${updates
            .map((column) => `${column} = excluded.${column}`)
            .join(", ")}`
        : "do nothing"
    }`,
    columns.map((column) => {
      const value = row[column];
      if (!BOOLEAN_COLUMNS.has(column)) return value;
      return value === null || value === undefined ? null : value !== 0;
    }),
  );
}

async function projectAccount(
  client: PostgresProjectionClient,
  entry: QueuedJob,
): Promise<boolean> {
  const account = one(entry.db, ACCOUNT_SQL, [entry.accountId]);
  if (!account) return false;
  await upsert(client, "accounts", ["id"], account);
  return true;
}

async function projectChatRow(
  client: PostgresProjectionClient,
  entry: QueuedJob,
  chatJid: string,
): Promise<boolean> {
  const chat = one(entry.db, CHAT_SQL, [entry.accountId, chatJid]);
  if (!chat) return false;
  await upsert(client, "chats", ["account_id", "jid"], chat);
  const stats = one(entry.db, CHAT_STATS_SQL, [entry.accountId, chatJid]);
  if (stats) {
    await upsert(
      client,
      "chat_message_stats",
      ["account_id", "chat_jid"],
      stats,
    );
  }
  return true;
}

async function projectEntityRow(
  client: PostgresProjectionClient,
  entry: QueuedJob,
  canonicalJid: string,
): Promise<boolean> {
  const entity = one(entry.db, ENTITY_SQL, [entry.accountId, canonicalJid]);
  if (!entity) return false;
  await upsert(
    client,
    "directory_entities",
    ["account_id", "canonical_jid"],
    entity,
  );
  for (const alias of many(entry.db, ALIASES_SQL, [
    entry.accountId,
    canonicalJid,
  ])) {
    await upsert(
      client,
      "directory_aliases",
      ["account_id", "alias_jid"],
      alias,
    );
  }
  return true;
}

const MEMBER_KEYS = ["account_id", "group_jid", "member_jid"] as const;
const MESSAGE_KEYS = ["account_id", "chat_jid", "message_id"] as const;

async function projectMemberRow(
  client: PostgresProjectionClient,
  entry: QueuedJob,
  member: Row,
): Promise<void> {
  const groupJid = member.group_jid;
  const memberJid = member.member_jid;
  if (typeof groupJid !== "string" || typeof memberJid !== "string") return;
  if (!(await projectEntityRow(client, entry, groupJid))) return;
  if (!(await projectEntityRow(client, entry, memberJid))) return;
  await upsert(client, "directory_group_members", MEMBER_KEYS, member);
}

async function projectJob(
  client: PostgresProjectionClient,
  entry: QueuedJob,
): Promise<void> {
  if (!(await projectAccount(client, entry))) return;
  const { accountId, db, job } = entry;

  switch (job.kind) {
    case "chat":
      await projectChatRow(client, entry, job.chatJid);
      return;

    case "message": {
      if (!(await projectChatRow(client, entry, job.chatJid))) return;
      const keys = [accountId, job.chatJid, job.messageId];
      const message = one(db, MESSAGE_SQL, keys);
      if (!message) return;
      await upsert(client, "messages", MESSAGE_KEYS, message);
      for (const attachment of many(db, ATTACHMENTS_SQL, keys)) {
        await upsert(
          client,
          "attachments",
          [...MESSAGE_KEYS, "attachment_index"],
          attachment,
        );
      }
      const transcription = one(db, TRANSCRIPTION_SQL, keys);
      if (transcription) {
        await upsert(client, "transcriptions", MESSAGE_KEYS, transcription);
      }
      const transcriptionJob = one(db, TRANSCRIPTION_JOB_SQL, keys);
      if (transcriptionJob) {
        await upsert(
          client,
          "transcription_jobs",
          MESSAGE_KEYS,
          transcriptionJob,
        );
      }
      return;
    }

    case "entity":
      await projectEntityRow(client, entry, job.canonicalJid);
      return;

    case "member": {
      const member = many(db, `${MEMBER_SQL} and c.canonical_jid = ?`, [
        accountId,
        job.groupJid,
        job.memberJid,
      ])[0];
      if (member) await projectMemberRow(client, entry, member);
      return;
    }

    case "group-members":
      for (const member of many(db, MEMBER_SQL, [accountId, job.groupJid])) {
        await projectMemberRow(client, entry, member);
      }
      return;

    case "history-job": {
      const row = one(db, HISTORY_JOB_SQL, [accountId, job.jobId]);
      if (!row) return;
      const chatJid = row.chat_jid;
      if (typeof chatJid !== "string") return;
      if (!(await projectChatRow(client, entry, chatJid))) return;
      await upsert(client, "history_jobs", ["id"], row);
      return;
    }
  }
}

function jobKey(accountId: string, job: Job): string {
  return [accountId, ...Object.values(job).map(String)].join("|");
}

class PostgresProjection {
  private readonly queue = new Map<string, QueuedJob>();
  private drainPromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly pool: PostgresProjectionPool,
    private readonly logger: Logger,
  ) {}

  schedule(entry: QueuedJob): void {
    if (this.closed) return;
    this.queue.set(jobKey(entry.accountId, entry.job), entry);
    // setImmediate, not a direct call: better-sqlite3 transactions are
    // synchronous, so the projection always reads committed state.
    this.drainPromise ??= new Promise<void>((resolve) => {
      setImmediate(() => void this.drain().then(resolve, resolve));
    });
  }

  async flush(): Promise<void> {
    while (this.drainPromise) await this.drainPromise;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    await this.pool.end();
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.queue.entries().next();
      if (next.done === true) break;
      const [key, entry] = next.value;
      this.queue.delete(key);
      try {
        await this.write(entry);
      } catch (error) {
        this.report(entry.job.kind, error);
      }
    }
    this.drainPromise = null;
  }

  private async write(entry: QueuedJob): Promise<void> {
    // Acquiring the connection is bounded by the pool's connectionTimeoutMillis;
    // this deadline bounds the work once a connection is held.
    const client = await this.pool.connect();
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Destroy rather than return it: a half-applied transaction must never
      // be handed to the next projection.
      client.release(new Error("postgres projection timeout"));
    }, POSTGRES_TIMEOUT_MS);

    try {
      await client.query("begin");
      await projectJob(client, entry);
      await client.query("commit");
    } catch (error) {
      if (!settled) {
        try {
          await client.query("rollback");
        } catch {
          // Keep the original destination failure.
        }
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      if (!settled) {
        settled = true;
        client.release();
      }
    }
  }

  /**
   * One line, no retry, no counter, no public status. It carries the job family
   * and, when the driver supplies one, the SQLSTATE code — never message text,
   * a JID, a payload, the endpoint or the driver's own error string, which can
   * quote the offending row.
   */
  private report(kind: Job["kind"], error: unknown): void {
    const code = (error as { code?: unknown }).code;
    this.logger.warn(
      { projection: kind, code: typeof code === "string" ? code : undefined },
      "client PostgreSQL projection failed; local ingestion continues",
    );
  }
}

let active: PostgresProjection | null = null;

/** Install a projection over an existing pool (used by `configure` and tests). */
export function startPostgresProjection(
  pool: PostgresProjectionPool,
  logger: Logger,
): void {
  active = new PostgresProjection(pool, logger);
}

/**
 * Enable direct projection when the operator configured a destination. Without
 * `persistence.postgres` this is a no-op and the SQLite/outbox path is kept.
 */
export function configurePostgresProjection(
  config: Config,
  logger: Logger,
): void {
  const postgres = config.persistence.postgres;
  if (active || !postgres) return;
  startPostgresProjection(createPostgresPool(postgres), logger);
}

export function postgresProjectionEnabled(): boolean {
  return active !== null;
}

/** Await the pending queue. Tests and one-shot commands use it; nothing else. */
export async function flushPostgresProjection(): Promise<void> {
  await active?.flush();
}

/** Drain the projection while its SQLite source is still open. */
export async function closeDbAfterPostgresProjection(
  db: Database,
): Promise<void> {
  await flushPostgresProjection();
  db.close();
}

export async function shutdownPostgresProjection(): Promise<void> {
  const projection = active;
  if (!projection) return;
  active = null;
  await projection.close();
}

function schedule(db: Database, accountId: string, job: Job): void {
  active?.schedule({ db, accountId, job });
}

export function projectChat(
  db: Database,
  accountId: string,
  chatJid: string,
): void {
  schedule(db, accountId, { kind: "chat", chatJid });
}

export function projectMessage(
  db: Database,
  accountId: string,
  chatJid: string,
  messageId: string,
): void {
  schedule(db, accountId, { kind: "message", chatJid, messageId });
}

export function projectDirectoryEntity(
  db: Database,
  accountId: string,
  canonicalJid: string,
): void {
  schedule(db, accountId, { kind: "entity", canonicalJid });
}

export function projectDirectoryMember(
  db: Database,
  accountId: string,
  groupJid: string,
  memberJid: string,
): void {
  schedule(db, accountId, { kind: "member", groupJid, memberJid });
}

export function projectDirectoryMembers(
  db: Database,
  accountId: string,
  groupJid: string,
): void {
  schedule(db, accountId, { kind: "group-members", groupJid });
}

export function projectHistoryJob(
  db: Database,
  accountId: string,
  jobId: string,
): void {
  schedule(db, accountId, { kind: "history-job", jobId });
}
