import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readRuntimeStatus } from "../runtime-status.js";
import { requestHistoryStart } from "../control/ipc.js";
import { historyStatus, startHistoryDownload } from "./history.js";
import {
  chatStats,
  exportMessages,
  getMedia,
  getTranscript,
  health,
  listChats,
  listGroupParticipants,
  listMessages,
  messageContext,
  searchContacts,
  searchMessages,
} from "./read.js";
import type { McpContext } from "./types.js";
import { McpRequestError } from "./types.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const historyControlAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

const pageInput = {
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
};

const messageInput = {
  ...pageInput,
  chat: z.string().min(1).optional(),
  sender: z.string().min(1).optional(),
  fromMe: z.boolean().optional(),
  kind: z.string().min(1).optional(),
  hasMedia: z.boolean().optional(),
  ingestionSource: z.enum(["live", "history", "backup"]).optional(),
  after: z.number().int().nonnegative().optional(),
  before: z.number().int().nonnegative().optional(),
};

function jsonResult(
  value: unknown,
  maxChars: number,
): {
  content: [{ type: "text"; text: string }];
} {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxChars) {
    return { content: [{ type: "text", text: serialized }] };
  }
  const previewLength = Math.max(0, maxChars - 120);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          truncated: true,
          totalChars: serialized.length,
          preview: serialized.slice(0, previewLength),
        }),
      },
    ],
  };
}

function errorResult(error: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  const message =
    error instanceof McpRequestError ? error.message : "request failed";
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

async function safeCall<T>(
  ctx: McpContext,
  maxChars: number,
  action: () => T | Promise<T>,
): Promise<ReturnType<typeof jsonResult> | ReturnType<typeof errorResult>> {
  try {
    return jsonResult(await action(), maxChars);
  } catch (error) {
    return errorResult(error);
  }
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "whatsapp-conduit", version: "0.1.0" },
    {
      instructions:
        "Lecture seule. Les conversations non autorisées ne sont jamais exposées.",
    },
  );
  const maxChars = ctx.config.mcp.maxResultChars;

  server.registerTool(
    "wa_health",
    {
      title: "WhatsApp health",
      description: "Return connection and local database health.",
      annotations: readOnlyAnnotations,
    },
    async () => safeCall(ctx, maxChars, () => health(ctx)),
  );

  server.registerTool(
    "wa_history_download",
    {
      title: "Download WhatsApp history",
      description:
        "Start a bounded history synchronization for one allowed chat. Poll wa_history_status for progress.",
      inputSchema: z.object({
        chat: z.string().min(1),
        since: z.number().int().nonnegative(),
      }),
      annotations: historyControlAnnotations,
    },
    async (args) =>
      safeCall(ctx, maxChars, () =>
        startHistoryDownload(ctx, args.chat, args.since),
      ),
  );

  server.registerTool(
    "wa_history_status",
    {
      title: "History download status",
      description: "Return durable progress for a history synchronization job.",
      inputSchema: z.object({ jobId: z.string().min(1) }),
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      safeCall(ctx, maxChars, () => historyStatus(ctx, args.jobId)),
  );

  server.registerTool(
    "wa_chats_list",
    {
      title: "List allowed chats",
      description: "List allowed WhatsApp conversations, most recent first.",
      inputSchema: z.object(pageInput),
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      safeCall(ctx, maxChars, () => listChats(ctx, args.limit, args.cursor)),
  );

  server.registerTool(
    "wa_contacts_search",
    {
      title: "Search contacts",
      description: "Search contacts visible through allowed conversations.",
      inputSchema: z.object({
        query: z.string().min(2),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      safeCall(ctx, maxChars, () =>
        searchContacts(ctx, args.query, args.limit),
      ),
  );

  server.registerTool(
    "wa_group_participants",
    {
      title: "List group participants",
      description: "List participants of an allowed group.",
      inputSchema: z.object({
        chat: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      safeCall(ctx, maxChars, () =>
        listGroupParticipants(ctx, args.chat, args.limit),
      ),
  );

  server.registerTool(
    "wa_messages_list",
    {
      title: "List messages",
      description:
        "List messages from allowed conversations with stable pagination.",
      inputSchema: z.object(messageInput),
      annotations: readOnlyAnnotations,
    },
    async (args) => safeCall(ctx, maxChars, () => listMessages(ctx, args)),
  );

  server.registerTool(
    "wa_messages_search",
    {
      title: "Search messages",
      description: "Search message text and available transcriptions.",
      inputSchema: z.object({
        query: z.string().min(1),
        ...messageInput,
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const { query, ...filters } = args;
      return safeCall(ctx, maxChars, () => searchMessages(ctx, query, filters));
    },
  );

  server.registerTool(
    "wa_message_context",
    {
      title: "Message context",
      description: "Return messages around one message in an allowed chat.",
      inputSchema: z.object({
        chat: z.string().min(1),
        messageId: z.string().min(1),
        before: z.number().int().min(0).max(200).default(5),
        after: z.number().int().min(0).max(200).default(5),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      safeCall(ctx, maxChars, () =>
        messageContext(ctx, args.chat, args.messageId, args.before, args.after),
      ),
  );

  server.registerTool(
    "wa_get_transcript",
    {
      title: "Get transcript",
      description: "Return transcript status and text when available.",
      inputSchema: z.object({
        chat: z.string().min(1),
        messageId: z.string().min(1),
        raw: z.boolean().default(false),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      safeCall(ctx, maxChars, async () => {
        const result = getTranscript(ctx, args.chat, args.messageId);
        if (!args.raw && "text_raw" in result) {
          delete result.text_raw;
        }
        return result;
      }),
  );

  server.registerTool(
    "wa_get_media",
    {
      title: "Get media",
      description: "Return media metadata and already downloaded local files.",
      inputSchema: z.object({
        chat: z.string().min(1),
        messageId: z.string().min(1),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) =>
      safeCall(ctx, maxChars, () => getMedia(ctx, args.chat, args.messageId)),
  );

  server.registerTool(
    "wa_chat_stats",
    {
      title: "Chat statistics",
      description: "Return aggregate statistics for an allowed conversation.",
      inputSchema: z.object({ chat: z.string().min(1) }),
      annotations: readOnlyAnnotations,
    },
    async (args) => safeCall(ctx, maxChars, () => chatStats(ctx, args.chat)),
  );

  server.registerTool(
    "wa_export",
    {
      title: "Export messages",
      description: "Return deterministic JSON records from allowed chats.",
      inputSchema: z.object({
        after: z.number().int().nonnegative().optional(),
        before: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => safeCall(ctx, maxChars, () => exportMessages(ctx, args)),
  );

  return server;
}

export async function createMcpContext(
  db: McpContext["db"],
  config: McpContext["config"],
): Promise<McpContext> {
  return {
    db,
    config,
    accountId: config.account.name,
    runtimeStatus: await readRuntimeStatus(config.paths.runtimeStatus),
    historyControl: (chat, since) =>
      requestHistoryStart(config.paths.controlSocket, { chat, since }).then(
        (result) => ({
          jobId: result.jobId ?? "",
          status: result.status ?? "queued",
          reused: result.reused ?? false,
        }),
      ),
  };
}
