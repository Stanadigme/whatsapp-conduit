import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { authStateExists } from "../baileys/auth.js";
import { whatsmeowSessionLinked } from "../whatsmeow/session.js";
import { openDb } from "../db/index.js";
import {
  countAllowedChats,
  countChats,
  countMessages,
  latestMessageTimestamp,
  listAccounts,
} from "../db/queries.js";
import { resolveConfigPath } from "../runtime.js";

export interface StatusAccount {
  id: string;
  selfJid: string | null;
  phoneNumber: string | null;
}

export interface StatusReport {
  configPath: string;
  transport: string;
  database: string;
  databaseExists: boolean;
  authDir: string;
  authStore: string;
  authLinked: boolean;
  observeOnly: boolean;
  sendEnabled: boolean;
  accounts: StatusAccount[];
  chats: number;
  allowedChats: number;
  messages: number;
  latestMessageTs: number | null;
}

export interface StatusOptions {
  configPath?: string;
  json?: boolean;
}

export function buildStatusReport(configPath: string): StatusReport {
  const config = loadConfig(configPath);
  const databaseExists = existsSync(config.paths.sqlite);
  const authStore =
    config.transport === "whatsmeow"
      ? config.paths.whatsmeowStore
      : config.paths.authDir;
  // For whatsmeow, a store file left by an interrupted `link` still exists but
  // holds no device. Check the store contents, not just its presence.
  const authLinked =
    config.transport === "whatsmeow"
      ? whatsmeowSessionLinked(authStore)
      : existsSync(authStore) && authStateExists(config.paths.authDir);

  const base: StatusReport = {
    configPath,
    transport: config.transport,
    database: config.paths.sqlite,
    databaseExists,
    authDir: config.paths.authDir,
    authStore,
    authLinked,
    observeOnly: config.privacy.observeOnly,
    sendEnabled: config.privacy.sendEnabled,
    accounts: [],
    chats: 0,
    allowedChats: 0,
    messages: 0,
    latestMessageTs: null,
  };

  if (!databaseExists) return base;

  const db = openDb(config.paths.sqlite, { migrate: false, readonly: true });
  try {
    return {
      ...base,
      accounts: listAccounts(db).map((a) => ({
        id: a.id,
        selfJid: a.self_jid,
        phoneNumber: a.phone_number,
      })),
      chats: countChats(db),
      allowedChats: countAllowedChats(db),
      messages: countMessages(db),
      latestMessageTs: latestMessageTimestamp(db),
    };
  } finally {
    db.close();
  }
}

export function runStatus(options: StatusOptions = {}): void {
  const configPath = resolveConfigPath(options.configPath);
  const report = buildStatusReport(configPath);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const latest =
    report.latestMessageTs !== null
      ? new Date(report.latestMessageTs * 1000).toISOString()
      : "—";
  const accountLine =
    report.accounts.length > 0
      ? report.accounts
          .map((a) => `${a.id}${a.selfJid ? ` (${a.selfJid})` : ""}`)
          .join(", ")
      : "none (run `whatsapp-conduit link`)";

  const lines = [
    "whatsapp-conduit status",
    `  config:        ${report.configPath}`,
    `  transport:     ${report.transport}`,
    `  database:      ${report.database}${report.databaseExists ? "" : " (missing)"}`,
    `  auth:          ${report.authLinked ? "linked" : "not linked"} (${report.authStore})`,
    `  posture:       observe_only=${report.observeOnly} send_enabled=${report.sendEnabled}`,
    `  accounts:      ${accountLine}`,
    `  chats:         ${report.chats} (${report.allowedChats} allowed)`,
    `  messages:      ${report.messages}`,
    `  latest msg:    ${latest}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
