import { lstat, unlink } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { nowSec } from "../util/time.js";

/** Data domains deliberately exposed to the protected dashboard. */
export const MAINTENANCE_SCOPES = [
  "directory",
  "live_messages",
  "history",
  "transcriptions",
  "media",
  "audit",
  "all",
] as const;

export type MaintenanceScope = (typeof MAINTENANCE_SCOPES)[number];
export type MaintenanceStatus = "queued" | "running" | "completed" | "failed";

export interface MaintenanceOperationRow {
  id: string;
  account_id: string;
  scope: MaintenanceScope;
  status: MaintenanceStatus;
  counts_json: string | null;
  error_code: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface MaintenanceOperationView {
  id: string;
  scope: MaintenanceScope;
  status: MaintenanceStatus;
  counts: Record<string, number> | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface MaintenanceState {
  generation: number;
  active: boolean;
  directoryRebuildRequired: boolean;
  directoryRebuildError: string | null;
}

export interface MaintenanceRunOptions {
  db: Database;
  accountId: string;
  scope: MaintenanceScope;
  mediaDir: string;
  /** Keep the operation running while a caller performs a coupled rebuild. */
  deferCompletion?: boolean;
}

export function isMaintenanceScope(value: unknown): value is MaintenanceScope {
  return (
    typeof value === "string" &&
    (MAINTENANCE_SCOPES as readonly string[]).includes(value)
  );
}

/** Exact confirmation required by the HTTP API; it is intentionally human-readable. */
export function maintenanceConfirmation(scope: MaintenanceScope): string {
  return `RÉINITIALISER ${scope}`;
}

function ensureState(db: Database, accountId: string): void {
  db.prepare(
    `insert into maintenance_state (account_id, updated_at)
     values (?, ?)
     on conflict (account_id) do nothing`,
  ).run(accountId, nowSec());
}

export function maintenanceState(
  db: Database,
  accountId: string,
): MaintenanceState {
  ensureState(db, accountId);
  const row = db
    .prepare<
      [string],
      {
        generation: number;
        directory_rebuild_required: number;
        directory_rebuild_error: string | null;
        active: number;
      }
    >(
      `select s.generation, s.directory_rebuild_required,
              s.directory_rebuild_error,
              exists(select 1 from maintenance_operations o
                     where o.account_id = s.account_id
                       and o.status in ('queued', 'running')) as active
       from maintenance_state s where s.account_id = ?`,
    )
    .get(accountId);
  if (!row) throw new Error("maintenance state was not created");
  return {
    generation: row.generation,
    active: row.active === 1,
    directoryRebuildRequired: row.directory_rebuild_required === 1,
    directoryRebuildError: row.directory_rebuild_error,
  };
}

/** Read-only variant for dashboard/MCP-adjacent status views. */
export function readMaintenanceState(
  db: Database,
  accountId: string,
): MaintenanceState {
  const row = db
    .prepare<
      [string],
      {
        generation: number;
        directory_rebuild_required: number;
        directory_rebuild_error: string | null;
        active: number;
      }
    >(
      `select s.generation, s.directory_rebuild_required,
              s.directory_rebuild_error,
              exists(select 1 from maintenance_operations o
                     where o.account_id = s.account_id
                       and o.status in ('queued', 'running')) as active
       from maintenance_state s where s.account_id = ?`,
    )
    .get(accountId);
  if (!row) {
    return {
      generation: 0,
      active: false,
      directoryRebuildRequired: false,
      directoryRebuildError: null,
    };
  }
  return {
    generation: row.generation,
    active: row.active === 1,
    directoryRebuildRequired: row.directory_rebuild_required === 1,
    directoryRebuildError: row.directory_rebuild_error,
  };
}

export function maintenanceIsActive(db: Database, accountId: string): boolean {
  return maintenanceState(db, accountId).active;
}

/** True only while no reset has started since a worker claimed its candidate. */
export function maintenanceGenerationCurrent(
  db: Database,
  accountId: string,
  generation: number,
): boolean {
  const state = maintenanceState(db, accountId);
  return !state.active && state.generation === generation;
}

export function startMaintenanceOperation(
  db: Database,
  accountId: string,
  scope: MaintenanceScope,
): MaintenanceOperationRow {
  const id = randomUUID();
  const create = db.transaction(() => {
    ensureState(db, accountId);
    const active = maintenanceIsActive(db, accountId);
    if (active) throw new Error("a maintenance operation is already active");
    const now = nowSec();
    db.prepare(
      `insert into maintenance_operations
         (id, account_id, scope, status, created_at)
       values (?, ?, ?, 'queued', ?)`,
    ).run(id, accountId, scope, now);
    // A generation fence prevents an STT result computed before the reset
    // from being inserted after it.
    db.prepare(
      `update maintenance_state set generation = generation + 1, updated_at = ?
       where account_id = ?`,
    ).run(now, accountId);
  });
  create();
  const operation = getMaintenanceOperation(db, accountId, id);
  if (!operation) throw new Error("maintenance operation was not created");
  return operation;
}

export function getMaintenanceOperation(
  db: Database,
  accountId: string,
  id: string,
): MaintenanceOperationRow | undefined {
  return db
    .prepare<
      [string, string],
      MaintenanceOperationRow
    >("select * from maintenance_operations where account_id = ? and id = ?")
    .get(accountId, id);
}

/** Move a queued operation into its externally coordinated phase. */
export function beginMaintenanceOperation(
  db: Database,
  accountId: string,
  id: string,
): void {
  const result = db
    .prepare(
      `update maintenance_operations set status = 'running', started_at = ?
       where account_id = ? and id = ? and status = 'queued'`,
    )
    .run(nowSec(), accountId, id);
  if (result.changes !== 1) {
    throw new Error("maintenance operation is not queued");
  }
}

export function completeMaintenanceOperation(
  db: Database,
  accountId: string,
  id: string,
): void {
  db.prepare(
    `update maintenance_operations set status = 'completed', completed_at = ?
     where account_id = ? and id = ? and status = 'running'`,
  ).run(nowSec(), accountId, id);
}

export function failMaintenanceOperation(
  db: Database,
  accountId: string,
  id: string,
  errorCode = "reset_failed",
): void {
  db.prepare(
    `update maintenance_operations
     set status = 'failed', error_code = ?, completed_at = ?
     where account_id = ? and id = ? and status in ('queued', 'running')`,
  ).run(errorCode, nowSec(), accountId, id);
}

/**
 * A daemon cannot safely resume a partially executed destructive action after
 * it was interrupted: the operator must explicitly submit a new request.
 * Keep the failed operation as an audit trail while releasing the per-account
 * exclusion lock.
 */
export function recoverInterruptedMaintenanceOperations(
  db: Database,
  accountId: string,
): number {
  return affected(
    db
      .prepare(
        `update maintenance_operations
         set status = 'failed', error_code = 'interrupted', completed_at = ?
         where account_id = ? and status in ('queued', 'running')`,
      )
      .run(nowSec(), accountId),
  );
}

export function maintenanceOperationView(
  operation: MaintenanceOperationRow,
): MaintenanceOperationView {
  let counts: Record<string, number> | null = null;
  if (operation.counts_json) {
    try {
      const parsed: unknown = JSON.parse(operation.counts_json);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        counts = Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        );
      }
    } catch {
      // A malformed local diagnostic must not make the dashboard unavailable.
    }
  }
  return {
    id: operation.id,
    scope: operation.scope,
    status: operation.status,
    counts,
    error: operation.error_code,
    createdAt: operation.created_at,
    startedAt: operation.started_at,
    completedAt: operation.completed_at,
  };
}

function affected(result: { changes: number }): number {
  return result.changes;
}

function includesDirectory(scope: MaintenanceScope): boolean {
  return scope === "directory" || scope === "all";
}

function includesMedia(scope: MaintenanceScope): boolean {
  return scope === "media" || scope === "all";
}

function messageSource(scope: MaintenanceScope): "live" | "history" | null {
  if (scope === "live_messages") return "live";
  if (scope === "history") return "history";
  return null;
}

function deleteDirectory(
  db: Database,
  accountId: string,
  counts: Record<string, number>,
): void {
  counts.directoryGroupMembers = affected(
    db
      .prepare("delete from directory_group_members where account_id = ?")
      .run(accountId),
  );
  counts.directoryAliases = affected(
    db
      .prepare("delete from directory_aliases where account_id = ?")
      .run(accountId),
  );
  counts.directoryEntities = affected(
    db
      .prepare("delete from directory_entities where account_id = ?")
      .run(accountId),
  );
  counts.groupMembers = affected(
    db.prepare("delete from group_members where account_id = ?").run(accountId),
  );
  counts.participantAliases = affected(
    db
      .prepare("delete from participant_aliases where account_id = ?")
      .run(accountId),
  );
  counts.participantNames = affected(
    db
      .prepare(
        `update participants set lid = null, display_name = null, push_name = null,
         verified_name = null, raw_json = null
       where account_id = ?`,
      )
      .run(accountId),
  );
  counts.chatNames = affected(
    db
      .prepare(
        `update chats set name = null, push_name = null, raw_json = null
       where account_id = ?`,
      )
      .run(accountId),
  );
}

const MESSAGE_DEPENDENCY_WHERE = `
  account_id = @accountId and exists (
    select 1 from messages m
    where m.account_id = @accountId
      and m.chat_jid = {table}.chat_jid
      and m.message_id = {table}.message_id
      and {source}
  )`;

function deleteMessages(
  db: Database,
  accountId: string,
  source: "live" | "history" | "all",
  counts: Record<string, number>,
): void {
  const sourcePredicate =
    source === "all" ? "1 = 1" : "m.ingestion_source = @source";
  const replace = (table: string): string =>
    MESSAGE_DEPENDENCY_WHERE.replaceAll("{table}", table).replace(
      "{source}",
      sourcePredicate,
    );
  const params = { accountId, ...(source === "all" ? {} : { source }) };
  counts.transcriptionJobs =
    (counts.transcriptionJobs ?? 0) +
    affected(
      db
        .prepare(
          `delete from transcription_jobs where ${replace("transcription_jobs")}`,
        )
        .run(params),
    );
  counts.transcriptions =
    (counts.transcriptions ?? 0) +
    affected(
      db
        .prepare(
          `delete from transcriptions where ${replace("transcriptions")}`,
        )
        .run(params),
    );
  counts.attachments =
    (counts.attachments ?? 0) +
    affected(
      db
        .prepare(`delete from attachments where ${replace("attachments")}`)
        .run(params),
    );
  counts.messages =
    (counts.messages ?? 0) +
    affected(
      db
        .prepare(
          `delete from messages where account_id = @accountId and ${sourcePredicate.replaceAll("m.", "")}`,
        )
        .run(params),
    );
}

function refreshChatLastMessageTimestamps(
  db: Database,
  accountId: string,
): void {
  db.prepare(
    `update chats set last_message_ts = (
       select max(m.timestamp) from messages m
       where m.account_id = chats.account_id and m.chat_jid = chats.jid
     ) where account_id = ?`,
  ).run(accountId);
}

interface MediaFile {
  path: string;
}

async function removeMediaFiles(
  db: Database,
  accountId: string,
  mediaDir: string,
): Promise<number> {
  const root = resolve(mediaDir);
  const rows = db
    .prepare<[string], { file_path: string | null }>(
      `select file_path from attachments
       where account_id = ? and file_path is not null`,
    )
    .all(accountId);
  const files: MediaFile[] = rows.flatMap((row) =>
    row.file_path ? [{ path: row.file_path }] : [],
  );
  let removed = 0;
  for (const file of files) {
    const candidate = resolve(file.path);
    const relativePath = relative(root, candidate);
    if (relativePath === "" || /^(?:\.\.(?:[\\/]|$))/.test(relativePath)) {
      throw new Error("media path is outside the configured media directory");
    }
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("media path is not a regular file");
      }
      await unlink(candidate);
      removed += 1;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  return removed;
}

/**
 * Execute the destructive portion of an already-created operation. It is
 * intentionally independent from HTTP/IPC: only the ingestion daemon calls it.
 */
export async function runMaintenanceOperation(
  options: MaintenanceRunOptions & { operationId: string },
): Promise<MaintenanceOperationRow> {
  const {
    db,
    accountId,
    scope,
    mediaDir,
    operationId,
    deferCompletion = false,
  } = options;
  const operation = getMaintenanceOperation(db, accountId, operationId);
  if (!operation || operation.status !== "queued") {
    throw new Error("maintenance operation is not queued");
  }
  beginMaintenanceOperation(db, accountId, operationId);

  try {
    const counts: Record<string, number> = {};
    if (includesMedia(scope))
      counts.mediaFiles = await removeMediaFiles(db, accountId, mediaDir);
    const reset = db.transaction(() => {
      if (includesDirectory(scope)) {
        deleteDirectory(db, accountId, counts);
        db.prepare(
          `update maintenance_state set directory_rebuild_required = 1,
             directory_rebuild_error = null, updated_at = ? where account_id = ?`,
        ).run(nowSec(), accountId);
      }
      if (scope === "transcriptions") {
        counts.transcriptionJobs = affected(
          db
            .prepare("delete from transcription_jobs where account_id = ?")
            .run(accountId),
        );
        counts.transcriptions = affected(
          db
            .prepare("delete from transcriptions where account_id = ?")
            .run(accountId),
        );
      }
      const source = messageSource(scope);
      if (source) deleteMessages(db, accountId, source, counts);
      if (scope === "history") {
        counts.historyJobs = affected(
          db
            .prepare("delete from history_jobs where account_id = ?")
            .run(accountId),
        );
      }
      if (scope === "media") {
        counts.attachments = affected(
          db
            .prepare("delete from attachments where account_id = ?")
            .run(accountId),
        );
      }
      if (scope === "audit") {
        counts.events = affected(
          db.prepare("delete from events where account_id = ?").run(accountId),
        );
        counts.consumerOffsets = affected(
          db.prepare("delete from consumer_offsets").run(),
        );
      }
      if (scope === "all") {
        deleteMessages(db, accountId, "all", counts);
        counts.historyJobs = affected(
          db
            .prepare("delete from history_jobs where account_id = ?")
            .run(accountId),
        );
        counts.events = affected(
          db.prepare("delete from events where account_id = ?").run(accountId),
        );
        counts.consumerOffsets = affected(
          db.prepare("delete from consumer_offsets").run(),
        );
      }
      if (source || scope === "all")
        refreshChatLastMessageTimestamps(db, accountId);
      db.prepare(
        `update maintenance_operations
         set counts_json = @countsJson,
             status = case when @deferCompletion = 1 then 'running' else 'completed' end,
             completed_at = case when @deferCompletion = 1 then null else @now end
         where account_id = @accountId and id = @operationId`,
      ).run({
        deferCompletion: deferCompletion ? 1 : 0,
        now: nowSec(),
        accountId,
        operationId,
        countsJson: JSON.stringify(counts),
      });
    });
    reset();
  } catch (error) {
    failMaintenanceOperation(db, accountId, operationId);
    throw error;
  }
  const completed = getMaintenanceOperation(db, accountId, operationId);
  if (!completed) throw new Error("maintenance operation disappeared");
  return completed;
}

export function markDirectoryRebuildResult(
  db: Database,
  accountId: string,
  error: string | null,
): void {
  ensureState(db, accountId);
  db.prepare(
    `update maintenance_state set directory_rebuild_required = ?,
       directory_rebuild_error = ?, updated_at = ? where account_id = ?`,
  ).run(error === null ? 0 : 1, error, nowSec(), accountId);
}
