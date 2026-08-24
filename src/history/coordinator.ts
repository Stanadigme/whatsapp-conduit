import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Database } from "better-sqlite3";
import {
  createHistoryJob,
  getActiveHistoryJob,
  getHistoryAnchor,
  getHistoryJob,
  getAccount,
  updateHistoryJob,
  type HistoryAnchorRow,
  type HistoryJobRow,
} from "../db/queries.js";
import type { IngestionEventClassification } from "../baileys/ingest.js";
import type {
  HistoryAnchor,
  HistoryTransport,
  TransportMessageEvent,
} from "../transport/types.js";
import { normalizeJid } from "../baileys/jid.js";
import { nowSec } from "../util/time.js";

export interface HistoryCapableTransport extends HistoryTransport {
  on(event: "connected", listener: (data: { jid: string }) => void): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "message", listener: (data: TransportMessageEvent) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "history_sync",
    listener: (data: {
      type: string;
      progress?: number;
      chunkOrder?: number;
    }) => void,
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
      if (
        this.batchWaiter &&
        event.type.replace(/[-_]/g, "").toUpperCase() === "ONDEMAND"
      ) {
        this.batchWaiter.resolve();
      }
    });
  }

  async start(
    chatJid: string,
    sinceTs: number,
    untilTs = nowSec(),
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

  classify(event: TransportMessageEvent): IngestionEventClassification {
    const active = this.active;
    if (
      !active ||
      !active.requestInFlight ||
      normalizeJid(event.info.chat) !== normalizeJid(active.chatJid)
    ) {
      return { source: "live", store: true };
    }

    const timestamp = event.info.timestamp;
    if (!Number.isFinite(timestamp) || timestamp > active.anchor.timestamp) {
      return { source: "live", store: true };
    }

    active.boundarySeen ||= timestamp <= active.sinceTs;
    this.recordReceived(timestamp);
    return {
      source: "history",
      store: timestamp >= active.sinceTs,
    };
  }

  onStored(
    _event: TransportMessageEvent,
    stored: boolean,
    classification: IngestionEventClassification,
  ): void {
    if (!stored || classification.source !== "history") return;
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
        this.fail(jobId, "no_anchor");
        return;
      }
      if (initialAnchor.timestamp <= initial.since_ts) {
        this.complete(jobId, "already_satisfied");
        return;
      }

      this.active = {
        jobId,
        chatJid: initial.chat_jid,
        sinceTs: initial.since_ts,
        anchor: initialAnchor,
        boundarySeen: false,
        requestInFlight: false,
      };
      updateHistoryJob(this.options.db, this.options.accountId, jobId, {
        status: "queued",
        phase: "queued",
        startedAt: initial.started_at ?? nowSec(),
      });

      let anchor = initialAnchor;
      while (true) {
        if (this.active.boundarySeen || anchor.timestamp <= initial.since_ts) {
          this.complete(jobId, "boundary_reached");
          return;
        }
        await this.waitForConnection(jobId);
        if (!this.active) return;
        this.active.anchor = anchor;
        updateHistoryJob(this.options.db, this.options.accountId, jobId, {
          status: "running",
          phase: "requesting",
          anchorSenderJid: anchor.sender,
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
          this.complete(jobId, "boundary_reached");
          return;
        }
        const next = this.resolveAnchor(
          getHistoryJob(this.options.db, this.options.accountId, jobId) ??
            initial,
          false,
        );
        if (
          !next ||
          next.id === anchor.id ||
          next.timestamp >= anchor.timestamp
        ) {
          this.fail(jobId, "no_progress");
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
            anchorSenderJid: anchor.sender,
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
      job.anchor_sender_jid &&
      job.anchor_message_id &&
      job.anchor_timestamp !== null
    ) {
      return {
        chat: job.chat_jid,
        sender: job.anchor_sender_jid,
        id: job.anchor_message_id,
        timestamp: job.anchor_timestamp,
      };
    }
    const row: HistoryAnchorRow | undefined = getHistoryAnchor(
      this.options.db,
      this.options.accountId,
      job.chat_jid,
    );
    if (!row) return null;
    const sender =
      row.sender_jid ??
      getAccount(this.options.db, this.options.accountId)?.self_jid;
    if (!sender) return null;
    return {
      chat: row.chat_jid,
      sender,
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
    if (this.active) this.active.requestInFlight = true;
    let timer: NodeJS.Timeout | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      this.batchWaiter = { resolve, reject };
      timer = setTimeout(
        () => reject(new Error("history_sync_timeout")),
        this.batchTimeoutMs,
      );
    });
    try {
      await this.options.transport.requestHistory(anchor, this.batchSize);
      await completed;
    } finally {
      if (timer) clearTimeout(timer);
      this.batchWaiter = null;
      if (this.active) this.active.requestInFlight = false;
    }
  }

  private complete(jobId: string, reason: string): void {
    updateHistoryJob(this.options.db, this.options.accountId, jobId, {
      status: "completed",
      phase: "done",
      progressPercent: 100,
      coverageComplete: true,
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
    if (error instanceof Error && error.message.includes("not started")) {
      return "transport_unavailable";
    }
    return "history_request_failed";
  }
}
