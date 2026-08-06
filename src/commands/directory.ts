import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { upsertAccount } from "../db/queries.js";
import { appLogger, resolveConfigPath } from "../runtime.js";
import { DirectorySync } from "../whatsmeow/directory.js";
import { WhatsmeowTransport } from "../whatsmeow/transport.js";

export interface DirectorySyncOptions {
  configPath?: string;
  groups?: boolean;
  contacts?: boolean;
  jid?: string;
  json?: boolean;
}

/** Run an explicit metadata-only directory synchronization. */
export async function runDirectorySync(
  options: DirectorySyncOptions = {},
): Promise<void> {
  const config = loadConfig(resolveConfigPath(options.configPath));
  if (config.transport !== "whatsmeow") {
    throw new Error("directory sync requires transport: whatsmeow");
  }
  if (!existsSync(config.paths.whatsmeowStore)) {
    throw new Error(
      "No linked whatsmeow device found. Run `whatsapp-conduit link --qr` first.",
    );
  }

  const db = openDb(config.paths.sqlite, { migrate: true });
  const log = appLogger(config);
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

  try {
    upsertAccount(db, {
      id: config.account.name,
      label: config.account.description ?? null,
    });
    await startAndWaitForConnection(transport);
    try {
      const report = await directory.sync({
        groups: options.groups,
        contacts: options.contacts,
        jid: options.jid,
      });
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ ...report, errors: [] }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(
          `Directory synchronized: ${report.groups} group(s), ` +
            `${report.members} member record(s), ${report.contacts} contact(s).\n`,
        );
      }
    } catch (error) {
      if (!options.json) throw error;
      process.stdout.write(
        `${JSON.stringify(
          {
            groups: 0,
            members: 0,
            contacts: 0,
            errors: [safeDirectoryError(error)],
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await transport.stop().catch(() => undefined);
    db.close();
  }
}

function safeDirectoryError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "directory sync failed";
  if (message.includes("not known")) return "contact JID is not known";
  if (message.includes("can only be synchronized")) return message;
  if (message.includes("timed out"))
    return "timed out waiting for WhatsApp connection";
  return "directory synchronization failed";
}

async function startAndWaitForConnection(
  transport: WhatsmeowTransport,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("timed out waiting for WhatsApp connection")),
      120_000,
    );
    timeout.unref?.();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      transport.off("connected", onConnected);
      transport.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onConnected = (): void => finish();
    const onError = (error: Error): void => finish(error);
    transport.on("connected", onConnected);
    transport.on("error", onError);
    void transport
      .start()
      .catch((error: unknown) =>
        finish(
          error instanceof Error ? error : new Error("transport start failed"),
        ),
      );
  });
}
