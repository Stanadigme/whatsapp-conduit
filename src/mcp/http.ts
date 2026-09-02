import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getVersion } from "../version.js";
import { createMcpServer } from "./server.js";
import type { McpContext } from "./types.js";

/**
 * Streamable HTTP transport for the read-only MCP surface (ADR-0002).
 *
 * The functional surface — the 13 tools, their schemas, the allowlist,
 * pagination and result caps — comes entirely from {@link createMcpServer}. This
 * module only adds the transport: a bearer-protected `/mcp` endpoint with one
 * MCP session per `Mcp-Session-Id`, and a public unauthenticated `/health`.
 */

const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

class HttpBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = "HttpBodyError";
  }
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export interface McpHttpServerOptions {
  host: string;
  port: number;
  token: string;
  logger: Logger;
}

export interface RunningMcpHttpServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

function isLoopbackBind(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * DNS-rebinding guard. When bound to loopback we only accept a loopback `Host`
 * header, so a page on another origin cannot drive the endpoint through the
 * browser. A non-loopback bind is assumed to sit behind a reverse proxy that
 * owns `Host` validation (ADR-0002), so the check is skipped there.
 */
function hostAccepted(request: IncomingMessage, bind: string): boolean {
  if (!isLoopbackBind(bind)) return true;
  const host = request.headers.host;
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return (
    name === "127.0.0.1" ||
    name === "localhost" ||
    name === "::1" ||
    name === "[::1]"
  );
}

function headerValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time bearer check; never echoes the presented value. */
function bearerAccepted(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
    request.resume();
    throw new HttpBodyError(413, "request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_MCP_BODY_BYTES) {
      request.resume();
      throw new HttpBodyError(413, "request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpBodyError(400, "invalid JSON body");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

/**
 * Public health payload. Deliberately upstream of the bearer check and free of
 * private data: no message text, no JID, no row counts, no filesystem paths,
 * no secret. Always `200` regardless of connection state (invariants 6-7,
 * ADR-0002 / docs/06).
 */
function mcpHealth(ctx: McpContext): Record<string, unknown> {
  let schema: string | null = null;
  try {
    schema =
      ctx.db
        .prepare<
          [],
          { name: string }
        >("select name from schema_migrations order by name desc limit 1")
        .get()?.name ?? null;
  } catch {
    schema = null;
  }
  return {
    status: "ok",
    name: "whatsapp-conduit",
    version: getVersion(),
    transport: ctx.runtimeStatus?.transport ?? ctx.config.transport,
    connection: ctx.runtimeStatus?.connection ?? "unknown",
    schema,
  };
}

export function createMcpHttpServer(
  ctx: McpContext,
  options: McpHttpServerOptions,
): Server {
  const { token, logger } = options;
  const sessions = new Map<string, Session>();

  async function openSession(): Promise<StreamableHTTPServerTransport> {
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server });
        logger.info(
          { sessions: sessions.size },
          "mcp http session initialized",
        );
      },
    });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId && sessions.delete(sessionId)) {
        logger.info({ sessions: sessions.size }, "mcp http session closed");
      }
      void server.close();
    };
    await server.connect(transport);
    return transport;
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? options.host}`,
    );

    if (!hostAccepted(request, options.host)) {
      request.resume();
      sendJson(response, 403, { error: "forbidden host" });
      return;
    }

    if (url.pathname === "/health" && method === "GET") {
      sendJson(response, 200, mcpHealth(ctx));
      return;
    }

    if (url.pathname !== "/mcp") {
      request.resume();
      sendJson(response, 404, { error: "not found" });
      return;
    }

    if (!bearerAccepted(request, token)) {
      request.resume();
      sendJson(
        response,
        401,
        { error: "unauthorized" },
        { "WWW-Authenticate": "Bearer" },
      );
      return;
    }

    const sessionId = headerValue(request, "mcp-session-id");

    if (method === "POST") {
      const body = await readJsonBody(request);
      let transport = sessionId
        ? sessions.get(sessionId)?.transport
        : undefined;
      if (!transport) {
        if (sessionId !== undefined || !isInitializeRequest(body)) {
          sendJson(response, 400, {
            error: "invalid or missing Mcp-Session-Id",
          });
          return;
        }
        transport = await openSession();
      }
      await transport.handleRequest(request, response, body);
      return;
    }

    if (method === "GET" || method === "DELETE") {
      const transport = sessionId
        ? sessions.get(sessionId)?.transport
        : undefined;
      if (!transport) {
        request.resume();
        sendJson(response, 400, {
          error: "invalid or missing Mcp-Session-Id",
        });
        return;
      }
      await transport.handleRequest(request, response);
      return;
    }

    request.resume();
    sendJson(
      response,
      405,
      { error: "method not allowed" },
      { Allow: "GET, POST, DELETE" },
    );
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const status = error instanceof HttpBodyError ? error.status : 500;
      logger.error(
        {
          err: error instanceof Error ? error.message : "unknown error",
          path: request.url,
        },
        "mcp http request failed",
      );
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson(response, status, {
        error:
          error instanceof HttpBodyError ? error.message : "request failed",
      });
    });
  });

  server.on("close", () => {
    for (const session of sessions.values()) {
      void session.transport.close();
    }
    sessions.clear();
  });

  return server;
}

export async function startMcpHttpServer(
  ctx: McpContext,
  options: McpHttpServerOptions,
): Promise<RunningMcpHttpServer> {
  const server = createMcpHttpServer(ctx, options);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(options.port, options.host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : options.port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
