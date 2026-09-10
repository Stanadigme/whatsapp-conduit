import { loadConfig } from "../config.js";
import { authStateExists, openAuthState } from "../baileys/auth.js";
import { ConduitConnection } from "../baileys/connect.js";
import { acquireBaileysSessionLock } from "../baileys/session-lock.js";
import {
  prepareBaileysRelink,
  restoreBaileysRelink,
} from "../baileys/relink.js";
import { registerIngestion, type IngestDeps } from "../baileys/ingest.js";
import { resyncBaileysDirectory } from "../baileys/directory.js";
import {
  BaileysHistoryTransport,
  baileysTimestamp,
} from "../baileys/history.js";
import { normalizeJid } from "../baileys/jid.js";
import { openDb } from "../db/index.js";
import { ensureOutboxKey } from "../db/outbox.js";
import {
  closeDbAfterPostgresProjection,
  configurePostgresProjection,
  postgresProjectionEnabled,
} from "../db/postgres-projection.js";
import { upsertAccount } from "../db/queries.js";
import { getChat } from "../db/queries.js";
import { appLogger, baileysLogger, resolveConfigPath } from "../runtime.js";
import { HistoryControlServer } from "../control/ipc.js";
import { HistoryCoordinator } from "../history/coordinator.js";
import { createVersionResolver } from "../baileys/version.js";
import { registerWhatsmeowIngestion } from "../whatsmeow/ingest.js";
import { DirectorySync } from "../whatsmeow/directory.js";
import { WhatsmeowTransport } from "../whatsmeow/transport.js";
import { whatsmeowSessionLinked } from "../whatsmeow/session.js";
import {
  acquireSessionLock,
  type SessionLock,
} from "../whatsmeow/session-lock.js";
import { RuntimeStatusWriter } from "../runtime-status.js";
import { runLink } from "./link.js";
import { join } from "node:path";
import {
  beginMaintenanceOperation,
  completeMaintenanceOperation,
  failMaintenanceOperation,
  maintenanceConfirmation,
  maintenanceIsActive,
  maintenanceState,
  markDirectoryRebuildResult,
  recoverInterruptedMaintenanceOperations,
  runMaintenanceOperation,
  startMaintenanceOperation,
  type MaintenanceScope,
} from "../db/maintenance.js";
import { clearAppStateSyncVersions } from "../baileys/auth.js";
import { BAILEYS_DIRECTORY_APP_STATE_COLLECTIONS } from "../baileys/directory.js";

export interface RunOptions {
  configPath?: string | undefined;
  /** Abort a pre-link wait (used by tests and embedded callers). */
  signal?: AbortSignal | undefined;
}

const RUNTIME_STATUS_HEARTBEAT_MS = 15_000;

/**
 * Run the foreground observe-only sync daemon: connect, reconnect on transient
 * drops, and stay alive until SIGINT/SIGTERM. Message ingestion handlers are
 * attached to each socket via the connection's `registerSocket` hook.
 *
 * The returned promise resolves on graceful shutdown.
 */
export async function runRun(options: RunOptions = {}): Promise<void> {
  const configPath = resolveConfigPath(options.configPath);
  const config = loadConfig(configPath);
  const log = appLogger(config);

  if (config.transport === "whatsmeow") {
    return runWhatsmeow(config, log, options.signal);
  }

  // A fresh auth state cannot connect by itself. Keep a local control socket
  // open so the authenticated dashboard can ask this same ingestion process to
  // own a QR pairing session (ADR-0026), rather than opening Baileys itself.
  if (!authStateExists(config.paths.authDir)) {
    return runBaileysWaitingForPairing(config, configPath, log, options.signal);
  }

  const sessionLock = acquireBaileysSessionLock(config.paths.authDir);

  // Alpha profile (ADR-0033): the client database is written directly, so no
  // outbox snapshot is queued. Without it, the SQLite/outbox path is unchanged.
  configurePostgresProjection(config, log);
  const outboxKey = postgresProjectionEnabled()
    ? undefined
    : ensureOutboxKey(config.paths.outboxKey);
  const db = openDb(config.paths.sqlite, { migrate: true });

  upsertAccount(db, {
    id: config.account.name,
    label: config.account.description ?? null,
  });
  recoverInterruptedMaintenanceOperations(db, config.account.name);

  const authState = await openAuthState(config.paths.authDir);
  const runtimeStatus = new RuntimeStatusWriter(config.paths.runtimeStatus, {
    transport: "baileys",
    connection: "disconnected",
    authLinked: true,
  });
  void runtimeStatus.update();
  const ingestDeps: IngestDeps = {
    db,
    accountId: config.account.name,
    config,
    logger: log,
    ...(outboxKey ? { outboxKey } : {}),
  };
  const historyTransport = new BaileysHistoryTransport();
  const history = new HistoryCoordinator({
    db,
    accountId: config.account.name,
    transport: historyTransport,
    logger: log,
  });

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
    let initialResyncDone = false;
    let pairingInFlight = false;
    let directoryResyncInFlight = false;
    let pairingAbort: AbortController | undefined;
    const heartbeat = setInterval(
      () => void runtimeStatus.update(),
      RUNTIME_STATUS_HEARTBEAT_MS,
    );

    const control = new HistoryControlServer(
      config.paths.controlSocket,
      async (request) => {
        if (request.op === "maintenance.reset") {
          if (pairingInFlight) {
            throw new Error("Baileys pairing is already active");
          }
          if (directoryResyncInFlight) {
            throw new Error("directory resynchronization is already active");
          }
          if (request.confirmation !== maintenanceConfirmation(request.scope)) {
            throw new Error("invalid maintenance confirmation");
          }
          const operation = startMaintenanceOperation(
            db,
            config.account.name,
            request.scope,
          );
          void executeMaintenanceReset(request.scope, operation.id);
          return {
            maintenance: { operationId: operation.id, status: "queued" },
          };
        }
        if (request.op === "pairing.start") {
          if (maintenanceIsActive(db, config.account.name)) {
            throw new Error("a maintenance operation is already active");
          }
          if (pairingInFlight) {
            throw new Error("Baileys pairing is already active");
          }
          if (directoryResyncInFlight) {
            throw new Error("directory resynchronization is already active");
          }
          pairingInFlight = true;
          pairingAbort = new AbortController();
          void beginBaileysPairing();
          return { pairing: { status: "starting" } };
        }
        if (pairingInFlight) {
          throw new Error("Baileys pairing is already active");
        }
        if (request.op === "directory.resync") {
          if (maintenanceIsActive(db, config.account.name)) {
            throw new Error("a maintenance operation is already active");
          }
          return { resynced: await runDirectoryResync() };
        }
        if (maintenanceIsActive(db, config.account.name)) {
          throw new Error("a maintenance operation is already active");
        }
        const chatJid = normalizeJid(request.chat);
        const chat = getChat(db, config.account.name, chatJid);
        if (!chat || chat.is_blocked === 1 || chat.is_allowed !== 1) {
          throw new Error("chat is not available");
        }
        if (
          request.since < 0 ||
          request.since > Math.floor(Date.now() / 1000)
        ) {
          throw new Error("since must not be in the future");
        }
        const result = await history.start(chatJid, request.since);
        return {
          jobId: result.job.id,
          status: result.job.status,
          reused: result.reused,
        };
      },
    );

    async function executeMaintenanceReset(
      scope: MaintenanceScope,
      operationId: string,
    ): Promise<void> {
      let cursorResetError: string | null = null;
      if (scope === "directory" || scope === "all") {
        try {
          await clearAppStateSyncVersions(
            authState,
            BAILEYS_DIRECTORY_APP_STATE_COLLECTIONS,
          );
        } catch (error) {
          cursorResetError = "unable to reset app-state cursors";
          log.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "could not reset app-state cursors before directory maintenance",
          );
        }
      }
      try {
        await runMaintenanceOperation({
          db,
          accountId: config.account.name,
          scope,
          mediaDir: config.paths.mediaDir,
          operationId,
          deferCompletion: scope === "directory" || scope === "all",
        });
        if (scope !== "directory" && scope !== "all") return;
        if (cursorResetError) {
          markDirectoryRebuildResult(db, config.account.name, cursorResetError);
          failMaintenanceOperation(
            db,
            config.account.name,
            operationId,
            "directory_rebuild_failed",
          );
          return;
        }
        const sock = connection.socket();
        if (!sock) {
          // The persisted marker triggers the next connected rebuild. It is
          // safe to release the reset now because no socket is active.
          completeMaintenanceOperation(db, config.account.name, operationId);
          return;
        }
        try {
          await resyncBaileysDirectory(sock, ingestDeps, { strict: true });
          markDirectoryRebuildResult(db, config.account.name, null);
          completeMaintenanceOperation(db, config.account.name, operationId);
        } catch (error) {
          markDirectoryRebuildResult(
            db,
            config.account.name,
            "directory synchronization failed",
          );
          failMaintenanceOperation(
            db,
            config.account.name,
            operationId,
            "directory_rebuild_failed",
          );
          log.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "directory maintenance rebuild failed",
          );
        }
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "maintenance reset failed",
        );
      }
    }

    async function runDirectoryResync(
      options: { strict?: boolean } = {},
    ): Promise<Awaited<ReturnType<typeof resyncBaileysDirectory>>> {
      if (pairingInFlight) throw new Error("Baileys pairing is already active");
      if (directoryResyncInFlight) {
        throw new Error("directory resynchronization is already active");
      }
      const sock = connection.socket();
      if (!sock) throw new Error("not connected to WhatsApp");
      directoryResyncInFlight = true;
      try {
        return await resyncBaileysDirectory(sock, ingestDeps, options);
      } finally {
        directoryResyncInFlight = false;
      }
    }

    const shutdown = (code: number): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("shutting down");
      clearInterval(heartbeat);
      void runtimeStatus.update({ connection: "disconnected" });
      pairingAbort?.abort();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      void (async () => {
        await connection.stop().catch(() => undefined);
        await control.close().catch(() => undefined);
        try {
          await closeDbAfterPostgresProjection(db);
        } catch {
          // best-effort
        }
        sessionLock.release();
        if (code !== 0) process.exitCode = code;
        resolve();
      })();
    };
    const onSignal = (): void => shutdown(0);

    async function beginBaileysPairing(): Promise<void> {
      let archivedAuthDir: string | null = null;
      try {
        // `stop()` awaits Baileys' socket close before the auth directory is
        // moved. This is the boundary between the daemon and the QR session.
        await connection.stop();
        sessionLock.release();
        if (shuttingDown) return;
        archivedAuthDir = prepareBaileysRelink(config.paths.authDir);
        if (shuttingDown) {
          restoreBaileysRelink(config.paths.authDir, archivedAuthDir);
          return;
        }
        await runLink({
          configPath,
          qr: true,
          qrOut: join(config.paths.dataDir, "pairing-qr.svg"),
          timeoutSec: 600,
          signal: pairingAbort?.signal,
        });
      } catch (error) {
        if (archivedAuthDir) {
          try {
            restoreBaileysRelink(config.paths.authDir, archivedAuthDir);
          } catch (restoreError) {
            log.error(
              {
                err:
                  restoreError instanceof Error
                    ? restoreError.message
                    : String(restoreError),
              },
              "failed to restore the previous Baileys auth state",
            );
          }
        }
        if (!shuttingDown) {
          log.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Baileys dashboard pairing did not complete; previous auth restored",
          );
        }
      } finally {
        // Docker's `unless-stopped` policy starts a clean daemon with either
        // the newly linked state or the restored previous state.
        if (!shuttingDown) shutdown(0);
      }
    }

    const connection = new ConduitConnection({
      config,
      authState,
      logger: baileysLogger(config),
      mode: "run",
      fetchVersion: createVersionResolver(config, log),
      handlers: {
        onConnecting() {
          void runtimeStatus.update({ connection: "unknown" });
          log.info("connecting to WhatsApp");
        },
        onOpen(info) {
          historyTransport.connected(info.selfJid ?? config.account.name);
          void runtimeStatus.update({
            connection: "connected",
            authLinked: true,
          });
          log.info({ selfJid: info.selfJid }, "connected");
          const rebuildState = maintenanceState(db, config.account.name);
          if (
            (config.baileys.resyncDirectoryOnConnect ||
              rebuildState.directoryRebuildRequired) &&
            !initialResyncDone
          ) {
            initialResyncDone = true;
            if (connection.socket()) {
              void runDirectoryResync({
                strict: rebuildState.directoryRebuildRequired,
              })
                .then((r) => {
                  if (rebuildState.directoryRebuildRequired) {
                    markDirectoryRebuildResult(db, config.account.name, null);
                  }
                  log.info(
                    { contacts: r.contacts, groups: r.groups },
                    "directory resynced on connect",
                  );
                })
                .catch((err: unknown) => {
                  if (rebuildState.directoryRebuildRequired) {
                    markDirectoryRebuildResult(
                      db,
                      config.account.name,
                      "directory synchronization failed",
                    );
                  }
                  log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    "directory resync on connect failed",
                  );
                });
            }
          }
        },
        onClose(info) {
          historyTransport.disconnected();
          void runtimeStatus.update({
            connection: "disconnected",
            authLinked: !info.loggedOut,
          });
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
          historyTransport.attach(sock);
          registerIngestion(sock, ingestDeps, {
            classify: (message) =>
              history.classifyMessage(
                message.key.remoteJid ?? "",
                baileysTimestamp(message.messageTimestamp),
              ),
            onStored: (_message, stored, classification) =>
              history.onStoredResult(stored, classification),
          });
        },
      },
    });

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    control.start().catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "control socket unavailable; the dashboard cannot trigger a resync",
      );
    });

    history.recoverActive();

    connection.start().catch((err: unknown) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to start connection",
      );
      shutdown(1);
    });
  });
}

/**
 * Keep the ingestion process controllable when there is no completed Baileys
 * session. It deliberately does not create a WhatsApp socket until the local,
 * authenticated dashboard has requested pairing through the control socket.
 */
async function runBaileysWaitingForPairing(
  config: ReturnType<typeof loadConfig>,
  configPath: string,
  log: ReturnType<typeof appLogger>,
  signal?: AbortSignal,
): Promise<void> {
  // The dashboard keeps data maintenance available even before the first
  // linked device exists. The dashboard still speaks only to this local daemon.
  const db = openDb(config.paths.sqlite, { migrate: true });
  upsertAccount(db, {
    id: config.account.name,
    label: config.account.description ?? null,
  });
  recoverInterruptedMaintenanceOperations(db, config.account.name);
  const runtimeStatus = new RuntimeStatusWriter(config.paths.runtimeStatus, {
    transport: "baileys",
    connection: "disconnected",
    authLinked: false,
  });
  await runtimeStatus.update();
  log.info("no linked Baileys device yet; waiting for dashboard pairing");

  return new Promise<void>((resolve, reject) => {
    let stopped = false;
    let pairingInFlight = false;
    let finishing: Promise<void> | undefined;
    const pairingAbort = new AbortController();

    const finish = (): Promise<void> => {
      if (finishing) return finishing;
      stopped = true;
      pairingAbort.abort();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      signal?.removeEventListener("abort", onAbort);
      finishing = runtimeStatus
        .update({
          connection: "disconnected",
          authLinked: authStateExists(config.paths.authDir),
        })
        .catch(() => undefined)
        .then(() => control.close().catch(() => undefined))
        .then(() => {
          db.close();
          resolve();
        });
      return finishing;
    };
    const onSignal = (): void => void finish();
    const onAbort = (): void => void finish();

    const beginPairing = async (): Promise<void> => {
      try {
        await runLink({
          configPath,
          qr: true,
          qrOut: join(config.paths.dataDir, "pairing-qr.svg"),
          timeoutSec: 600,
          signal: pairingAbort.signal,
        });
      } catch (error) {
        if (!stopped) {
          log.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Baileys dashboard pairing did not complete",
          );
        }
      } finally {
        void finish();
      }
    };

    const control = new HistoryControlServer(
      config.paths.controlSocket,
      async (request) => {
        if (request.op === "maintenance.reset") {
          if (pairingInFlight) {
            throw new Error("Baileys pairing is already active");
          }
          if (request.confirmation !== maintenanceConfirmation(request.scope)) {
            throw new Error("invalid maintenance confirmation");
          }
          const operation = startMaintenanceOperation(
            db,
            config.account.name,
            request.scope,
          );
          void runMaintenanceOperation({
            db,
            accountId: config.account.name,
            scope: request.scope,
            mediaDir: config.paths.mediaDir,
            operationId: operation.id,
          }).catch((error: unknown) =>
            log.warn(
              { err: error instanceof Error ? error.message : String(error) },
              "maintenance reset failed",
            ),
          );
          return {
            maintenance: { operationId: operation.id, status: "queued" },
          };
        }
        if (request.op !== "pairing.start") {
          throw new Error("Baileys is awaiting an operator pairing request");
        }
        if (maintenanceIsActive(db, config.account.name)) {
          throw new Error("a maintenance operation is already active");
        }
        if (pairingInFlight) {
          throw new Error("Baileys pairing is already active");
        }
        pairingInFlight = true;
        void beginPairing();
        return { pairing: { status: "starting" } };
      },
    );

    if (signal?.aborted) {
      void finish();
      return;
    }
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    signal?.addEventListener("abort", onAbort, { once: true });
    control.start().catch((error: unknown) => {
      if (stopped) return;
      stopped = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      signal?.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * Block until the whatsmeow store holds a real linked device, re-checking with
 * a bounded backoff. Resolves `true` once linked, or `false` if the process is
 * asked to stop first. A bare store file left by an interrupted `link` is not a
 * session, so `run` must wait rather than exit — an exiting container under
 * `restart: unless-stopped` becomes a tight crash loop.
 */
async function waitForLinkedSession(
  storePath: string,
  log: ReturnType<typeof appLogger>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (whatsmeowSessionLinked(storePath)) return true;
  log.info(
    "no linked whatsmeow device yet; waiting. Run `link --qr` off-host and copy whatsmeow.db into the data dir.",
  );
  const backoffMs = [10_000, 30_000, 60_000];
  let attempt = 0;
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (linked: boolean): void => {
      if (timer) clearTimeout(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      signal?.removeEventListener("abort", onAbort);
      resolve(linked);
    };
    const onSignal = (): void => done(false);
    const onAbort = (): void => done(false);
    const tick = (): void => {
      if (whatsmeowSessionLinked(storePath)) {
        log.info("linked whatsmeow device detected; starting");
        done(true);
        return;
      }
      const delay =
        backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 60_000;
      attempt += 1;
      timer = setTimeout(tick, delay);
    };
    if (signal?.aborted) {
      done(false);
      return;
    }
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    signal?.addEventListener("abort", onAbort, { once: true });
    tick();
  });
}

async function runWhatsmeow(
  config: ReturnType<typeof loadConfig>,
  log: ReturnType<typeof appLogger>,
  signal?: AbortSignal,
): Promise<void> {
  const store = config.paths.whatsmeowStore;
  if (!(await waitForLinkedSession(store, log, signal))) {
    return; // asked to stop before a device was linked
  }

  let lock: SessionLock;
  try {
    lock = acquireSessionLock(store);
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      "cannot start ingestion",
    );
    process.exitCode = 1;
    return;
  }

  configurePostgresProjection(config, log);
  const db = openDb(config.paths.sqlite, { migrate: true });
  upsertAccount(db, {
    id: config.account.name,
    label: config.account.description ?? null,
  });
  recoverInterruptedMaintenanceOperations(db, config.account.name);
  const transport = new WhatsmeowTransport({
    store: config.paths.whatsmeowStore,
    config: config.whatsmeow,
  });
  const history = new HistoryCoordinator({
    db,
    accountId: config.account.name,
    transport,
    logger: log,
  });
  const directory = new DirectorySync({
    db,
    accountId: config.account.name,
    logger: log,
    transport,
  });
  directory.register();
  let transportConnected = false;
  let pendingDirectoryRebuildOperation: string | null = null;
  let directoryResyncInFlight = false;
  // The transport exposes directory reads but not a connection-ready getter.
  // Serialize reads so a group refresh cannot race a destructive reset.
  let directorySyncQueue: Promise<void> = Promise.resolve();
  const syncDirectory = async (selection: {
    groups: boolean;
    contacts: boolean;
  }) => {
    const task = directorySyncQueue
      .catch(() => undefined)
      .then(() => directory.sync(selection));
    directorySyncQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  const finishDirectoryRebuild = async (operationId: string): Promise<void> => {
    try {
      const report = await syncDirectory({ groups: true, contacts: true });
      markDirectoryRebuildResult(db, config.account.name, null);
      completeMaintenanceOperation(db, config.account.name, operationId);
      log.info(
        { contacts: report.contacts, groups: report.groups },
        "directory rebuilt after maintenance",
      );
    } catch (error) {
      markDirectoryRebuildResult(
        db,
        config.account.name,
        "directory synchronization failed",
      );
      failMaintenanceOperation(
        db,
        config.account.name,
        operationId,
        "directory_rebuild_failed",
      );
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "directory maintenance rebuild failed",
      );
    } finally {
      if (pendingDirectoryRebuildOperation === operationId) {
        pendingDirectoryRebuildOperation = null;
      }
    }
  };

  const executeMaintenanceReset = async (
    scope: MaintenanceScope,
    operationId: string,
  ): Promise<void> => {
    const rebuildDirectory = scope === "directory" || scope === "all";
    try {
      await runMaintenanceOperation({
        db,
        accountId: config.account.name,
        scope,
        mediaDir: config.paths.mediaDir,
        operationId,
        deferCompletion: rebuildDirectory,
      });
      if (!rebuildDirectory) return;
      if (!transportConnected) {
        pendingDirectoryRebuildOperation = operationId;
        return;
      }
      await finishDirectoryRebuild(operationId);
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "maintenance reset failed",
      );
    }
  };

  const resumeDirectoryRebuildOnConnect = (): void => {
    if (pendingDirectoryRebuildOperation) {
      void finishDirectoryRebuild(pendingDirectoryRebuildOperation);
      return;
    }
    const state = maintenanceState(db, config.account.name);
    if (!state.directoryRebuildRequired || state.active) return;
    // A prior daemon may have been interrupted after clearing the directory.
    // Record this new, non-destructive rebuild phase so the dashboard retains
    // the same exclusion and progress semantics until the snapshot is stored.
    const operation = startMaintenanceOperation(
      db,
      config.account.name,
      "directory",
    );
    beginMaintenanceOperation(db, config.account.name, operation.id);
    void finishDirectoryRebuild(operation.id);
  };
  const control = new HistoryControlServer(
    config.paths.controlSocket,
    async (request) => {
      if (request.op === "maintenance.reset") {
        if (directoryResyncInFlight) {
          throw new Error("directory resynchronization is already active");
        }
        if (request.confirmation !== maintenanceConfirmation(request.scope)) {
          throw new Error("invalid maintenance confirmation");
        }
        history.cancelForMaintenance();
        const operation = startMaintenanceOperation(
          db,
          config.account.name,
          request.scope,
        );
        void executeMaintenanceReset(request.scope, operation.id);
        return {
          maintenance: { operationId: operation.id, status: "queued" },
        };
      }
      if (request.op === "directory.resync") {
        if (maintenanceIsActive(db, config.account.name)) {
          throw new Error("a maintenance operation is already active");
        }
        if (directoryResyncInFlight) {
          throw new Error("directory resynchronization is already active");
        }
        directoryResyncInFlight = true;
        try {
          const report = await syncDirectory({ groups: true, contacts: true });
          return {
            resynced: { contacts: report.contacts, groups: report.groups },
          };
        } finally {
          directoryResyncInFlight = false;
        }
      }
      if (request.op !== "history.start") {
        throw new Error("Baileys pairing is not available with whatsmeow");
      }
      if (maintenanceIsActive(db, config.account.name)) {
        throw new Error("a maintenance operation is already active");
      }
      const chatJid = normalizeJid(request.chat);
      const chat = getChat(db, config.account.name, chatJid);
      if (!chat || chat.is_blocked === 1 || chat.is_allowed !== 1) {
        throw new Error("chat is not available");
      }
      if (request.since < 0 || request.since > Math.floor(Date.now() / 1000)) {
        throw new Error("since must not be in the future");
      }
      const result = await history.start(chatJid, request.since);
      return {
        jobId: result.job.id,
        status: result.job.status,
        reused: result.reused,
      };
    },
  );
  try {
    await control.start();
  } catch (error) {
    db.close();
    throw error;
  }
  history.recoverActive();
  const refreshGroupDirectory = (): void => {
    void syncDirectory({ groups: true, contacts: false })
      .then((report) => {
        log.debug(
          { groups: report.groups, members: report.members },
          "refreshed group directory",
        );
      })
      .catch(() => {
        log.warn("failed to refresh group directory");
      });
  };
  const runtimeStatus = new RuntimeStatusWriter(config.paths.runtimeStatus, {
    transport: "whatsmeow",
    connection: "disconnected",
    authLinked: whatsmeowSessionLinked(store),
  });
  void runtimeStatus.update();
  registerWhatsmeowIngestion(
    transport,
    {
      db,
      accountId: config.account.name,
      config,
      logger: log,
      ...(postgresProjectionEnabled()
        ? {}
        : { outboxKey: ensureOutboxKey(config.paths.outboxKey) }),
    },
    {
      onEvent: () =>
        void runtimeStatus.update({
          lastEventAt: Math.floor(Date.now() / 1000),
        }),
      classify: (event) => history.classify(event),
      onStored: (event, stored, classification) =>
        history.onStored(event, stored, classification),
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
    const heartbeat = setInterval(
      () => void runtimeStatus.update(),
      RUNTIME_STATUS_HEARTBEAT_MS,
    );
    const shutdown = (code: number): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("shutting down");
      clearInterval(heartbeat);
      void runtimeStatus.update({ connection: "disconnected" });
      void control
        .close()
        .finally(() => transport.stop())
        .finally(() =>
          closeDbAfterPostgresProjection(db).catch(() => undefined),
        )
        .finally(() => {
          lock.release();
          if (code !== 0) process.exitCode = code;
          resolve();
        });
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    const onSignal = (): void => shutdown(0);

    transport.on("connected", ({ jid }) => {
      transportConnected = true;
      const selfJid = normalizeJid(jid);
      upsertAccount(db, { id: config.account.name, selfJid });
      resumeDirectoryRebuildOnConnect();
      refreshGroupDirectory();
      void runtimeStatus.update({
        connection: "connected",
        authLinked: true,
        lastEventAt: Math.floor(Date.now() / 1000),
      });
      log.info({ selfJid, transport: "whatsmeow" }, "connected");
    });
    transport.on("disconnected", () => {
      transportConnected = false;
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
