import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import type { PostgresPersistenceConfig } from "../config.js";

/** Every remote call is bounded: the alpha never blocks ingestion on the VPS. */
export const POSTGRES_TIMEOUT_MS = 5_000;

const MIGRATION_RE = /^\d{4}_.+\.sql$/;

export interface PostgresSecrets {
  password: string;
  ca: string;
}

/**
 * Read an owner-only secret file.
 *
 * The permission check is a refusal, not a repair: a password or CA readable by
 * another local account is an operator mistake that must surface at startup
 * rather than be silently tightened behind their back.
 */
export function readSecretFile(path: string, label: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be readable by group or others (0600)`);
  }
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${label} is empty`);
  return value;
}

export function loadPostgresSecrets(
  config: PostgresPersistenceConfig,
): PostgresSecrets {
  return {
    password: readSecretFile(
      config.passwordFile,
      "persistence.postgres.password_file",
    ),
    ca: readSecretFile(config.caFile, "persistence.postgres.ca_file"),
  };
}

/**
 * Open the client pool. TLS verifies the server certificate against the
 * operator-provided authority; the alpha defers client certificates to the beta
 * profile (ADR-0033).
 */
export function createPostgresPool(config: PostgresPersistenceConfig): Pool {
  const secrets = loadPostgresSecrets(config);
  const endpoint = new URL(config.url);
  const host = endpoint.hostname.startsWith("[")
    ? endpoint.hostname.slice(1, -1)
    : endpoint.hostname;
  return new Pool({
    // pg lets connectionString override every sibling option, including the
    // owner-only password read above. Decompose the already-validated URL so
    // the password never needs to appear in it.
    host,
    port: endpoint.port ? Number(endpoint.port) : undefined,
    user: endpoint.username ? decodeURIComponent(endpoint.username) : undefined,
    database:
      endpoint.pathname.length > 1
        ? decodeURIComponent(endpoint.pathname.slice(1))
        : undefined,
    password: secrets.password,
    // Set SNI/hostname explicitly: Node otherwise verifies some IP endpoints
    // as `localhost`, rejecting a correctly issued certificate.
    ssl: { ca: secrets.ca, rejectUnauthorized: true, servername: host },
    // One connection: projections are serial by design, and the pilot runs a
    // single account.
    max: 1,
    connectionTimeoutMillis: POSTGRES_TIMEOUT_MS,
    query_timeout: POSTGRES_TIMEOUT_MS,
    statement_timeout: POSTGRES_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    application_name: "whatsapp-conduit",
  });
}

/** `postgres-migrations/` sits at the package root in both src and dist layouts. */
export function defaultPostgresMigrationsDir(): string {
  return fileURLToPath(new URL("../../postgres-migrations", import.meta.url));
}

export interface PostgresMigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply pending PostgreSQL migrations, one transaction per file.
 *
 * Deliberately never called by the daemon: the client database is migrated by
 * an explicit operator command, so a runtime restart can never rewrite the
 * schema of data we do not own.
 */
export async function runPostgresMigrations(
  client: Pick<PoolClient, "query">,
  dir: string = defaultPostgresMigrationsDir(),
): Promise<PostgresMigrationResult> {
  await client.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at bigint not null
     )`,
  );
  const done = new Set(
    (
      await client.query<{ name: string }>("select name from schema_migrations")
    ).rows.map((row) => row.name),
  );

  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  for (const name of readdirSync(dir)
    .filter((file) => MIGRATION_RE.test(file))
    .sort()) {
    if (done.has(name)) {
      alreadyApplied.push(name);
      continue;
    }
    const sql = readFileSync(`${dir}/${name}`, "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (name, applied_at) values ($1, $2)",
        [name, Math.floor(Date.now() / 1000)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    applied.push(name);
  }
  return { applied, alreadyApplied };
}
