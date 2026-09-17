import { reconstructMessageFromRawJson } from "../baileys/media-backfill.js";
import { resolveSender } from "../baileys/normalize.js";
import { loadConfig } from "../config.js";
import { openDb, type Database } from "../db/index.js";
import { getAccount } from "../db/queries.js";
import { defaultConfigPath } from "../paths.js";

export interface DbBackfillSenderOptions {
  configPath?: string | undefined;
  json?: boolean | undefined;
  dryRun?: boolean | undefined;
}

/**
 * Field names mirror the shape asked for in the phase plan (candidates,
 * unresolvable_no_raw_json, unresolvable_no_participant) rather than this
 * repo's usual camelCase report fields — kept literal since the plan spells
 * them out.
 */
export interface BackfillSenderReport {
  database: string;
  dry_run: boolean;
  candidates: number;
  updated: number;
  unresolvable_no_raw_json: number;
  unresolvable_no_participant: number;
}

interface CandidateRow {
  chat_jid: string;
  message_id: string;
  raw_json: string | null;
}

function resolveConfigPath(options: DbBackfillSenderOptions): string {
  return options.configPath ?? defaultConfigPath();
}

/**
 * One-shot repair for group-history rows stored before `resolveSender`
 * learned to fall back to the root `participant` field, and later to the
 * account's own JID for a `fromMe` message with no participant at all
 * (2026-09-17 phase, S2/S2b). Re-derives `sender_jid` from the `raw_json`
 * payload that was preserved at ingestion; every other column, `raw_json`
 * included, is left untouched (invariant n°8: the raw signal is never
 * overwritten, only a derived field is filled in).
 */
export function runDbBackfillSender(
  options: DbBackfillSenderOptions = {},
): BackfillSenderReport {
  const config = loadConfig(resolveConfigPath(options));
  const dryRun = options.dryRun === true;
  const db = openDb(config.paths.sqlite, { migrate: false });
  try {
    const counts = backfillSenderJids(db, config.account.name, dryRun);
    const report: BackfillSenderReport = {
      database: config.paths.sqlite,
      dry_run: dryRun,
      ...counts,
    };
    printReport(report, options.json === true);
    return report;
  } finally {
    db.close();
  }
}

export interface BackfillSenderCounts {
  candidates: number;
  updated: number;
  unresolvable_no_raw_json: number;
  unresolvable_no_participant: number;
}

/**
 * Exported separately from `runDbBackfillSender` so tests can drive it
 * against an in-memory database without going through config/CLI plumbing.
 */
export function backfillSenderJids(
  db: Database,
  accountId: string,
  dryRun: boolean,
): BackfillSenderCounts {
  const rows = db
    .prepare<
      [string],
      CandidateRow
    >(
      `select chat_jid, message_id, raw_json
       from messages
       where account_id = ?
         and ingestion_source = 'history'
         and chat_jid like '%@g.us'
         and sender_jid is null`,
    )
    .all(accountId);

  const selfJid = getAccount(db, accountId)?.self_jid;

  const counts: BackfillSenderCounts = {
    candidates: rows.length,
    updated: 0,
    unresolvable_no_raw_json: 0,
    unresolvable_no_participant: 0,
  };

  const resolved: Array<{
    chatJid: string;
    messageId: string;
    senderJid: string;
  }> = [];

  for (const row of rows) {
    // Handles both "no raw_json" and "raw_json present but unparseable /
    // missing key" the same way: neither leaves anything to resolve from.
    const message = reconstructMessageFromRawJson(row.raw_json);
    if (!message) {
      counts.unresolvable_no_raw_json++;
      continue;
    }
    const senderJid = resolveSender(
      message.key,
      true,
      message.key.fromMe === true,
      message.participant,
      selfJid,
    );
    if (!senderJid) {
      counts.unresolvable_no_participant++;
      continue;
    }
    counts.updated++;
    resolved.push({
      chatJid: row.chat_jid,
      messageId: row.message_id,
      senderJid,
    });
  }

  if (!dryRun && resolved.length > 0) {
    const update = db.prepare(
      "update messages set sender_jid = ? where account_id = ? and chat_jid = ? and message_id = ?",
    );
    const applyAll = db.transaction((items: typeof resolved) => {
      for (const item of items) {
        update.run(item.senderJid, accountId, item.chatJid, item.messageId);
      }
    });
    applyAll(resolved);
  }

  return counts;
}

function printReport(report: BackfillSenderReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const prefix = report.dry_run ? "[dry-run] " : "";
  process.stdout.write(
    `${prefix}sender_jid backfill on ${report.database}\n` +
      `  candidates: ${String(report.candidates)}\n` +
      `  updated: ${String(report.updated)}\n` +
      `  unresolvable (no raw_json): ${String(report.unresolvable_no_raw_json)}\n` +
      `  unresolvable (no participant): ${String(report.unresolvable_no_participant)}\n`,
  );
}
