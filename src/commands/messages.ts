import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { McpRequestError } from "../mcp/types.js";
import {
  listMessages,
  type MessageView as ReadMessageView,
} from "../read/messages.js";
import { resolveConfigPath } from "../runtime.js";
import { parseSinceSec } from "../util/time.js";

export interface MessagesListOptions {
  configPath?: string | undefined;
  chat?: string | undefined;
  since?: string | undefined;
  limit?: number | undefined;
  json?: boolean | undefined;
}

interface MessageView {
  chatJid: string;
  messageId: string;
  senderJid: string | null;
  fromMe: boolean;
  timestamp: number | null;
  messageType: string | null;
  text: string | null;
  hasMedia: boolean;
  deleted: boolean;
}

function toView(row: ReadMessageView): MessageView {
  return {
    chatJid: row.chatJid,
    messageId: row.messageId,
    senderJid: row.senderJid,
    fromMe: row.fromMe,
    timestamp: row.timestamp,
    messageType: row.messageType,
    text: row.text,
    hasMedia: row.hasMedia,
    deleted: row.deletedAt !== null,
  };
}

/**
 * Lists stored messages, allowed conversations only.
 *
 * This goes through the shared read path rather than querying `messages`
 * directly: the allowlist is a SQL predicate repeated in every read, not a
 * middleware, so a query written straight against the table silently bypasses
 * it. Inspecting from a terminal is no reason to print conversations the
 * account holder deliberately excluded from the processing scope.
 */
export function runMessagesList(options: MessagesListOptions = {}): void {
  const config = loadConfig(resolveConfigPath(options.configPath));
  const sinceTs =
    options.since !== undefined ? parseSinceSec(options.since) : null;

  const db = openDb(config.paths.sqlite, { migrate: false, readonly: true });
  try {
    let rows: MessageView[];
    try {
      rows = listMessages(
        { db, accountId: config.account.name },
        {
          ...(options.chat !== undefined ? { chat: options.chat } : {}),
          ...(sinceTs !== null ? { after: sinceTs } : {}),
          limit: options.limit ?? 50,
        },
      ).items.map(toView);
    } catch (error) {
      if (error instanceof McpRequestError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    if (rows.length === 0) {
      process.stdout.write("No messages.\n");
      return;
    }
    for (const row of rows) {
      const when = row.timestamp
        ? new Date(row.timestamp * 1000).toISOString()
        : "—";
      const dir = row.fromMe ? "→" : "←";
      const body = row.deleted
        ? "(deleted)"
        : (row.text ??
          `(${row.messageType ?? "no text"}${row.hasMedia ? ", media" : ""})`);
      process.stdout.write(`${when}  ${dir} ${row.chatJid}  ${body}\n`);
    }
  } finally {
    db.close();
  }
}
