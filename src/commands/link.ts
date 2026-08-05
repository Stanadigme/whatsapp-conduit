import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import qrcode from "qrcode-terminal";
import type { WASocket } from "baileys";
import { loadConfig, type Config } from "../config.js";
import { clearPendingPairing, openAuthState } from "../baileys/auth.js";
import { ConduitConnection, statusCodeOf } from "../baileys/connect.js";
import { phoneFromJid } from "../baileys/jid.js";
import { openDb } from "../db/index.js";
import { upsertAccount } from "../db/queries.js";
import { appLogger, baileysLogger, resolveConfigPath } from "../runtime.js";

export interface LinkOptions {
  configPath?: string;
  /** Seconds to wait for pairing before giving up. Default 120. */
  timeoutSec?: number;
  /** Use the QR fallback instead of pairing-code linking. */
  qr?: boolean;
  /** E.164 phone number without the leading plus sign. */
  phoneNumber?: string;
}

export interface LinkResult {
  selfJid?: string;
  accountId: string;
}

/**
 * Link the WhatsApp account as a secondary device via QR code, persisting auth
 * state. Resolves once the connection reaches `open`; rejects on logout, an
 * unrecoverable close, or timeout. Strictly observe-only — it only reads the
 * connection lifecycle and stores the account identity.
 */
export async function runLink(options: LinkOptions = {}): Promise<LinkResult> {
  const config = loadConfig(resolveConfigPath(options.configPath));
  const timeoutSec = options.timeoutSec ?? 120;
  const useQr = options.qr ?? false;
  const phoneNumber = useQr
    ? undefined
    : await resolvePhoneNumber(options.phoneNumber);
  const log = appLogger(config);
  const authState = await openAuthState(config.paths.authDir);

  return new Promise<LinkResult>((resolve, reject) => {
    let settled = false;
    let pairingRequested = false;
    let pairingSocket: WASocket | undefined;

    const connection = new ConduitConnection({
      config,
      authState,
      logger: baileysLogger(config),
      mode: "link",
      handlers: {
        onSocket(sock) {
          if (!useQr) pairingSocket = sock;
        },
        onQr(qr) {
          if (!useQr) return;
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
          if (useQr || pairingRequested || !pairingSocket || !phoneNumber) {
            return;
          }
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
    upsertAccount(db, {
      id: config.account.name,
      label: config.account.description ?? null,
      selfJid: selfJid ?? null,
      phoneNumber: selfJid ? (phoneFromJid(selfJid) ?? null) : null,
    });
    return config.account.name;
  } finally {
    db.close();
  }
}
