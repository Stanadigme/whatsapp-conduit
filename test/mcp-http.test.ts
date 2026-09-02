import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb, type Database } from "../src/db/index.js";
import {
  setChatAllowed,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import { createMcpContext } from "../src/mcp/server.js";
import { createMcpHttpServer } from "../src/mcp/http.js";
import { createLogger } from "../src/util/logging.js";

const TOKEN = "t".repeat(48);

function silentLogger() {
  return createLogger({ level: "fatal" });
}

async function fixtureContext() {
  const config = resolveConfig({}, { dataDir: "/data" });
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "personal", selfJid: "33744707085@s.whatsapp.net" });
  upsertChat(db, {
    accountId: "personal",
    jid: "33600000000@s.whatsapp.net",
    name: "Allowed chat",
  });
  upsertChat(db, {
    accountId: "personal",
    jid: "33600000001@s.whatsapp.net",
    name: "Hidden chat",
  });
  setChatAllowed(db, "personal", "33600000000@s.whatsapp.net", true);
  upsertMessage(db, {
    accountId: "personal",
    chatJid: "33600000000@s.whatsapp.net",
    messageId: "M1",
    senderJid: "33600000000@s.whatsapp.net",
    timestamp: 1_700_000_000,
    messageType: "text",
    text: "hello from allowed chat",
  });
  upsertMessage(db, {
    accountId: "personal",
    chatJid: "33600000001@s.whatsapp.net",
    messageId: "M2",
    senderJid: "33600000001@s.whatsapp.net",
    timestamp: 1_700_000_001,
    messageType: "text",
    text: "secret hidden chat",
  });
  const context = await createMcpContext(db, config);
  return { context, db };
}

interface Harness {
  db: Database;
  baseUrl: string;
  close: () => Promise<void>;
}

let harness: Harness;

beforeEach(async () => {
  const { context, db } = await fixtureContext();
  const server = createMcpHttpServer(context, {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    logger: silentLogger(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  harness = {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
});

afterEach(async () => {
  await harness.close();
});

function authedClient() {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${harness.baseUrl}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
  );
  const client = new Client({ name: "mcp-http-test", version: "0.1.0" });
  return { transport, client };
}

describe("MCP Streamable HTTP transport", () => {
  it("exposes the same read tools as stdio over an authenticated session", async () => {
    const { transport, client } = authedClient();
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(13);
      expect(tools.tools.map((tool) => tool.name)).toContain("wa_health");
      expect(tools.tools.some((tool) => tool.name.includes("send"))).toBe(
        false,
      );
      // A second call reuses the established Mcp-Session-Id.
      expect(transport.sessionId).toBeTruthy();
      const again = await client.listTools();
      expect(again.tools).toHaveLength(13);
    } finally {
      await client.close();
    }
  });

  it("enforces the allowlist over HTTP", async () => {
    const { transport, client } = authedClient();
    await client.connect(transport);
    try {
      const messages = await client.callTool({
        name: "wa_messages_list",
        arguments: {},
      });
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain("hello from allowed chat");
      expect(serialized).not.toContain("secret hidden chat");
    } finally {
      await client.close();
    }
  });

  it("rejects requests without a valid bearer token", async () => {
    const missing = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    const wrongText = await (
      await fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      })
    ).text();
    expect(wrongText).not.toContain(TOKEN);
  });

  it("serves a public /health without private data", async () => {
    const response = await fetch(`${harness.baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.name).toBe("whatsapp-conduit");
    expect(typeof body.schema).toBe("string");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("hello from allowed chat");
    expect(raw).not.toContain("@s.whatsapp.net");
    expect(raw).not.toMatch(/messages?"\s*:/i);
  });

  it("rejects an unknown Mcp-Session-Id on a non-initialize request", async () => {
    const response = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        "Mcp-Session-Id": "does-not-exist",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(400);
  });

  it("ends the session on DELETE", async () => {
    const { transport, client } = authedClient();
    await client.connect(transport);
    const sessionId = transport.sessionId as string;
    expect(sessionId).toBeTruthy();
    await client.close();

    const deleted = await fetch(`${harness.baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Mcp-Session-Id": sessionId,
      },
    });
    expect(deleted.status).toBe(200);

    const reuse = await fetch(`${harness.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(reuse.status).toBe(400);
  });
});
