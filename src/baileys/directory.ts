import type { WASocket } from "baileys";
import { persistChatMetadata, type IngestDeps } from "./ingest.js";

/**
 * WhatsApp app-state collections that carry contact and chat names. A fresh
 * pairing can leave the initial sync of these parked (missing sync key), so the
 * local names never reach SQLite until the collections are re-fetched.
 */
const APP_STATE_COLLECTIONS = [
  "critical_block",
  "critical_unblock_low",
  "regular_high",
  "regular_low",
  "regular",
] as const;

/** How many `groupMetadata` reads to have in flight at once. */
const GROUP_METADATA_CONCURRENCY = 4;

export interface DirectoryResyncResult {
  /** Newly-named contacts (delta on rows with a non-empty local name). */
  contacts: number;
  /** Groups whose subject was refreshed. */
  groups: number;
}

type ResyncSocket = Pick<WASocket, "resyncAppState" | "groupMetadata">;

function countNamedContacts(deps: IngestDeps): number {
  return (
    deps.db
      .prepare<
        [string],
        { c: number }
      >("select count(*) as c from participants where account_id = ? and display_name is not null and trim(display_name) <> ''")
      .get(deps.accountId)?.c ?? 0
  );
}

async function refreshGroupSubjects(
  sock: ResyncSocket,
  deps: IngestDeps,
): Promise<number> {
  const rows = deps.db
    .prepare<
      [string],
      { jid: string }
    >("select jid from chats where account_id = ? and is_group = 1")
    .all(deps.accountId);

  let refreshed = 0;
  for (let i = 0; i < rows.length; i += GROUP_METADATA_CONCURRENCY) {
    const batch = rows.slice(i, i + GROUP_METADATA_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ jid }) => {
        try {
          const meta = await sock.groupMetadata(jid);
          const subject = meta.subject?.trim();
          if (subject) {
            // Reuse the ingest path so the directory projection stays in sync.
            persistChatMetadata(deps, { id: meta.id, name: subject });
            refreshed += 1;
          }
        } catch (error) {
          deps.logger.warn(
            { jid, err: error instanceof Error ? error.message : "unknown" },
            "group metadata refresh failed",
          );
        }
      }),
    );
  }
  return refreshed;
}

/**
 * Force a re-fetch of contact and group names from WhatsApp. `resyncAppState`
 * re-drives the `contacts.*` / `chats.*` events that {@link persistChatMetadata}
 * and the contact handlers already persist; `groupMetadata` fills in group
 * subjects. Strictly read-only — no message send, no read receipt.
 */
export async function resyncBaileysDirectory(
  sock: ResyncSocket,
  deps: IngestDeps,
): Promise<DirectoryResyncResult> {
  const before = countNamedContacts(deps);
  try {
    await sock.resyncAppState(APP_STATE_COLLECTIONS, true);
  } catch (error) {
    deps.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "app-state resync failed",
    );
  }
  const groups = await refreshGroupSubjects(sock, deps);
  const after = countNamedContacts(deps);
  return { contacts: Math.max(0, after - before), groups };
}
