import { Pool } from "pg";
import type { ChatRow, MessageRow } from "./queries.js";
import type { ForwardedOutboxOperation } from "./outbox-forwarder.js";

export interface PostgresMtlsOptions {
  /** PEM of the authority that issued the PostgreSQL server certificate. */
  ca: string;
  /** PEM client certificate, dedicated to one client instance. */
  cert: string;
  /** PEM private key paired with {@link PostgresMtlsOptions.cert}. */
  key: string;
  /** Override SNI only when the certificate name differs from the DNS endpoint. */
  servername?: string | undefined;
}

export interface PostgresOutboxOptions {
  connectionString: string;
  tls: PostgresMtlsOptions;
}

export interface PostgresClient {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
  release(): void;
}

export interface PostgresConnectionPool {
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

interface MessageSnapshot {
  version: 1;
  chat: ChatRow;
  message: MessageRow;
}

/**
 * Create the future client-data destination. Construction is inert: `pg` opens
 * no connection until the outbox forwarder invokes `forward`.
 */
export function createPostgresOutboxDestination(
  options: PostgresOutboxOptions,
): PostgresOutboxDestination {
  const endpoint = validatePostgresOptions(options);
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 1,
    ssl: {
      ca: options.tls.ca,
      cert: options.tls.cert,
      key: options.tls.key,
      rejectUnauthorized: true,
      servername: options.tls.servername ?? endpoint.hostname,
    },
  });
  return new PostgresOutboxDestination(pool);
}

/**
 * PostgreSQL side of the message snapshot contract. It is deliberately narrow:
 * media, directory projections and jobs wait for their own outbox operations.
 */
export class PostgresOutboxDestination {
  constructor(private readonly pool: PostgresConnectionPool) {}

  async forward(operation: ForwardedOutboxOperation): Promise<void> {
    if (operation.operation !== "message.upsert") {
      throw new Error("unsupported PostgreSQL outbox operation");
    }
    const snapshot = messageSnapshot(operation.payload);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await writeAccount(client, snapshot);
      await writeChat(client, snapshot.chat);
      await writeMessage(client, snapshot.message);
      await client.query("commit");
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the original destination failure for the outbox retry.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

function validatePostgresOptions(options: PostgresOutboxOptions): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(options.connectionString);
  } catch {
    throw new Error("PostgreSQL connection string is invalid");
  }
  if (
    (endpoint.protocol !== "postgres:" &&
      endpoint.protocol !== "postgresql:") ||
    !endpoint.hostname ||
    endpoint.password
  ) {
    throw new Error("PostgreSQL endpoint must use certificate authentication");
  }
  for (const value of [options.tls.ca, options.tls.cert, options.tls.key]) {
    if (!value.trim()) throw new Error("PostgreSQL mTLS material is required");
  }
  return endpoint;
}

function messageSnapshot(payload: unknown): MessageSnapshot {
  if (!isRecord(payload) || payload.version !== 1) {
    throw new Error("unsupported PostgreSQL outbox payload");
  }
  const { chat, message } = payload;
  if (
    !isRecord(chat) ||
    !isRecord(message) ||
    typeof chat.account_id !== "string" ||
    typeof chat.jid !== "string" ||
    typeof message.account_id !== "string" ||
    typeof message.chat_jid !== "string" ||
    typeof message.message_id !== "string" ||
    chat.account_id !== message.account_id ||
    chat.jid !== message.chat_jid
  ) {
    throw new Error("invalid PostgreSQL message snapshot");
  }
  return {
    version: 1,
    chat: chat as unknown as ChatRow,
    message: message as unknown as MessageRow,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeAccount(
  client: PostgresClient,
  snapshot: MessageSnapshot,
): Promise<void> {
  await client.query(
    `insert into accounts (id, created_at, updated_at)
     values ($1, $2, $2)
     on conflict (id) do update set updated_at = greatest(accounts.updated_at, excluded.updated_at)`,
    [snapshot.message.account_id, snapshot.message.received_at],
  );
}

async function writeChat(client: PostgresClient, chat: ChatRow): Promise<void> {
  await client.query(
    `insert into chats (
       account_id, jid, name, push_name, is_group, is_status, is_blocked,
       is_allowed, discovered_at, updated_at, last_message_ts, raw_json
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     ) on conflict (account_id, jid) do update set
       name = coalesce(excluded.name, chats.name),
       push_name = coalesce(excluded.push_name, chats.push_name),
       is_group = excluded.is_group,
       is_status = excluded.is_status,
       is_blocked = excluded.is_blocked,
       is_allowed = excluded.is_allowed,
       updated_at = greatest(chats.updated_at, excluded.updated_at),
       last_message_ts = greatest(chats.last_message_ts, excluded.last_message_ts),
       raw_json = coalesce(excluded.raw_json, chats.raw_json)`,
    [
      chat.account_id,
      chat.jid,
      chat.name,
      chat.push_name,
      chat.is_group,
      chat.is_status,
      chat.is_blocked,
      chat.is_allowed,
      chat.discovered_at,
      chat.updated_at,
      chat.last_message_ts,
      chat.raw_json,
    ],
  );
}

async function writeMessage(
  client: PostgresClient,
  message: MessageRow,
): Promise<void> {
  await client.query(
    `insert into messages (
       account_id, chat_jid, message_id, sender_jid, from_me, timestamp,
       received_at, message_type, text, normalized_text, has_media, duration_s,
       ingestion_source, quoted_message_id, quoted_sender_jid, edited_message_id,
       deleted_at, raw_json
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, $18
     ) on conflict (account_id, chat_jid, message_id) do update set
       sender_jid = coalesce(excluded.sender_jid, messages.sender_jid),
       message_type = coalesce(excluded.message_type, messages.message_type),
       text = coalesce(excluded.text, messages.text),
       normalized_text = coalesce(excluded.normalized_text, messages.normalized_text),
       has_media = excluded.has_media,
       duration_s = coalesce(excluded.duration_s, messages.duration_s),
       ingestion_source = excluded.ingestion_source,
       quoted_message_id = coalesce(excluded.quoted_message_id, messages.quoted_message_id),
       quoted_sender_jid = coalesce(excluded.quoted_sender_jid, messages.quoted_sender_jid),
       edited_message_id = coalesce(excluded.edited_message_id, messages.edited_message_id),
       deleted_at = coalesce(excluded.deleted_at, messages.deleted_at),
       raw_json = coalesce(excluded.raw_json, messages.raw_json)`,
    [
      message.account_id,
      message.chat_jid,
      message.message_id,
      message.sender_jid,
      message.from_me,
      message.timestamp,
      message.received_at,
      message.message_type,
      message.text,
      message.normalized_text,
      message.has_media,
      message.duration_s,
      message.ingestion_source,
      message.quoted_message_id,
      message.quoted_sender_jid,
      message.edited_message_id,
      message.deleted_at,
      message.raw_json,
    ],
  );
}
