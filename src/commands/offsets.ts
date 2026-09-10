import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { createPostgresPool } from "../db/postgres.js";
import { createPostgresReader } from "../db/postgres-reader.js";
import { createSqliteReader } from "../db/sqlite-reader.js";
import type { ClientDataReader } from "../db/reader.js";
import { resolveConfigPath } from "../runtime.js";

/**
 * The same cursor `export --since-last`/`--commit` reads and writes
 * (db/reader.ts's getConsumerOffset/setConsumerOffset), so it must resolve to
 * the same backend export uses — PostgreSQL once configured (ADR-0033 phase
 * 2), never SQLite in that case, or the two would silently split-brain.
 */
async function withReader<T>(
  configPath: string | undefined,
  readonly: boolean,
  action: (reader: ClientDataReader) => Promise<T>,
): Promise<T> {
  const config = loadConfig(resolveConfigPath(configPath));
  if (config.persistence.postgres) {
    const pool = createPostgresPool(config.persistence.postgres);
    try {
      return await action(createPostgresReader(pool, config, config.account.name));
    } finally {
      await pool.end();
    }
  }
  const db = openDb(config.paths.sqlite, { migrate: false, readonly });
  try {
    return await action(createSqliteReader(db, config, config.account.name));
  } finally {
    db.close();
  }
}

export interface OffsetsCommitOptions {
  configPath?: string | undefined;
  through: number;
  timestamp?: number | undefined;
}

/**
 * Advance a consumer's offset to a cursor obtained from a prior
 * `export --since-last`. This is the commit half of the two-phase export.
 */
export async function runOffsetsCommit(
  consumer: string,
  options: OffsetsCommitOptions,
): Promise<void> {
  await withReader(options.configPath, false, async (reader) => {
    await reader.setConsumerOffset(consumer, {
      lastSeenEventId: options.through,
      lastSeenTimestamp: options.timestamp ?? null,
    });
    process.stdout.write(
      `Committed offset for "${consumer}" through cursor ${options.through}.\n`,
    );
  });
}

export interface OffsetsShowOptions {
  configPath?: string | undefined;
  json?: boolean | undefined;
}

export async function runOffsetsShow(
  consumer: string,
  options: OffsetsShowOptions = {},
): Promise<number> {
  return withReader(options.configPath, true, async (reader) => {
    const row = await reader.getConsumerOffset(consumer);
    if (!row) {
      if (options.json) {
        process.stdout.write("null\n");
      } else {
        process.stderr.write(`No offset for consumer "${consumer}".\n`);
      }
      return 1;
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${consumer}: cursor=${row.last_seen_event_id ?? "—"} ` +
          `timestamp=${row.last_seen_timestamp ?? "—"}\n`,
      );
    }
    return 0;
  });
}
