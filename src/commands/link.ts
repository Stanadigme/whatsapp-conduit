import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import qrcode from "qrcode-terminal";
import { qrSvg } from "../util/qr-svg.js";
import type { WASocket } from "baileys";
import { loadConfig, type Config } from "../config.js";
import { clearPendingPairing, openAuthState } from "../baileys/auth.js";
import {
  ConduitConnection,
  statusCodeOf,
  type ConnectionDeps,
} from "../baileys/connect.js";
import { normalizeJid, phoneFromJid } from "../baileys/jid.js";
import { openDb } from "../db/index.js";
import { upsertAccount } from "../db/queries.js";
import { appLogger, baileysLogger, resolveConfigPath } from "../runtime.js";
import { createVersionResolver } from "../baileys/version.js";
import { acquireBaileysSessionLock } from "../baileys/session-lock.js";
import type { BaileysSessionLock } from "../baileys/session-lock.js";
import type { AuthState } from "../baileys/auth.js";
import {
  registerIngestion,
  type BaileysIngestionOptions,
  type IngestDeps,
} from "../baileys/ingest.js";
import { markDirectoryRebuildResult } from "../db/maintenance.js";

export interface LinkOptions {
  configPath?: string | undefined;
  /** Seconds to wait for pairing before giving up. Default 120. */
  timeoutSec?: number | undefined;
  /** Use the QR fallback instead of pairing-code linking. */
  qr?: boolean | undefined;
  /** E.164 phone number without the leading plus sign. */
  phoneNumber?: string | undefined;
  /**
   * Write each QR payload as an SVG to this path (headless pairing). Refreshed
   * on every rotation; the connection is restarted until the code is scanned or
   * the timeout fires.
   */
  qrOut?: string | undefined;
  /** Abort an in-progress QR session without retaining a live QR file. */
  signal?: AbortSignal | undefined;
}

export interface LinkResult {
  selfJid?: string | undefined;
  accountId: string;
  /** False only when the new auth works but directory resync could not be queued. */
  directoryRebuildReady: boolean;
  retained?: {
    connection: ConduitConnection;
    authState: AuthState;
    sessionLock: BaileysSessionLock;
  };
}

export interface LinkConnection {
  start(): Promise<void>;
  stop(): void | Promise<void>;
}

export interface LinkDependencies {
  connectionFactory?: (deps: ConnectionDeps) => LinkConnection;
  /** Daemon handoff: ingestion uses its open database and keeps the socket. */
  retainConnection?: boolean;
  ingestDeps?: IngestDeps;
  ingestionOptions?: BaileysIngestionOptions;
  registerSocket?: ConnectionDeps["handlers"]["registerSocket"];
}

/**
 * Link the WhatsApp account as a secondary device via QR code, persisting auth
 * state. Resolves only after the connection reaches `open` and Baileys has
 * persisted its `myAppStateKeyId`; rejects on logout, an unrecoverable close,
 * or timeout. Strictly observe-only — it only reads the connection lifecycle
 * and stores the account identity.
 */
export async function runLink(
  options: LinkOptions = {},
  dependencies: LinkDependencies = {},
): Promise<LinkResult> {
  const config = loadConfig(resolveConfigPath(options.configPath));
  const timeoutSec = options.timeoutSec ?? 120;
  const useQr = options.qr ?? false;
  const phoneNumber = useQr
    ? undefined
    : await resolvePhoneNumber(options.phoneNumber);
  const log = appLogger(config);
  const sessionLock = acquireBaileysSessionLock(config.paths.authDir);
  let retained = false;
  try {
    const authState = await openAuthState(config.paths.authDir);
    const ownDb = dependencies.ingestDeps
      ? undefined
      : openDb(config.paths.sqlite, { migrate: true });
    if (ownDb)
      upsertAccount(ownDb, {
        id: config.account.name,
        label: config.account.description ?? null,
      });
    const ingestDeps = dependencies.ingestDeps ?? {
      db: ownDb!,
      accountId: config.account.name,
      config,
      logger: log,
    };

    const qrOut = useQr ? options.qrOut : undefined;
    if (qrOut) mkdirSync(dirname(qrOut), { recursive: true });

    const linked = await new Promise<Omit<LinkResult, "directoryRebuildReady">>(
      (resolve, reject) => {
        let settled = false;
        let pairingRequested = false;
        let pairingSocket: WASocket | undefined;
        let qrRestarts = 0;
        let opened: { selfJid?: string | undefined } | undefined;
        let appStateKeySaved = false;
        const MAX_QR_RESTARTS = 40;

        const connection = (
          dependencies.connectionFactory ??
          ((deps) => new ConduitConnection(deps))
        )({
          config,
          authState,
          logger: baileysLogger(config),
          mode: "link",
          fetchVersion: createVersionResolver(config, log),
          handlers: {
            registerSocket(sock) {
              if (dependencies.registerSocket)
                dependencies.registerSocket(sock);
              else
                registerIngestion(
                  sock,
                  ingestDeps,
                  dependencies.ingestionOptions,
                );
            },
            onSocket(sock) {
              if (!useQr) pairingSocket = sock;
            },
            onQr(qr) {
              if (!useQr) {
                if (pairingRequested || !pairingSocket || !phoneNumber) return;
                pairingRequested = true;
                void requestPairingCode(pairingSocket, phoneNumber)
                  .then((code) => {
                    process.stdout.write(
                      "\nEnter this pairing code in WhatsApp → Settings → Linked Devices:\n\n" +
                        `${code}\n\n`,
                    );
                  })
                  .catch((err: unknown) => {
                    log.error(
                      { statusCode: statusCodeOf(err) },
                      "failed to request pairing code",
                    );
                    fail(pairingFailure(err));
                  });
                return;
              }
              if (qrOut) {
                try {
                  writeFileSync(qrOut, qrSvg(qr, { px: 800 }), { mode: 0o600 });
                  process.stdout.write(`QR code written to ${qrOut}\n`);
                } catch (err) {
                  log.warn(
                    { err: err instanceof Error ? err.message : String(err) },
                    "failed to write the QR SVG",
                  );
                  fail(new Error("failed to write QR SVG"));
                  return;
                }
                // `--qr-out` is used by a protected dashboard. Never render the
                // live credential to stdout as container logs may retain it.
                return;
              }
              if (!config.baileys.printQrInTerminal) {
                // The QR payload is a live pairing token; honor the operator's
                // choice to keep it out of (possibly captured) stdout.
                log.warn(
                  "a QR code is available but baileys.print_qr_in_terminal is false; " +
                    "enable it to display the code and link a device",
                );
                return;
              }
              process.stdout.write(
                "\nScan this QR code in WhatsApp → Settings → Linked Devices → Link a device:\n\n",
              );
              qrcode.generate(qr, { small: true });
            },
            onConnecting() {
              log.info("connecting to WhatsApp");
            },
            onOpen(info) {
              opened = info;
              completeWhenReady();
            },
            onCredsUpdate(update) {
              if (update.myAppStateKeyId) {
                appStateKeySaved = true;
                completeWhenReady();
              }
            },
            onClose(info) {
              if (settled) return;
              if (info.willReconnect) {
                log.info("restarting connection to complete pairing");
                return;
              }
              // In QR mode a non-logged-out close is almost always an unscanned
              // code expiring (status 408/428). Keep the pairing window open by
              // restarting with a fresh code until the timeout fires.
              if (useQr && !info.loggedOut && qrRestarts < MAX_QR_RESTARTS) {
                qrRestarts += 1;
                log.info(
                  { statusCode: info.statusCode, attempt: qrRestarts },
                  "QR code expired without a scan; issuing a new one",
                );
                connection.start().catch((err: unknown) => {
                  fail(err instanceof Error ? err : new Error(String(err)));
                });
                return;
              }
              fail(
                new Error(
                  info.loggedOut
                    ? "Linking failed: logged out. Remove the auth directory and try again."
                    : `Linking failed: connection closed (status ${info.statusCode ?? "unknown"}).`,
                ),
              );
            },
          },
        });

        const timer = setTimeout(() => {
          fail(new Error(`Linking timed out after ${timeoutSec}s.`));
        }, timeoutSec * 1000);

        const onAbort = (): void => fail(new Error("Linking cancelled."));
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });

        connection.start().catch((err: unknown) => {
          fail(err instanceof Error ? err : new Error(String(err)));
        });

        function fail(error: Error): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          removeQrOutput();
          void Promise.resolve(connection.stop())
            .then(() => ownDb?.close())
            .then(() => clearPendingPairing(authState))
            .catch(() => {
              log.warn("failed to clear incomplete pairing state");
            })
            .finally(() => reject(error));
        }

        function removeQrOutput(): void {
          if (!qrOut) return;
          try {
            unlinkSync(qrOut);
          } catch {
            // It may not have been written yet, or the data volume may already
            // have been removed by the operator. In both cases fail closed.
          }
        }

        function completeWhenReady(): void {
          if (settled || !opened || !appStateKeySaved) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          const keep =
            dependencies.retainConnection &&
            connection instanceof ConduitConnection;
          void (async () => {
            try {
              if (!keep) await connection.stop();
              removeQrOutput();
              const accountId = persistAccount(config, opened?.selfJid);
              if (!keep) ownDb?.close();
              process.stdout.write(
                `\nLinked successfully${opened?.selfJid ? ` as ${opened.selfJid}` : ""}.\n` +
                  "Auth state saved. Directory reconstruction will start on the next connection.\n",
              );
              resolve({
                selfJid: opened?.selfJid,
                accountId,
                ...(keep
                  ? { retained: { connection, authState, sessionLock } }
                  : {}),
              });
            } catch (error) {
              await connection.stop();
              ownDb?.close();
              removeQrOutput();
              await clearPendingPairing(authState).catch(() => undefined);
              reject(error);
            }
          })();
        }
      },
    );
    const directoryRebuildReady = prepareDirectoryRebuild(config);
    retained = !!linked.retained;
    return { ...linked, directoryRebuildReady };
  } finally {
    if (!retained) sessionLock.release();
  }
}

/** Request the normal directory resync without deleting pairing metadata. */
function prepareDirectoryRebuild(config: Config): boolean {
  const db = openDb(config.paths.sqlite, { migrate: true });
  try {
    markDirectoryRebuildResult(
      db,
      config.account.name,
      "directory resync pending",
    );
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function resolvePhoneNumber(phoneNumber?: string): Promise<string> {
  if (phoneNumber && /^\d{6,15}$/.test(phoneNumber)) return phoneNumber;
  if (phoneNumber) {
    throw new Error("The phone number must be E.164 digits without '+'.");
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "Pairing-code linking requires a TTY; pass --phone or use --qr.",
    );
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "WhatsApp phone number (E.164 digits without '+'): ",
    );
    if (!/^\d{6,15}$/.test(answer.trim())) {
      throw new Error("The phone number must be E.164 digits without '+'.");
    }
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function requestPairingCode(
  sock: Pick<WASocket, "waitForSocketOpen" | "requestPairingCode">,
  phoneNumber: string,
): Promise<string> {
  await sock.waitForSocketOpen();
  return sock.requestPairingCode(phoneNumber);
}

function pairingFailure(error: unknown): Error {
  const statusCode = statusCodeOf(error);
  return new Error(
    statusCode
      ? `Pairing-code request failed (status ${statusCode}).`
      : "Pairing-code request failed.",
  );
}

function persistAccount(config: Config, selfJid?: string | undefined): string {
  const db = openDb(config.paths.sqlite, { migrate: true });
  try {
    const normalizedSelfJid = selfJid ? normalizeJid(selfJid) : undefined;
    upsertAccount(db, {
      id: config.account.name,
      label: config.account.description ?? null,
      selfJid: normalizedSelfJid ?? null,
      phoneNumber: normalizedSelfJid
        ? (phoneFromJid(normalizedSelfJid) ?? null)
        : null,
    });
    return config.account.name;
  } finally {
    db.close();
  }
}
