import type { Database } from "better-sqlite3";
import type { Config } from "../config.js";
import { maskSecrets } from "../commands/config.js";
import { requestHistoryStart } from "../control/ipc.js";
import { getMessage, listMessages } from "../read/messages.js";
import { McpRequestError } from "../mcp/types.js";
import {
  allowDashboardChat,
  blockDashboardChat,
  listDashboardChats,
} from "./chats.js";
import {
  getActiveHistoryJob,
  getHistoryJob,
  setTranscriptionCorrection,
  type HistoryJobRow,
} from "../db/queries.js";
import { findCatalogueModel } from "../stt/models.js";
import type { ModelDownloader } from "./models.js";
import { applySttSettings, sttHealth, sttView } from "./stt.js";

export interface DashboardPairing {
  status: "disabled" | "idle" | "waiting_qr" | "connected" | "error";
  qr: string | null;
  error: string | null;
}

export interface DashboardContext {
  db: Database;
  config: Config;
  /** Path of the YAML file the transcription settings are written to. */
  configPath: string;
  models: ModelDownloader;
  accountId: string;
  pairing: DashboardPairing;
  startPairing: () => Promise<void>;
  stopPairing: () => Promise<void>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(error: unknown, status = 400): Response {
  const message =
    error instanceof Error ? error.message : "dashboard request failed";
  const safe =
    message.includes("not available") || message.includes("cannot")
      ? message
      : "dashboard request failed";
  return json({ error: safe }, status);
}

function decodeJid(pathPart: string): string {
  return decodeURIComponent(pathPart);
}

async function correctionBody(
  request: Request,
): Promise<{ textCorrected: string } | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return null;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).textCorrected !== "string" ||
    Object.keys(body).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(body, "textCorrected")
  ) {
    return null;
  }
  return { textCorrected: (body as { textCorrected: string }).textCorrected };
}

function historyView(job: HistoryJobRow): Record<string, unknown> {
  return {
    id: job.id,
    chatJid: job.chat_jid,
    sinceTs: job.since_ts,
    untilTs: job.until_ts,
    status: job.status,
    phase: job.phase,
    progressPercent: job.progress_percent,
    oldestSeenTs: job.oldest_seen_ts,
    batchesRequested: job.batches_requested,
    batchesCompleted: job.batches_completed,
    messagesReceived: job.messages_received,
    messagesInserted: job.messages_inserted,
    coverageComplete: job.coverage_complete === 1,
    completionReason: job.completion_reason,
    errorCode: job.error_code,
    createdAt: job.created_at,
    startedAt: job.started_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
  };
}

export async function dashboardApi(
  request: Request,
  context: DashboardContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({
      service: "whatsapp-conduit",
      pairing: context.pairing.status,
    });
  }
  if (url.pathname === "/api/config" && request.method === "GET") {
    return json(maskSecrets(context.config));
  }
  if (url.pathname === "/api/stt" && request.method === "GET") {
    return json(
      await sttView({
        db: context.db,
        configPath: context.configPath,
        accountId: context.accountId,
        download: context.models.snapshot,
      }),
    );
  }
  if (url.pathname === "/api/stt" && request.method === "POST") {
    try {
      applySttSettings(context.configPath, url.searchParams);
    } catch (error) {
      // These messages are authored here and safe to show: they name the
      // field that was refused, never the value or anything about the host.
      return json(
        { error: error instanceof Error ? error.message : "invalid request" },
        400,
      );
    }
    return json(
      await sttView({
        db: context.db,
        configPath: context.configPath,
        accountId: context.accountId,
        download: context.models.snapshot,
      }),
    );
  }
  if (url.pathname === "/api/stt/check" && request.method === "POST") {
    const health = await sttHealth(context.configPath);
    return json({ ok: health.ok, detail: health.detail ?? null });
  }
  if (url.pathname === "/api/stt/models/pull" && request.method === "GET") {
    return json(context.models.snapshot);
  }
  if (url.pathname === "/api/stt/models/pull" && request.method === "POST") {
    const model = findCatalogueModel(url.searchParams.get("model") ?? "");
    if (!model) return json({ error: "unknown model" }, 404);
    try {
      context.models.start(model);
    } catch (error) {
      return errorResponse(error, 409);
    }
    return json(context.models.snapshot, 202);
  }
  if (url.pathname.startsWith("/api/chats/") && request.method === "POST") {
    const match =
      /^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/transcription\/correction$/.exec(
        url.pathname,
      );
    if (match?.[1] && match[2]) {
      const body = await correctionBody(request);
      if (body === null) {
        return json({ error: "invalid correction payload" }, 400);
      }
      const chatJid = decodeJid(match[1]);
      const messageId = decodeURIComponent(match[2]);
      try {
        const current = getMessage(
          { db: context.db, accountId: context.accountId },
          chatJid,
          messageId,
        );
        if (current.messageType !== "audio" || current.textRaw === null) {
          return json({ error: "transcription not available" }, 409);
        }
        const written = setTranscriptionCorrection(context.db, {
          accountId: context.accountId,
          chatJid,
          messageId,
          textCorrected: body.textCorrected,
        });
        if (!written)
          return json({ error: "transcription not available" }, 409);
        return json(
          getMessage(
            { db: context.db, accountId: context.accountId },
            chatJid,
            messageId,
          ),
        );
      } catch (error) {
        if (
          error instanceof McpRequestError &&
          error.message === "chat is not available"
        ) {
          return json({ error: "not found" }, 404);
        }
        if (
          error instanceof McpRequestError &&
          error.message === "message not found"
        ) {
          return json({ error: "not found" }, 404);
        }
        return errorResponse(error, 400);
      }
    }
  }
  if (url.pathname === "/api/chats" && request.method === "GET") {
    return json(
      listDashboardChats(context.db, context.accountId, {
        query: url.searchParams.get("query") ?? undefined,
        kind:
          (url.searchParams.get("kind") as
            | "contact"
            | "group"
            | "status"
            | null) ?? undefined,
        policy:
          (url.searchParams.get("policy") as
            | "allowed"
            | "blocked"
            | "discovered"
            | null) ?? undefined,
      }),
    );
  }
  if (url.pathname.startsWith("/api/chats/") && request.method === "GET") {
    const match = /^\/api\/chats\/(.+)\/messages$/.exec(url.pathname);
    if (!match?.[1]) return json({ error: "not found" }, 404);
    const limitValue = url.searchParams.get("limit");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    try {
      const page = listMessages(context, {
        chat: decodeJid(match[1]),
        limit: limitValue === null ? undefined : Number(limitValue),
        cursor,
      });
      return json(page);
    } catch (error) {
      if (
        error instanceof McpRequestError &&
        error.message === "chat is not available"
      ) {
        return json({ error: "not found" }, 404);
      }
      return json({ error: "invalid messages query" }, 400);
    }
  }
  if (url.pathname.startsWith("/api/chats/") && request.method === "POST") {
    const historyMatch = /^\/api\/chats\/(.+)\/history$/.exec(url.pathname);
    if (historyMatch) {
      const sinceValue = url.searchParams.get("since");
      const since = sinceValue === null ? Number.NaN : Number(sinceValue);
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isInteger(since) || since < 0 || since > now) {
        return json({ error: "invalid history window" }, 400);
      }
      try {
        const result = await requestHistoryStart(
          context.config.paths.controlSocket,
          {
            chat: decodeJid(historyMatch[1] ?? ""),
            since,
          },
        );
        return json(
          {
            jobId: result.jobId,
            status: result.status,
            reused: result.reused,
          },
          202,
        );
      } catch (error) {
        return errorResponse(error, 409);
      }
    }
  }
  if (url.pathname.startsWith("/api/chats/") && request.method === "POST") {
    const match = /^\/api\/chats\/(.+)\/(allow|block)$/.exec(url.pathname);
    if (!match) return json({ error: "not found" }, 404);
    try {
      const jid = match[1];
      const action = match[2];
      if (!jid || !action) return json({ error: "not found" }, 404);
      return json(
        action === "allow"
          ? allowDashboardChat(context.db, context.accountId, decodeJid(jid))
          : blockDashboardChat(context.db, context.accountId, decodeJid(jid)),
      );
    } catch (error) {
      return errorResponse(error, 404);
    }
  }
  if (url.pathname === "/api/history/active" && request.method === "GET") {
    const job = getActiveHistoryJob(context.db, context.accountId);
    return json({ job: job ? historyView(job) : null });
  }
  if (url.pathname.startsWith("/api/history/") && request.method === "GET") {
    const match = /^\/api\/history\/([^/]+)$/.exec(url.pathname);
    if (!match?.[1]) return json({ error: "not found" }, 404);
    const job = getHistoryJob(context.db, context.accountId, match[1]);
    return job ? json(historyView(job)) : json({ error: "not found" }, 404);
  }
  if (url.pathname === "/api/pairing/status" && request.method === "GET") {
    return json({
      status: context.pairing.status,
      error: context.pairing.error,
    });
  }
  if (url.pathname === "/api/pairing/qr" && request.method === "GET") {
    return context.pairing.qr
      ? json({ qr: context.pairing.qr })
      : json({ error: "QR code is not available" }, 404);
  }
  if (url.pathname === "/api/pairing/start" && request.method === "POST") {
    try {
      await context.startPairing();
      return json({ status: context.pairing.status });
    } catch (error) {
      return errorResponse(error, 409);
    }
  }
  if (url.pathname === "/api/pairing/stop" && request.method === "POST") {
    await context.stopPairing();
    return json({ status: context.pairing.status });
  }
  return null;
}
