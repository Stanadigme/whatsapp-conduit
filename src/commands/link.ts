import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { WhatsmeowTransport } from "../whatsmeow/transport.js";
import { acquireSessionLock } from "../whatsmeow/session-lock.js";
import { createVersionResolver } from "../baileys/version.js";

export interface LinkOptions {
  configPath?: string;
  /** Seconds to wait for pairing before giving up. Default 120. */
  timeoutSec?: number;
  /** Use the QR fallback instead of pairing-code linking. */
  qr?: boolean;
  /** E.164 phone number without the leading plus sign. */
  phoneNumber?: string;
  /**
   * Write each QR payload as an SVG to this path (headless pairing). Refreshed
   * on every rotation; the connection is restarted until the code is scanned or
   * the timeout fires.
   */
  qrOut?: string;
}

export interface LinkResult {
  selfJid?: string;
  accountId: string;
}

export interface LinkConnection {
  start(): Promise<void>;
  stop(): void;
}

export interface LinkDependencies {
  connectionFactory?: (deps: ConnectionDeps) => LinkConnection;
}

/**
 * Link the WhatsApp account as a secondary device via QR code, persisting auth
 * state. Resolves once the connection reaches `open`; rejects on logout, an
 * unrecoverable close, or timeout. Strictly observe-only — it only reads the
 * connection lifecycle and stores the account identity.
 */
export async function runLink(
  options: LinkOptions = {},
  dependencies: LinkDependencies = {},
): Promise<LinkResult> {
  const config = loadConfig(resolveConfigPath(options.configPath));
  if (
    config.transport === "whatsmeow" &&
    dependencies.connectionFactory === undefined
  ) {
    return runWhatsmeowLink(config, options.timeoutSec ?? 120);
  }
  const timeoutSec = options.timeoutSec ?? 120;
  const useQr = options.qr ?? false;
  const phoneNumber = useQr
    ? undefined
    : await resolvePhoneNumber(options.phoneNumber);
  const log = appLogger(config);
  const authState = await openAuthState(config.paths.authDir);

  const qrOut = useQr ? options.qrOut : undefined;
  if (qrOut) mkdirSync(dirname(qrOut), { recursive: true });

  return new Promise<LinkResult>((resolve, reject) => {
    let settled = false;
    let pairingRequested = false;
    let pairingSocket: WASocket | undefined;
    let qrRestarts = 0;
    const MAX_QR_RESTARTS = 40;

    const connection = (
      dependencies.connectionFactory ?? ((deps) => new ConduitConnection(deps))
    )({
      config,
      authState,
      logger: baileysLogger(config),
      mode: "link",
      fetchVersion: createVersionResolver(config, log),
      handlers: {
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
          if (!config.baileys.printQrInTerminal) {
            // The QR payload is a live pairing token; honor the operator's
            // choice to keep it out of (possibly captured) stdout.
            log.warn(
              "a QR code is available but baileys.print_qr_in_terminal is false; " +
                "enable it to display the code and link a device",
            );
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
            }
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
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);

          const accountId = persistAccount(config, info.selfJid);
          process.stdout.write(
            `\nLinked successfully${info.selfJid ? ` as ${info.selfJid}` : ""}.\n` +
              "Auth state saved. You can now run `whatsapp-conduit run`.\n",
          );
          connection.stop();
          resolve({ selfJid: info.selfJid, accountId });
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

    connection.start().catch((err: unknown) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.stop();
      void clearPendingPairing(authState)
        .catch(() => {
          log.warn("failed to clear incomplete pairing state");
        })
        .finally(() => reject(error));
    }
  });
}

async function runWhatsmeowLink(
  config: Config,
  timeoutSec: number,
): Promise<LinkResult> {
  const log = appLogger(config);
  // A running ingestion daemon must not share the store with an interactive
  // pairing (ADR-0009). Take the lock before touching whatsmeow at all.
  const lock = acquireSessionLock(config.paths.whatsmeowStore);
  const transport = new WhatsmeowTransport({
    store: config.paths.whatsmeowStore,
    config: config.whatsmeow,
  });
  return new Promise<LinkResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`Linking timed out after ${timeoutSec}s.`));
    }, timeoutSec * 1000);

    transport.on("connected", ({ jid }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const accountId = persistAccount(config, jid);
      process.stdout.write(
        `\nLinked successfully as ${jid}.\n` +
          "Auth state saved. You can now run `whatsapp-conduit run`.\n",
      );
      void transport.stop();
      lock.release();
      resolve({ selfJid: jid, accountId });
    });
    transport.on("error", (error) => {
      if (!settled) fail(error);
      else log.error({ err: error.message }, "whatsmeow pairing error");
    });
    transport.on("disconnected", () => {
      if (!settled) fail(new Error("Linking failed: whatsmeow disconnected."));
    });

    transport
      .startPairing((code) => {
        process.stdout.write(
          "\nScan this QR code in WhatsApp → Settings → Linked Devices → Link a device:\n\n",
        );
        qrcode.generate(code, { small: true });
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void transport.stop().finally(() => {
        lock.release();
        reject(error);
      });
    }
  });
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

function persistAccount(config: Config, selfJid?: string): string {
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
