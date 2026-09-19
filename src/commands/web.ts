import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import {
  closeDbAfterPostgresProjection,
  configurePostgresProjection,
} from "../db/postgres-projection.js";
import { createPostgresPool } from "../db/postgres.js";
import { createPostgresReader } from "../db/postgres-reader.js";
import { createSqliteReader } from "../db/sqlite-reader.js";
import type { ClientDataReader } from "../db/reader.js";
import { upsertAccount } from "../db/queries.js";
import { resolveConfigPath, appLogger } from "../runtime.js";
import { startDashboardServer } from "../dashboard/server.js";
import { ensureDashboardToken } from "../dashboard/token.js";
import { ModelDownloader } from "../dashboard/models.js";
import { modelsDir } from "../stt/models.js";

export interface WebOptions {
  configPath?: string | undefined;
  bind?: string | undefined;
  port?: number | undefined;
  /**
   * Accepted and ignored: the whatsmeow pairing controls it used to disable are
   * gone (ADR-0042), but the Compose `dashboard` service still passes the flag.
   */
  pairing?: boolean | undefined;
}

export async function runWeb(options: WebOptions = {}): Promise<void> {
  if (
    options.bind !== undefined &&
    !["127.0.0.1", "::1", "0.0.0.0", "::"].includes(options.bind)
  ) {
    throw new Error("web bind must be 127.0.0.1, ::1, 0.0.0.0, or ::");
  }
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535)
  ) {
    throw new Error("web port must be an integer between 0 and 65535");
  }
  const configPath = resolveConfigPath(options.configPath);
  const loaded = loadConfig(configPath);
  const config =
    options.bind === undefined && options.port === undefined
      ? loaded
      : {
          ...loaded,
          web: {
            ...loaded.web,
            ...(options.bind === undefined ? {} : { host: options.bind }),
            ...(options.port === undefined ? {} : { port: options.port }),
          },
        };
  if (!existsSync(config.paths.sqlite)) {
    throw new Error("Database not found. Run `whatsapp-conduit init` first.");
  }
  ensureDashboardToken(config.web.tokenFile);
  configurePostgresProjection(config, appLogger(config));
  const db = openDb(config.paths.sqlite, { migrate: false });
  upsertAccount(db, {
    id: config.account.name,
    label: config.account.description ?? null,
  });
  // Writes (allow/block, transcription correction, STT settings, maintenance)
  // always go through SQLite, same as ever. Reads switch to the client's own
  // PostgreSQL once configured (ADR-0033 phase 2) — a separate connection
  // from configurePostgresProjection's, which stays the async write path.
  let reader: ClientDataReader;
  let closeReader: () => Promise<void> = () => Promise.resolve();
  if (config.persistence.postgres) {
    const pool = createPostgresPool(config.persistence.postgres);
    reader = createPostgresReader(pool, config, config.account.name);
    closeReader = () => pool.end();
  } else {
    reader = createSqliteReader(db, config, config.account.name);
  }
  const dashboard = await startDashboardServer(config, {
    db,
    reader,
    config,
    configPath,
    models: new ModelDownloader(modelsDir(config)),
    accountId: config.account.name,
  });
  const address = dashboard.server.address();
  const port =
    typeof address === "object" && address ? address.port : config.web.port;
  appLogger(config).info(
    { host: config.web.host, port },
    "local dashboard started",
  );
  process.stdout.write(
    `Dashboard listening on http://${config.web.host}:${port}\n`,
  );
  process.stdout.write(`Dashboard token file: ${config.web.tokenFile}\n`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      dashboard.server.close(() => {
        void Promise.resolve()
          .finally(() => closeDbAfterPostgresProjection(db))
          .finally(closeReader)
          .finally(resolve);
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
