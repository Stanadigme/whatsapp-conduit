import { loadConfig } from "../config.js";
import { createPostgresPool, runPostgresMigrations } from "../db/postgres.js";
import { defaultConfigPath } from "../paths.js";

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
