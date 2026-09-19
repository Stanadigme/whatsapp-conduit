import { loadConfig } from "../config.js";
import { authStateExists, openAuthState } from "../baileys/auth.js";
import {
  ConduitConnection,
  type ConnectionHandlers,
} from "../baileys/connect.js";
import { acquireBaileysSessionLock } from "../baileys/session-lock.js";
import {
  prepareBaileysRelink,
  restoreBaileysRelink,
} from "../baileys/relink.js";
import {
  registerIngestion,
  type BaileysIngestionOptions,
  type IngestDeps,
} from "../baileys/ingest.js";
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
import {
  getActiveMediaBackfillJob,
  getChat,
  getMediaBackfillJob,
} from "../db/queries.js";
import { appLogger, baileysLogger, resolveConfigPath } from "../runtime.js";
import {
  HistoryControlServer,
  type MediaBackfillStatusRequest,
} from "../control/ipc.js";
import { HistoryCoordinator } from "../history/coordinator.js";
import { MediaBackfillCoordinator } from "../history/media-backfill-coordinator.js";
import { createVersionResolver } from "../baileys/version.js";
import { RuntimeStatusWriter } from "../runtime-status.js";
import { runLink, type LinkResult } from "./link.js";
import { join } from "node:path";
import {
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

function mediaBackfillStatus(
  db: ReturnType<typeof openDb>,
  accountId: string,
  request: MediaBackfillStatusRequest,
) {
  const job = request.jobId
    ? getMediaBackfillJob(db, accountId, request.jobId)
    : getActiveMediaBackfillJob(db, accountId);
  return {
    mediaBackfill: job
      ? {
          jobId: job.id,
          status: job.status,
          attachmentsFound: job.attachments_found,
          attachmentsDownloaded: job.attachments_downloaded,
          attachmentsFailed: job.attachments_failed,
          createdAt: job.created_at,
          startedAt: job.started_at,
          updatedAt: job.updated_at,
          completedAt: job.completed_at,
        }
      : null,
  };
}

/**
 * Resolve the outbox encryption key, or nothing when no snapshot must be
 * queued: the alpha profile (ADR-0033) writes the client database directly, and
 * the beta-profile replay queue is opt-in (`persistence.outbox.enabled`) since
 * no forwarder drains it yet. Returning `undefined` also means no `outbox.key`
 * file is created. Call after configurePostgresProjection().
 */
function resolveOutboxKey(
  config: ReturnType<typeof loadConfig>,
): Buffer | undefined {
  if (!config.persistence.outbox.enabled || postgresProjectionEnabled()) {
    return undefined;
  }
  return ensureOutboxKey(config.paths.outboxKey);
}

/**
 * Run the foreground observe-only sync daemon: connect, reconnect on transient
 * drops, and stay alive until SIGINT/SIGTERM. Message ingestion handlers are
 * attached to each socket via the connection's `registerSocket` hook.
 *
 * The returned promise resolves on graceful shutdown.
 */
export async function runRun(
  options: RunOptions = {},
  handoff?: NonNullable<LinkResult["retained"]> & {
    db: ReturnType<typeof openDb>;
    outboxKey?: Buffer;
    ingestionOptions?: BaileysIngestionOptions;
  },
): Promise<void> {
  const configPath = resolveConfigPath(options.configPath);
  const config = loadConfig(configPath);
  const log = appLogger(config);

  // A fresh auth state cannot connect by itself. Keep a local control socket
  // open so the authenticated dashboard can ask this same ingestion process to
  // own a QR pairing session (ADR-0026), rather than opening Baileys itself.
  if (!handoff && !authStateExists(config.paths.authDir)) {
    return runBaileysWaitingForPairing(config, configPath, log, options.signal);
  }

  let sessionLock =
    handoff?.sessionLock ?? acquireBaileysSessionLock(config.paths.authDir);

  configurePostgresProjection(config, log);
  const outboxKey = resolveOutboxKey(config);
  const db = handoff?.db ?? openDb(config.paths.sqlite, { migrate: true });

  upsertAccount(db, {
    id: config.account.name,
    label: config.account.description ?? null,
  });
  recoverInterruptedMaintenanceOperations(db, config.account.name);

  let authState =
    handoff?.authState ?? (await openAuthState(config.paths.authDir));
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
  // Constructed after `connection` below so its socket accessor can see the
  // live Baileys socket, including across reconnects (ADR-0039).
  let mediaBackfill: MediaBackfillCoordinator;

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
        if (request.op === "media-backfill.status") {
          return mediaBackfillStatus(db, config.account.name, request);
        }
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
        if (request.op === "daemon.restart") {
          if (maintenanceIsActive(db, config.account.name)) {
            throw new Error("a maintenance operation is already active");
          }
          setTimeout(() => shutdown(0), 100);
          return { restarting: { status: "restarting" } };
        }
        if (request.op === "directory.resync") {
          if (maintenanceIsActive(db, config.account.name)) {
            throw new Error("a maintenance operation is already active");
          }
          return { resynced: await runDirectoryResync() };
        }
        if (request.op === "media-backfill.start") {
          if (maintenanceIsActive(db, config.account.name)) {
            throw new Error("a maintenance operation is already active");
          }
          let scopedChat: string | null = null;
          if (request.chat) {
            scopedChat = normalizeJid(request.chat);
            const chat = getChat(db, config.account.name, scopedChat);
            if (!chat || chat.is_blocked === 1 || chat.is_allowed !== 1) {
              throw new Error("chat is not available");
            }
          }
          const backfillResult = await mediaBackfill.start(scopedChat);
          return {
            jobId: backfillResult.job.id,
            status: backfillResult.job.status,
            reused: backfillResult.reused,
          };
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
        const result = await history.start(
          chatJid,
          request.since,
          undefined,
          request.fetchMedia,
          request.anchor,
        );
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
      const statusUpdate = runtimeStatus
        .update({ connection: "disconnected" })
        .catch(() => undefined);
      pairingAbort?.abort();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      options.signal?.removeEventListener("abort", onAbort);
      void (async () => {
        await connection.stop().catch(() => undefined);
        await statusUpdate;
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
    const onAbort = (): void => shutdown(0);

    async function beginBaileysPairing(): Promise<void> {
      let archivedAuthDir: string | null = null;
      let linked = false;
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
        const result = await runLink(
          {
            configPath,
            qr: true,
            qrOut: join(config.paths.dataDir, "pairing-qr.svg"),
            timeoutSec: 600,
            signal: pairingAbort?.signal,
          },
          {
            retainConnection: true,
            ingestDeps,
            registerSocket,
          },
        );
        if (!result.retained)
          throw new Error("pairing connection was not retained");
        connection = result.retained.connection;
        authState = result.retained.authState;
        sessionLock = result.retained.sessionLock;
        connection.promote(handlers);
        linked = true;
        pairingInFlight = false;
        initialResyncDone = false;
        handlers.onOpen?.({ selfJid: result.selfJid });
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
        if (!linked && !shuttingDown) shutdown(0);
      }
    }

    const registerSocket: NonNullable<ConnectionHandlers["registerSocket"]> = (
      sock,
    ) => {
      historyTransport.attach(sock);
      registerIngestion(sock, ingestDeps, {
        classify: (message, requestId) =>
          history.classifyMessage(
            message.key.remoteJid ?? "",
            baileysTimestamp(message.messageTimestamp),
            requestId,
          ),
        onStored: (message, stored, classification) =>
          history.onStoredResult(stored, classification, message.key.remoteJid ?? undefined, message.key.id ?? undefined),
        onError: (ctx) => history.onStorageError(ctx),
      });
    };
    if (handoff?.ingestionOptions) {
      handoff.ingestionOptions.classify = (message, requestId) =>
        history.classifyMessage(
          message.key.remoteJid ?? "",
          baileysTimestamp(message.messageTimestamp),
          requestId,
        );
      handoff.ingestionOptions.onStored = (message, stored, classification) =>
        history.onStoredResult(stored, classification, message.key.remoteJid ?? undefined, message.key.id ?? undefined);
      handoff.ingestionOptions.onError = (ctx) => history.onStorageError(ctx);
    }
    const handlers: ConnectionHandlers = {
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
      registerSocket,
    };
    let connection =
      handoff?.connection ??
      new ConduitConnection({
        config,
        authState,
        logger: baileysLogger(config),
        mode: "run",
        fetchVersion: createVersionResolver(config, log),
        handlers,
      });
    mediaBackfill = new MediaBackfillCoordinator(ingestDeps, {
      socket: () => connection.socket(),
    });
    if (handoff) {
      connection.promote(handlers);
      const sock = connection.socket();
      if (sock) historyTransport.attach(sock);
      handlers.onOpen?.({ selfJid: undefined });
    }

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (options.signal?.aborted) {
      shutdown(0);
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    control.start().catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "control socket unavailable; the dashboard cannot trigger a resync",
      );
    });

    history.recoverActive();
    mediaBackfill.recoverActive();

    if (!handoff)
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
  configurePostgresProjection(config, log);
  const outboxKey = resolveOutboxKey(config);
  const db = openDb(config.paths.sqlite, { migrate: true });
  const ingestionOptions: BaileysIngestionOptions = {};
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

  const retained = await new Promise<
    NonNullable<LinkResult["retained"]> | undefined
  >((resolve, reject) => {
    let stopped = false;
    let pairingInFlight = false;
    let finishing: Promise<void> | undefined;
    const pairingAbort = new AbortController();

    const finish = (
      connection?: NonNullable<LinkResult["retained"]>,
    ): Promise<void> => {
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
          if (!connection) db.close();
          resolve(connection);
        });
      return finishing;
    };
    const onSignal = (): void => void finish();
    const onAbort = (): void => void finish();

    const beginPairing = async (): Promise<void> => {
      try {
        const result = await runLink(
          {
            configPath,
            qr: true,
            qrOut: join(config.paths.dataDir, "pairing-qr.svg"),
            timeoutSec: 600,
            signal: pairingAbort.signal,
          },
          {
            retainConnection: true,
            ingestDeps: {
              db,
              accountId: config.account.name,
              config,
              logger: log,
              ...(outboxKey ? { outboxKey } : {}),
            },
            ingestionOptions,
          },
        );
        if (!result.retained)
          throw new Error("pairing connection was not retained");
        await finish(result.retained);
        return;
      } catch (error) {
        if (!stopped) {
          log.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Baileys dashboard pairing did not complete",
          );
        }
      } finally {
        if (!stopped) void finish();
      }
    };

    const control = new HistoryControlServer(
      config.paths.controlSocket,
      async (request) => {
        if (request.op === "media-backfill.status") {
          return mediaBackfillStatus(db, config.account.name, request);
        }
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
  if (retained)
    await runRun(
      { configPath, signal },
      {
        ...retained,
        db,
        ...(outboxKey ? { outboxKey } : {}),
        ingestionOptions,
      },
    );
}
