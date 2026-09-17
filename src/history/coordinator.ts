import { randomUUID } from "node:crypto";
import { proto } from "baileys";
import type { Logger } from "pino";
import type { Database } from "better-sqlite3";
import {
  createHistoryJob,
  getActiveHistoryJob,
  getHistoryAnchor,
  getHistoryJob,
  getMessage,
  updateHistoryJob,
  type HistoryAnchorRow,
  type HistoryJobRow,
} from "../db/queries.js";
import type { IngestionEventClassification } from "../baileys/ingest.js";
import type {
  HistoryAnchor,
  HistoryTransport,
  TransportHistorySyncEvent,
  TransportMessageEvent,
} from "../transport/types.js";
import { listEquivalentJids, resolveDirectoryJid } from "../db/directory.js";
import { normalizeJid } from "../baileys/jid.js";
import { nowSec } from "../util/time.js";

/** Baileys' flag for an on-demand batch the phone will not extend further. */
const COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY =
  proto.Conversation.EndOfHistoryTransferType
    .COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY;

export interface HistoryCapableTransport extends HistoryTransport {
  on(event: "connected", listener: (data: { jid: string }) => void): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "message", listener: (data: TransportMessageEvent) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "history_sync",
    listener: (data: TransportHistorySyncEvent) => void,
  ): this;
}

export interface HistoryCoordinatorOptions {
  db: Database;
  accountId: string;
  transport: HistoryCapableTransport;
  logger: Logger;
  batchSize?: number;
  batchTimeoutMs?: number;
}

export interface HistoryStartResult {
  job: HistoryJobRow;
  reused: boolean;
}

interface ActiveRequest {
  jobId: string;
  chatJid: string;
  sinceTs: number;
  anchor: HistoryAnchor;
  boundarySeen: boolean;
  requestInFlight: boolean;
  fetchMedia: boolean;
  /** Fields from the most recent `history_sync` event, reset per batch. */
  lastBatchMessageCount: number | undefined;
  lastBatchEndOfHistoryTransferType: number | undefined;
  nextAnchor: HistoryAnchor | null;
  requestId: string | undefined;
}

interface BatchWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Coordinates bounded on-demand history requests without coupling MCP to the
 * WhatsApp socket. The normal ingestion path calls classify/onStored so
 * history rows use the same normalization and FTS triggers as live rows.
 */
export class HistoryCoordinator {
  private readonly batchSize: number;
  private readonly batchTimeoutMs: number;
  private connected = false;
  private readonly connectionWaiters = new Set<() => void>();
  private active: ActiveRequest | null = null;
  private batchWaiter: BatchWaiter | null = null;

  constructor(private readonly options: HistoryCoordinatorOptions) {
    this.batchSize = options.batchSize ?? 50;
    this.batchTimeoutMs = options.batchTimeoutMs ?? 60_000;
    options.transport.on("connected", () => {
      this.connected = true;
      for (const resolve of this.connectionWaiters) resolve();
      this.connectionWaiters.clear();
    });
    options.transport.on("disconnected", () => {
      this.connected = false;
    });
    options.transport.on("history_sync", (event) => {
      if (!this.active || !this.active.requestInFlight) return;
      if (event.chatJid && resolveDirectoryJid(this.options.db, this.options.accountId, event.chatJid) !== resolveDirectoryJid(this.options.db, this.options.accountId, this.active.chatJid)) return;
      if (event.requestId && this.active.requestId && event.requestId !== this.active.requestId) return;
      // Merge partial batch notifications without erasing fields already seen.
      if (event.messageCount !== undefined) {
        this.active.lastBatchMessageCount = event.messageCount;
      }
      if (event.endOfHistoryTransferType !== undefined) {
        this.active.lastBatchEndOfHistoryTransferType =
          event.endOfHistoryTransferType;
      }
      if (
        this.batchWaiter &&
        event.type.replace(/[-_]/g, "").toUpperCase() === "ONDEMAND"
      ) {
        const waiter = this.batchWaiter;
        setImmediate(() => waiter.resolve());
      }
    });
  }

  async start(
    chatJid: string,
    sinceTs: number,
    untilTs = nowSec(),
    fetchMedia = false,
    anchor?: { sender: string; id: string; timestamp: number },
  ): Promise<HistoryStartResult> {
    if (!Number.isInteger(sinceTs) || sinceTs < 0 || sinceTs > untilTs) {
      throw new Error("invalid history window");
    }
    const active = getActiveHistoryJob(this.options.db, this.options.accountId);
    if (active) return { job: active, reused: true };

    const id = randomUUID();
    try {
      createHistoryJob(this.options.db, {
        id,
        accountId: this.options.accountId,
        chatJid,
        sinceTs,
        untilTs,
        fetchMedia,
        ...(anchor
          ? {
              anchorSenderJid: anchor.sender,
              anchorMessageId: anchor.id,
              anchorTimestamp: anchor.timestamp,
            }
          : {}),
      });
    } catch (error) {
      const raced = getActiveHistoryJob(
        this.options.db,
        this.options.accountId,
      );
      if (raced) return { job: raced, reused: true };
      throw error;
    }

    const job = getHistoryJob(this.options.db, this.options.accountId, id);
    if (!job) throw new Error("history job was not created");
    void this.process(id);
    return { job, reused: false };
  }

  /** Resume one unfinished job after the ingestion daemon starts. */
  recoverActive(): void {
    const active = getActiveHistoryJob(this.options.db, this.options.accountId);
    if (!active) return;
    updateHistoryJob(this.options.db, this.options.accountId, active.id, {
      status: "queued",
      phase: "queued",
    });
    void this.process(active.id);
  }

  /** Stop the active import before a maintenance reset deletes its rows. */
  cancelForMaintenance(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.batchWaiter?.reject(new Error("history_cancelled_for_maintenance"));
    this.batchWaiter = null;
    this.fail(active.jobId, "cancelled_for_maintenance");
  }

  classify(event: TransportMessageEvent): IngestionEventClassification {
    return this.classifyMessage(event.info.chat, event.info.timestamp);
  }

  /** Transport-neutral classification for adapters that do not use MessageInfo. */
  classifyMessage(
    chat: string,
    timestamp: number,
    requestId?: string,
  ): IngestionEventClassification {
    const active = this.active;
    if (
      !active ||
      !active.requestInFlight ||
      (requestId && active.requestId && requestId !== active.requestId) ||
      resolveDirectoryJid(this.options.db, this.options.accountId, chat) !==
        resolveDirectoryJid(
          this.options.db,
          this.options.accountId,
          active.chatJid,
        )
    ) {
      return { source: "live", store: true };
    }

    if (!Number.isFinite(timestamp) || timestamp > active.anchor.timestamp) {
      return { source: "live", store: true };
    }

    // ADR-0037 §1: a message the phone delivers is written, full stop; `since`
    // only stops pagination (`boundarySeen`) — the phone will not resend it.
    return {
      source: "history",
      store: true,
      ...(active.fetchMedia ? { fetchMedia: true } : {}),
    };
  }

  onStored(
    event: TransportMessageEvent,
    stored: boolean,
    classification: IngestionEventClassification,
  ): void {
    this.onStoredResult(stored, classification, event.info.chat, event.info.id);
  }

  /** Record a successful storage operation without retaining transport payloads. */
  onStoredResult(
    stored: boolean,
    classification: IngestionEventClassification,
    chat?: string,
    id?: string,
  ): void {
    if (classification.source !== "history" || !this.active) return;
    if (!stored || !chat || !id) {
      this.onStorageError();
      return;
    }
    const row = getMessage(this.options.db, this.options.accountId, chat, id)
      ?? (normalizeJid(chat) === chat ? undefined : getMessage(this.options.db, this.options.accountId, normalizeJid(chat), id));
    if (!row) {
      this.onStorageError();
      return;
    }
    if (row.timestamp !== null) {
      this.active.boundarySeen ||= row.timestamp <= this.active.sinceTs;
      this.recordReceived(row.timestamp);
      if (!id.startsWith("reaction:") && (row.from_me === 1 || row.sender_jid)) {
        const candidate = this.anchorFromRow({ ...row, timestamp: row.timestamp }, this.active.chatJid);
        if (candidate && (!this.active.nextAnchor || candidate.timestamp < this.active.nextAnchor.timestamp)) this.active.nextAnchor = candidate;
      }
    }
    const job = this.active
      ? getHistoryJob(
          this.options.db,
          this.options.accountId,
          this.active.jobId,
        )
      : undefined;
    if (!job) return;
    updateHistoryJob(this.options.db, this.options.accountId, job.id, {
      messagesInserted: job.messages_inserted + 1,
    });
  }

  onStorageError(): void {
    if (this.active?.requestInFlight) this.batchWaiter?.reject(new Error("history_storage_failed"));
  }

  private recordReceived(timestamp: number): void {
    const active = this.active;
    if (!active) return;
    const job = getHistoryJob(
      this.options.db,
      this.options.accountId,
      active.jobId,
    );
    if (!job) return;
    const oldest =
      job.oldest_seen_ts === null
        ? timestamp
        : Math.min(job.oldest_seen_ts, timestamp);
    updateHistoryJob(this.options.db, this.options.accountId, job.id, {
      messagesReceived: job.messages_received + 1,
      oldestSeenTs: oldest,
      progressPercent: this.progress(job, oldest),
    });
  }

  private progress(
    job: HistoryJobRow,
    oldestSeenTs: number | null,
  ): number | null {
    if (oldestSeenTs === null || job.until_ts <= job.since_ts) return null;
    const ratio =
      (job.until_ts - Math.max(job.since_ts, oldestSeenTs)) /
      (job.until_ts - job.since_ts);
    return Math.max(0, Math.min(99, Math.floor(ratio * 100)));
  }

  private async process(jobId: string): Promise<void> {
    if (this.active) return;
    const initial = getHistoryJob(
      this.options.db,
      this.options.accountId,
      jobId,
    );
    if (!initial) return;

    try {
      const initialAnchor = this.resolveAnchor(initial);
      if (!initialAnchor) {
        this.complete(jobId, "no_local_anchor", false);
        return;
      }
      if (initialAnchor.timestamp <= initial.since_ts) {
        this.complete(jobId, "already_satisfied", false);
        return;
      }

      this.active = {
        jobId,
        chatJid: initial.chat_jid,
        sinceTs: initial.since_ts,
        anchor: initialAnchor,
        boundarySeen: false,
        requestInFlight: false,
        fetchMedia: initial.fetch_media === 1,
        lastBatchMessageCount: undefined,
        lastBatchEndOfHistoryTransferType: undefined,
        nextAnchor: null,
        requestId: undefined,
      };
      updateHistoryJob(this.options.db, this.options.accountId, jobId, {
        status: "queued",
        phase: "queued",
        startedAt: initial.started_at ?? nowSec(),
      });

      let anchor = initialAnchor;
      const requestedAnchors = new Set<string>();
      while (true) {
        if (this.active.boundarySeen || anchor.timestamp <= initial.since_ts) {
          this.complete(jobId, "boundary_reached", false);
          return;
        }
        await this.waitForConnection(jobId);
        if (!this.active) return;
        const anchorKey = `${anchor.chat}\u0000${anchor.id}`;
        if (requestedAnchors.has(anchorKey)) {
          this.complete(jobId, "source_exhausted", false);
          return;
        }
        requestedAnchors.add(anchorKey);
        this.active.anchor = anchor;
        updateHistoryJob(this.options.db, this.options.accountId, jobId, {
          status: "running",
          phase: "requesting",
          anchorSenderJid: anchor.sender ?? null,
          anchorMessageId: anchor.id,
          anchorTimestamp: anchor.timestamp,
        });

        const current = getHistoryJob(
          this.options.db,
          this.options.accountId,
          jobId,
        );
        if (!current) return;
        updateHistoryJob(this.options.db, this.options.accountId, jobId, {
          batchesRequested: current.batches_requested + 1,
          phase: "ingesting",
        });
        await this.requestBatch(anchor);

        const completedBatch = getHistoryJob(
          this.options.db,
          this.options.accountId,
          jobId,
        );
        if (completedBatch) {
          updateHistoryJob(this.options.db, this.options.accountId, jobId, {
            batchesCompleted: completedBatch.batches_completed + 1,
          });
        }

        if (this.active.boundarySeen) {
          this.complete(jobId, "boundary_reached", false);
          return;
        }
        const next = this.active.nextAnchor;
        if (
          !next ||
          requestedAnchors.has(`${next.chat}\u0000${next.id}`) ||
          next.timestamp > anchor.timestamp
        ) {
          if (
            this.active.lastBatchMessageCount === 0 &&
            this.active.lastBatchEndOfHistoryTransferType ===
              COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY
          ) {
            this.complete(jobId, "window_already_delivered", false);
            return;
          }
          this.complete(jobId, "source_exhausted", false);
          return;
        }
        anchor = next;
        const checkpoint = getHistoryJob(
          this.options.db,
          this.options.accountId,
          jobId,
        );
        if (checkpoint) {
          updateHistoryJob(this.options.db, this.options.accountId, jobId, {
            anchorSenderJid: anchor.sender ?? null,
            anchorMessageId: anchor.id,
            anchorTimestamp: anchor.timestamp,
          });
        }
      }
    } catch (error) {
      this.options.logger.warn(
        { code: this.errorCode(error) },
        "history synchronization failed",
      );
      this.fail(jobId, this.errorCode(error));
    } finally {
      this.batchWaiter = null;
      this.active = null;
    }
  }

  private resolveAnchor(
    job: HistoryJobRow,
    useCheckpoint = true,
  ): HistoryAnchor | null {
    if (
      useCheckpoint &&
      job.anchor_message_id &&
      !job.anchor_message_id.startsWith("reaction:") &&
      job.anchor_timestamp !== null
    ) {
      const checkpoint = listEquivalentJids(this.options.db, this.options.accountId, job.chat_jid)
        .map((jid) => getHistoryAnchor(this.options.db, this.options.accountId, jid, job.anchor_message_id ?? undefined))
        .find((candidate) => candidate?.timestamp === job.anchor_timestamp);
      if (checkpoint) return this.anchorFromRow(checkpoint, job.chat_jid);
      return {
        chat: resolveDirectoryJid(
          this.options.db,
          this.options.accountId,
          job.chat_jid,
        ),
        ...(job.anchor_sender_jid ? { sender: resolveDirectoryJid(this.options.db, this.options.accountId, job.anchor_sender_jid) } : {}),
        id: job.anchor_message_id,
        timestamp: job.anchor_timestamp,
      };
    }
    const row: HistoryAnchorRow | undefined = listEquivalentJids(
      this.options.db,
      this.options.accountId,
      job.chat_jid,
    )
      .map((jid) =>
        getHistoryAnchor(this.options.db, this.options.accountId, jid),
      )
      .filter((candidate): candidate is HistoryAnchorRow => Boolean(candidate))
      .sort((left, right) => left.timestamp - right.timestamp)[0];
    if (!row) return null;
    return this.anchorFromRow(row, job.chat_jid);
  }

  private anchorFromRow(row: HistoryAnchorRow, chatJid: string): HistoryAnchor | null {
    if (!row.from_me && !row.sender_jid) return null;
    return {
      chat: resolveDirectoryJid(
        this.options.db,
        this.options.accountId,
        chatJid,
      ),
      ...(row.sender_jid ? { sender: resolveDirectoryJid(
        this.options.db,
        this.options.accountId,
        row.sender_jid,
      ) } : {}),
      fromMe: row.from_me === 1,
      id: row.message_id,
      timestamp: row.timestamp,
    };
  }

  private async waitForConnection(jobId: string): Promise<void> {
    if (this.connected) return;
    updateHistoryJob(this.options.db, this.options.accountId, jobId, {
      status: "waiting_connection",
      phase: "waiting_connection",
    });
    await new Promise<void>((resolve) => this.connectionWaiters.add(resolve));
  }

  private async requestBatch(anchor: HistoryAnchor): Promise<void> {
    if (this.active) {
      this.active.requestInFlight = true;
      this.active.lastBatchMessageCount = undefined;
      this.active.lastBatchEndOfHistoryTransferType = undefined;
      this.active.nextAnchor = null;
      this.active.requestId = undefined;
    }
    let timer: NodeJS.Timeout | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      this.batchWaiter = { resolve, reject };
      timer = setTimeout(
        () => reject(new Error("history_sync_timeout")),
        this.batchTimeoutMs,
      );
    });
    try {
      const request = this.options.transport.requestHistory(anchor, this.batchSize).then((requestId) => {
        if (this.active && typeof requestId === "string") this.active.requestId = requestId;
      });
      await Promise.all([request, completed]);
    } finally {
      if (timer) clearTimeout(timer);
      this.batchWaiter = null;
      if (this.active) this.active.requestInFlight = false;
    }
  }

  private complete(
    jobId: string,
    reason: string,
    coverageComplete = true,
  ): void {
    updateHistoryJob(this.options.db, this.options.accountId, jobId, {
      status: "completed",
      phase: "done",
      ...(coverageComplete ? { progressPercent: 100 } : {}),
      coverageComplete,
      completionReason: reason,
      completedAt: nowSec(),
    });
  }

  private fail(jobId: string, code: string): void {
    updateHistoryJob(this.options.db, this.options.accountId, jobId, {
      status: "failed",
      phase: "failed",
      errorCode: code,
      completedAt: nowSec(),
    });
  }

  private errorCode(error: unknown): string {
    if (error instanceof Error && error.message === "history_sync_timeout") {
      return "history_sync_timeout";
    }
    if (error instanceof Error && error.message === "history_storage_failed") return "history_storage_failed";
    if (error instanceof Error && error.message.includes("not started")) {
      return "transport_unavailable";
    }
    return "history_request_failed";
  }
}
