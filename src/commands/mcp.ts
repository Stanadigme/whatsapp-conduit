import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { resolveConfigPath } from "../runtime.js";
import { createMcpContext, createMcpServer } from "../mcp/server.js";

export interface McpOptions {
  configPath?: string;
}

/** Run the read-only MCP server over stdin/stdout. */
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
