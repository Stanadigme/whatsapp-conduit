import { randomUUID } from "node:crypto";
import { downloadStoredMedia } from "../baileys/media-backfill.js";
import type { IngestDeps } from "../baileys/ingest.js";
import {
  createMediaBackfillJob,
  getActiveMediaBackfillJob,
  getAttachment,
  getMediaBackfillJob,
  listChats,
  listMediaBackfillCandidates,
  updateMediaBackfillJob,
  type MediaBackfillJobRow,
} from "../db/queries.js";
import { nowSec } from "../util/time.js";

export interface MediaBackfillStartResult {
  job: MediaBackfillJobRow;
  reused: boolean;
}

// ponytail: one query per chat, no pagination within a chat. A single
// conversation with more unread-media messages than this needs a second
// manual run to finish — acceptable at pilot scale, revisit if a real
// backlog this size shows up.
const MAX_CANDIDATES_PER_CHAT = 2000;

/**
 * Backfills media for messages already in the database — no live WhatsApp
 * connection is used or needed (downloadMediaMessage only needs the
 * mediaKey/directPath already captured in raw_json, see media-backfill.ts).
 * Still runs in the daemon because it is the only process allowed to write
 * SQLite (dashboard and MCP are read-only), the same reason as
 * HistoryCoordinator, not the same technical requirement.
 *
 * Unlike HistoryCoordinator there is no anchor/batch protocol: this is a
 * plain sequential scan. Chats are processed one at a time — deliberately,
 * for the bulk case, as a precaution against looking automated to WhatsApp
 * (no rate-limit guidance exists in this repo for bulk media downloads).
 */
export class MediaBackfillCoordinator {
  private active: string | null = null;

  constructor(
    private readonly deps: IngestDeps,
  ) {}

  async start(chatJid: string | null): Promise<MediaBackfillStartResult> {
    const active = getActiveMediaBackfillJob(this.deps.db, this.deps.accountId);
    if (active) return { job: active, reused: true };

    const id = randomUUID();
    try {
      createMediaBackfillJob(this.deps.db, {
        id,
        accountId: this.deps.accountId,
        chatJid,
      });
    } catch (error) {
      const raced = getActiveMediaBackfillJob(this.deps.db, this.deps.accountId);
      if (raced) return { job: raced, reused: true };
      throw error;
    }

    const job = getMediaBackfillJob(this.deps.db, this.deps.accountId, id);
    if (!job) throw new Error("media backfill job was not created");
    void this.process(id);
    return { job, reused: false };
  }

  /** Resume one unfinished job after the daemon restarts mid-run. */
  recoverActive(): void {
    const active = getActiveMediaBackfillJob(this.deps.db, this.deps.accountId);
    if (!active) return;
    updateMediaBackfillJob(this.deps.db, this.deps.accountId, active.id, {
      status: "queued",
    });
    void this.process(active.id);
  }

  private async process(jobId: string): Promise<void> {
    if (this.active) return;
    this.active = jobId;
    const { db, accountId } = this.deps;
    try {
      updateMediaBackfillJob(db, accountId, jobId, {
        status: "running",
        startedAt: nowSec(),
      });
      const job = getMediaBackfillJob(db, accountId, jobId);
      if (!job) return;

      const chatJids = job.chat_jid
        ? [job.chat_jid]
        : listChats(db, { accountId, allowedOnly: true }).map((c) => c.jid);

      let found = 0;
      let downloaded = 0;
      let failed = 0;
      for (const chatJid of chatJids) {
        updateMediaBackfillJob(db, accountId, jobId, {
          currentChatJid: chatJid,
        });
        const candidates = listMediaBackfillCandidates(
          db,
          accountId,
          chatJid,
          MAX_CANDIDATES_PER_CHAT,
        );
        for (const row of candidates) {
          found += 1;
          await downloadStoredMedia(row, this.deps);
          const attachment = getAttachment(
            db,
            accountId,
            row.chat_jid,
            row.message_id,
          );
          if (attachment?.downloaded_at !== null && attachment?.downloaded_at !== undefined) {
            downloaded += 1;
          } else {
            failed += 1;
          }
          updateMediaBackfillJob(db, accountId, jobId, {
            attachmentsFound: found,
            attachmentsDownloaded: downloaded,
            attachmentsFailed: failed,
          });
        }
      }

      updateMediaBackfillJob(db, accountId, jobId, {
        status: "completed",
        completedAt: nowSec(),
      });
    } catch (error) {
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "media backfill failed",
      );
      updateMediaBackfillJob(db, accountId, jobId, {
        status: "failed",
        completedAt: nowSec(),
      });
    } finally {
      this.active = null;
    }
  }
}
