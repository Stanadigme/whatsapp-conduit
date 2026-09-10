import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { createPostgresPool, runPostgresMigrations } from "../db/postgres.js";
import {
  flushPostgresProjection,
  projectChat,
  projectDirectoryEntity,
  projectDirectoryMembers,
  projectHistoryJob,
  projectMessage,
  shutdownPostgresProjection,
  startPostgresProjection,
} from "../db/postgres-projection.js";
import { defaultConfigPath } from "../paths.js";
import { appLogger } from "../runtime.js";

export interface PostgresMigrateOptions {
  configPath?: string | undefined;
  json?: boolean | undefined;
}

export interface PostgresMigrateReport {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply the client-database schema.
 *
 * Explicit on purpose: the daemon never migrates a database it does not own,
 * so an image upgrade or a restart can never rewrite the client's schema
 * behind their back (ADR-0033).
 */
export async function runPostgresMigrate(
  options: PostgresMigrateOptions = {},
): Promise<PostgresMigrateReport> {
  const config = loadConfig(options.configPath ?? defaultConfigPath());
  const postgres = config.persistence.postgres;
  if (!postgres) {
    throw new Error(
      "No client database configured. Set persistence.postgres in the config file first.",
    );
  }

  const pool = createPostgresPool(postgres);
  try {
    const client = await pool.connect();
    try {
      const result = await runPostgresMigrations(client);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.applied.length > 0) {
        process.stdout.write(
          `Applied ${String(result.applied.length)} migration(s): ${result.applied.join(", ")}\n`,
        );
      } else {
        process.stdout.write("Client database is up to date.\n");
      }
      return result;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export interface PostgresImportOptions {
  configPath?: string | undefined;
  json?: boolean | undefined;
}

export interface PostgresImportReport {
  chats: number;
  directoryEntities: number;
  groups: number;
  messages: number;
  historyJobs: number;
}

/**
 * Backfill everything already present in SQLite into the client's PostgreSQL,
 * before switching MCP/dashboard/export reads over to it (ADR-0033: "le
 * passage initial importe les données déjà présentes... puis les
 * consommateurs de lecture basculent"). Safe to run more than once — every
 * write behind it is an upsert on a natural key.
 *
 * Reuses the same natural-key scheduler the live daemon uses for its
 * best-effort projection (db/postgres-projection.ts) rather than a bespoke
 * bulk path, so a backfilled row and a freshly-ingested one are written by
 * identical code. One project*() call is scheduled per row, then the whole
 * queue is drained once at the end.
 *
 * ponytail: sequential, one row at a time — fine for a single pilot account's
 * history, but would need batching for an account with a large existing
 * corpus. Upgrade to bulk COPY/multi-row upserts if that ever matters.
 */
export async function runPostgresImport(
  options: PostgresImportOptions = {},
): Promise<PostgresImportReport> {
  const config = loadConfig(options.configPath ?? defaultConfigPath());
  const postgres = config.persistence.postgres;
  if (!postgres) {
    throw new Error(
      "No client database configured. Set persistence.postgres in the config file first.",
    );
  }
  if (!existsSync(config.paths.sqlite)) {
    throw new Error("Database not found. Run `whatsapp-conduit init` first.");
  }

  const accountId = config.account.name;
  const db = openDb(config.paths.sqlite, { migrate: false, readonly: true });
  const pool = createPostgresPool(postgres);
  try {
    startPostgresProjection(pool, appLogger(config));

    const chatJids = db
      .prepare<[string], { jid: string }>(
        "select jid from chats where account_id = ?",
      )
      .all(accountId)
      .map((row) => row.jid);
    for (const jid of chatJids) projectChat(db, accountId, jid);

    const entities = db
      .prepare<
        [string],
        { canonical_jid: string; entity_type: "contact" | "group" }
      >(
        "select canonical_jid, entity_type from directory_entities where account_id = ?",
      )
      .all(accountId);
    for (const entity of entities) {
      projectDirectoryEntity(db, accountId, entity.canonical_jid);
    }
    const groupJids = entities
      .filter((entity) => entity.entity_type === "group")
      .map((entity) => entity.canonical_jid);
    for (const groupJid of groupJids) {
      projectDirectoryMembers(db, accountId, groupJid);
    }

    const messageKeys = db
      .prepare<
        [string],
        { chat_jid: string; message_id: string }
      >("select chat_jid, message_id from messages where account_id = ?")
      .all(accountId);
    for (const key of messageKeys) {
      projectMessage(db, accountId, key.chat_jid, key.message_id);
    }

    const historyJobIds = db
      .prepare<[string], { id: string }>(
        "select id from history_jobs where account_id = ?",
      )
      .all(accountId)
      .map((row) => row.id);
    for (const id of historyJobIds) projectHistoryJob(db, accountId, id);

    await flushPostgresProjection();

    const report: PostgresImportReport = {
      chats: chatJids.length,
      directoryEntities: entities.length,
      groups: groupJids.length,
      messages: messageKeys.length,
      historyJobs: historyJobIds.length,
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Imported ${report.chats} chat(s), ${report.directoryEntities} directory ` +
          `entries, ${report.messages} message(s), ${report.historyJobs} ` +
          `history job(s) into the client database.\n`,
      );
    }
    return report;
  } finally {
    await shutdownPostgresProjection();
    db.close();
  }
}
