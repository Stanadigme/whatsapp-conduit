import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { resolveConfigPath, appLogger } from "../runtime.js";
import { createMcpContext, createMcpServer } from "../mcp/server.js";
import { startMcpHttpServer } from "../mcp/http.js";
import { ensureTokenFile } from "../util/token-file.js";

export interface McpOptions {
  configPath?: string;
  /** Serve the Streamable HTTP transport instead of stdio. */
  http?: boolean;
  /** HTTP listen host override (defaults to `mcp.http.host`). */
  host?: string;
  /** HTTP listen port override (defaults to `mcp.http.port`). */
  port?: number;
}

/** Run the read-only MCP server over stdin/stdout, or over Streamable HTTP. */
export async function runMcp(options: McpOptions = {}): Promise<void> {
  const config = loadConfig(resolveConfigPath(options.configPath));
  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(config.paths.sqlite, { migrate: false, readonly: true });
  } catch {
    throw new Error("MCP database unavailable");
  }
  try {
    const context = await createMcpContext(db, config);
    if (options.http) {
      await runMcpHttp(context, config, options);
      return;
    }
    const server = createMcpServer(context);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    await new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
    await server.close();
  } finally {
    db.close();
  }
}

async function runMcpHttp(
  context: Awaited<ReturnType<typeof createMcpContext>>,
  config: ReturnType<typeof loadConfig>,
  options: McpOptions,
): Promise<void> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535)
  ) {
    throw new Error("mcp http port must be an integer between 0 and 65535");
  }
  const host = options.host ?? config.mcp.http.host;
  const port = options.port ?? config.mcp.http.port;
  const logger = appLogger(config);
  const token = ensureTokenFile(config.mcp.http.tokenFile);

  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    logger.warn(
      { host },
      "mcp http is bound to a non-loopback address; put a TLS-terminating reverse proxy or tunnel in front of it (ADR-0002)",
    );
  }

  const running = await startMcpHttpServer(context, {
    host,
    port,
    token,
    logger,
  });
  logger.info({ host, port: running.port }, "mcp http server started");
  process.stdout.write(
    `MCP Streamable HTTP on http://${host}:${running.port}/mcp\n`,
  );
  process.stdout.write(`MCP health on http://${host}:${running.port}/health\n`);
  process.stdout.write(`MCP bearer token file: ${config.mcp.http.tokenFile}\n`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.close().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
