import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  setChatAllowed,
  createHistoryJob,
  upsertAccount,
  upsertChat,
  upsertGroupMember,
  upsertMessage,
  upsertParticipant,
} from "../src/db/queries.js";
import { createMcpContext, createMcpServer } from "../src/mcp/server.js";

async function connectedClient(
  historyControl?: (
    chat: string,
    since: number,
  ) => Promise<{ jobId: string; status: string; reused: boolean }>,
  configOverrides: Record<string, unknown> = {},
) {
  const config = resolveConfig(configOverrides, { dataDir: "/data" });
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
  upsertChat(db, {
    accountId: "personal",
    jid: "120@g.us",
    name: "Allowed group",
    isGroup: true,
  });
  setChatAllowed(db, "personal", "120@g.us", true);
  upsertParticipant(db, {
    accountId: "personal",
    jid: "33600000000@s.whatsapp.net",
    displayName: "Allowed contact",
  });
  upsertParticipant(db, {
    accountId: "personal",
    jid: "33600000002@s.whatsapp.net",
    displayName: "Group member",
  });
  upsertGroupMember(db, {
    accountId: "personal",
    groupJid: "120@g.us",
    participantJid: "33600000002@s.whatsapp.net",
    role: "admin",
  });
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
    chatJid: "33600000000@s.whatsapp.net",
    messageId: "M3",
    senderJid: "33600000000@s.whatsapp.net",
    timestamp: 1_700_000_002,
    messageType: "text",
    text: "réunion projet",
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
  if (historyControl) context.historyControl = historyControl;
  const server = createMcpServer(context);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test-client", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, db };
}

describe("MCP server", () => {
  it("registers read tools and bounded history controls", async () => {
    const { client, server, db } = await connectedClient();
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      [
        "wa_chat_stats",
        "wa_chats_list",
        "wa_contacts_search",
        "wa_get_media",
        "wa_get_transcript",
        "wa_group_participants",
        "wa_health",
        "wa_history_download",
        "wa_history_status",
        "wa_message_context",
        "wa_messages_list",
        "wa_messages_search",
        "wa_export",
      ].sort(),
    );
    expect(names.some((name) => name.includes("send"))).toBe(false);
    await client.close();
    await server.close();
    db.close();
  });

  it("returns only allowed chats and supports message search", async () => {
    const { client, server, db } = await connectedClient();
    const chats = await client.callTool({
      name: "wa_chats_list",
      arguments: {},
    });
    expect(JSON.stringify(chats)).toContain("Allowed chat");
    expect(JSON.stringify(chats)).not.toContain("Hidden chat");

    const messages = await client.callTool({
      name: "wa_messages_list",
      arguments: {},
    });
    expect(JSON.stringify(messages)).toContain("hello from allowed chat");
    expect(JSON.stringify(messages)).not.toContain("secret hidden chat");

    const search = await client.callTool({
      name: "wa_messages_search",
      arguments: { query: "reunion" },
    });
    expect(JSON.stringify(search)).toContain("M3");
    await client.close();
    await server.close();
    db.close();
  });

  it("returns directory members and roles only for allowed groups", async () => {
    const { client, server, db } = await connectedClient();
    const result = await client.callTool({
      name: "wa_group_participants",
      arguments: { chat: "120@g.us" },
    });
    expect(JSON.stringify(result)).toContain("Group member");
    expect(JSON.stringify(result)).toContain("admin");
    await client.close();
    await server.close();
    db.close();
  });

  it("reports unavailable transcription without inventing text", async () => {
    const { client, server, db } = await connectedClient();
    const result = await client.callTool({
      name: "wa_get_transcript",
      arguments: {
        chat: "33600000000@s.whatsapp.net",
        messageId: "M1",
      },
    });
    expect(JSON.stringify(result)).toContain('status\\":\\"unavailable');
    expect(JSON.stringify(result)).not.toContain("hello from allowed chat");
    await client.close();
    await server.close();
    db.close();
  });

  it("returns durable history job progress without exposing message content", async () => {
    const { client, server, db } = await connectedClient();
    createHistoryJob(db, {
      id: "job-1",
      accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      sinceTs: 1_600_000_000,
      untilTs: 1_700_000_000,
    });
    db.prepare(
      "update history_jobs set messages_received = 4, messages_inserted = 3, progress_percent = 42",
    ).run();
    const result = await client.callTool({
      name: "wa_history_status",
      arguments: { jobId: "job-1" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('\\"messagesReceived\\":4');
    expect(serialized).toContain('\\"progressPercent\\":42');
    expect(JSON.stringify(result)).not.toContain("hello from allowed chat");
    await client.close();
    await server.close();
    db.close();
  });

  it("starts history only for an explicitly allowed chat", async () => {
    const requests: Array<{ chat: string; since: number }> = [];
    const { client, server, db } = await connectedClient(
      async (chat, since) => {
        if (chat !== "33600000000@s.whatsapp.net") {
          throw new Error("chat is not available");
        }
        requests.push({ chat, since });
        return { jobId: "job-allowed", status: "queued", reused: false };
      },
    );
    const allowed = await client.callTool({
      name: "wa_history_download",
      arguments: { chat: "33600000000@s.whatsapp.net", since: 1_600_000_000 },
    });
    expect(JSON.stringify(allowed)).toContain("job-allowed");
    const hidden = await client.callTool({
      name: "wa_history_download",
      arguments: { chat: "33600000001@s.whatsapp.net", since: 1_600_000_000 },
    });
    expect(hidden.isError).toBe(true);
    expect(requests).toHaveLength(1);
    await client.close();
    await server.close();
    db.close();
  });
});
