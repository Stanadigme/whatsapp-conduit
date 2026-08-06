import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { authStateExists, openAuthState } from "../baileys/auth.js";
import { ConduitConnection } from "../baileys/connect.js";
import { registerIngestion } from "../baileys/ingest.js";
import { normalizeJid } from "../baileys/jid.js";
import { openDb } from "../db/index.js";
import { upsertAccount } from "../db/queries.js";
import { appLogger, baileysLogger, resolveConfigPath } from "../runtime.js";
import { registerWhatsmeowIngestion } from "../whatsmeow/ingest.js";
import { DirectorySync } from "../whatsmeow/directory.js";
import { WhatsmeowTransport } from "../whatsmeow/transport.js";
import { RuntimeStatusWriter } from "../runtime-status.js";

export interface RunOptions {
  configPath?: string;
}

/**
 * Run the foreground observe-only sync daemon: connect, reconnect on transient
 * drops, and stay alive until SIGINT/SIGTERM. Message ingestion handlers are
 * attached to each socket via the connection's `registerSocket` hook.
 *
 * The returned promise resolves on graceful shutdown.
 */
export async function runRun(options: RunOptions = {}): Promise<void> {
  const config = loadConfig(resolveConfigPath(options.configPath));
  const log = appLogger(config);

  if (config.transport === "whatsmeow") {
    return runWhatsmeow(config, log);
  }

  // Refuse to start unpaired: `run` has no QR handler, so opening a fresh auth
  // state would spin in an unrecoverable pairing/reconnect loop. Require link.
  if (!authStateExists(config.paths.authDir)) {
    throw new Error(
      "No linked device found. Run `whatsapp-conduit link` before `run`.",
    );
  }

  const db = openDb(config.paths.sqlite, { migrate: true });

  upsertAccount(db, {
    id: config.account.name,
    label: config.account.description ?? null,
  });

  const authState = await openAuthState(config.paths.authDir);

  log.info(
    {
      account: config.account.name,
      observeOnly: config.privacy.observeOnly,
      sendEnabled: config.privacy.sendEnabled,
      markRead: config.privacy.markRead,
      includeGroups: config.privacy.includeGroups,
    },
    "starting observe-only sync",
  );

  return new Promise<void>((resolve) => {
    let shuttingDown = false;

    const shutdown = (code: number): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("shutting down");
      connection.stop();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      try {
        db.close();
      } catch {
        // best-effort
      }
      if (code !== 0) process.exitCode = code;
      resolve();
    };
    const onSignal = (): void => shutdown(0);

    const connection = new ConduitConnection({
      config,
      authState,
      logger: baileysLogger(config),
      mode: "run",
      handlers: {
        onConnecting() {
          log.info("connecting to WhatsApp");
        },
        onOpen(info) {
          log.info({ selfJid: info.selfJid }, "connected");
        },
        onClose(info) {
          if (info.loggedOut) {
            log.error("logged out — re-link required; stopping");
            shutdown(1);
            return;
          }
          log.warn(
            { statusCode: info.statusCode, willReconnect: info.willReconnect },
            "connection closed",
          );
        },
        registerSocket(sock) {
          registerIngestion(sock, {
            db,
            accountId: config.account.name,
            config,
            logger: log,
          });
        },
      },
    });

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    connection.start().catch((err: unknown) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to start connection",
      );
      shutdown(1);
    });
  });
}

async function runWhatsmeow(
  config: ReturnType<typeof loadConfig>,
  log: ReturnType<typeof appLogger>,
): Promise<void> {
  if (!existsSync(config.paths.whatsmeowStore)) {
    throw new Error(
      "No linked whatsmeow device found. Run `whatsapp-conduit link --qr` first.",
    );
  }

  const db = openDb(config.paths.sqlite, { migrate: true });
  upsertAccount(db, {
    id: config.account.name,
    label: config.account.description ?? null,
  });
  const transport = new WhatsmeowTransport({
    store: config.paths.whatsmeowStore,
    config: config.whatsmeow,
  });
  const directory = new DirectorySync({
    db,
    accountId: config.account.name,
    logger: log,
    transport,
  });
  directory.register();
  const runtimeStatus = new RuntimeStatusWriter(config.paths.runtimeStatus, {
    transport: "whatsmeow",
    connection: "disconnected",
    authLinked: true,
  });
  void runtimeStatus.update();
  registerWhatsmeowIngestion(
    transport,
    {
      db,
      accountId: config.account.name,
      config,
      logger: log,
    },
    {
      onEvent: () =>
        void runtimeStatus.update({
          lastEventAt: Math.floor(Date.now() / 1000),
        }),
    },
  );

  log.info(
    {
      account: config.account.name,
      transport: "whatsmeow",
      observeOnly: config.privacy.observeOnly,
      sendEnabled: config.privacy.sendEnabled,
      markRead: config.privacy.markRead,
      includeGroups: config.privacy.includeGroups,
    },
    "starting observe-only sync",
  );

  return new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (code: number): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("shutting down");
      void runtimeStatus.update({ connection: "disconnected" });
      void transport.stop().finally(() => {
        try {
          db.close();
        } catch {
          // best-effort
        }
        if (code !== 0) process.exitCode = code;
        resolve();
      });
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    const onSignal = (): void => shutdown(0);

    transport.on("connected", ({ jid }) => {
      const selfJid = normalizeJid(jid);
      upsertAccount(db, { id: config.account.name, selfJid });
      void runtimeStatus.update({
        connection: "connected",
        authLinked: true,
        lastEventAt: Math.floor(Date.now() / 1000),
      });
      log.info({ selfJid, transport: "whatsmeow" }, "connected");
    });
    transport.on("disconnected", () => {
      void runtimeStatus.update({
        connection: "disconnected",
        lastEventAt: Math.floor(Date.now() / 1000),
      });
      if (!shuttingDown) log.warn("whatsmeow connection closed");
    });
    transport.on("error", (error) => {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "whatsmeow transport error",
      );
    });
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    transport.start().catch((error: unknown) => {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to start whatsmeow connection",
      );
      shutdown(1);
    });
  });
}
