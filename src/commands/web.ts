import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { upsertAccount } from "../db/queries.js";
import { resolveConfigPath, appLogger } from "../runtime.js";
import { startDashboardServer } from "../dashboard/server.js";
import { createPairingController } from "../dashboard/pairing.js";
import { ensureDashboardToken } from "../dashboard/token.js";
import { ModelDownloader } from "../dashboard/models.js";
import { modelsDir } from "../stt/models.js";

export interface WebOptions {
  configPath?: string;
  bind?: string;
  port?: number;
  pairing?: boolean;
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
  if (config.transport !== "whatsmeow") {
    throw new Error("web dashboard requires transport: whatsmeow");
  }
  if (!existsSync(config.paths.sqlite)) {
    throw new Error("Database not found. Run `whatsapp-conduit init` first.");
  }
  ensureDashboardToken(config.web.tokenFile);
  const db = openDb(config.paths.sqlite, { migrate: false });
  upsertAccount(db, {
    id: config.account.name,
    label: config.account.description ?? null,
  });
  const pairing =
    options.pairing === false ? null : createPairingController(config);
  const dashboard = await startDashboardServer(config, {
    db,
    config,
    configPath,
    models: new ModelDownloader(modelsDir(config)),
    accountId: config.account.name,
    pairing: pairing?.state ?? { status: "disabled", qr: null, error: null },
    startPairing: async () => {
      if (!pairing)
        throw new Error(
          "dashboard pairing is disabled; use `ingestion link --qr`",
        );
      await pairing.start();
    },
    stopPairing: async () => {
      if (pairing) await pairing.stop();
    },
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
        void (pairing?.stop() ?? Promise.resolve()).finally(() => {
          db.close();
          resolve();
        });
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
