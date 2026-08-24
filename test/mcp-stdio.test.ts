import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import {
  setChatAllowed,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";

describe("compiled MCP stdio boundary", () => {
  it("speaks MCP over stdout and keeps diagnostics on stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "whatsapp-conduit-mcp-"));
    const configPath = join(root, "config.yaml");
    const dbPath = join(root, "whatsapp-conduit.db");
    const db = openDb(dbPath, { migrate: true });
    upsertAccount(db, {
      id: "personal",
      selfJid: "33744707085@s.whatsapp.net",
    });
    upsertChat(db, {
      accountId: "personal",
      jid: "33600000000@s.whatsapp.net",
      name: "Allowed",
    });
    setChatAllowed(db, "personal", "33600000000@s.whatsapp.net", true);
    upsertMessage(db, {
      accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "M1",
      senderJid: "33600000000@s.whatsapp.net",
      timestamp: 1_700_000_000,
      messageType: "text",
      text: "stdio smoke message",
    });
    db.close();

    await writeFile(
      configPath,
      `account:\n  name: personal\npaths:\n  data_dir: ${JSON.stringify(root)}\n  sqlite: ${JSON.stringify(dbPath)}\nmcp:\n  max_result_chars: 12000\n`,
      { mode: 0o600 },
    );

    const stderr: Buffer[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/cli.js"), "--config", configPath, "mcp"],
      cwd: resolve("."),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const client = new Client({ name: "stdio-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const result = await client.callTool({
        name: "wa_messages_list",
        arguments: {},
      });
      expect(tools.tools).toHaveLength(13);
      expect(JSON.stringify(result)).toContain("stdio smoke message");
      expect(Buffer.concat(stderr).toString("utf8")).not.toContain(
        "stdio smoke message",
      );
    } finally {
      await client.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
