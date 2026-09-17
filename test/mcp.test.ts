import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  insertTranscription,
  setChatAllowed,
  setChatBlocked,
  createHistoryJob,
  upsertAccount,
  upsertChat,
  upsertGroupMember,
  upsertMessage,
  upsertParticipant,
} from "../src/db/queries.js";
import { createSqliteReader } from "../src/db/sqlite-reader.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { McpContext } from "../src/mcp/types.js";

async function connectedClient(
  historyControl?: (
    chat: string,
    since: number,
  ) => Promise<{ jobId: string; status: string; reused: boolean }>,
  // This fixture seeds an explicitly allowed group chat; groups are excluded
  // by default (ADR-0037 exposure rule), so the fixture opts them back in.
  configOverrides: Record<string, unknown> = {
    privacy: { include_groups: true },
  },
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

  const context: McpContext = {
    reader: createSqliteReader(db, config, "personal"),
    config,
    accountId: "personal",
    runtimeStatus: null,
    ...(historyControl ? { historyControl } : {}),
  };
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
        "wa_history_active",
        "wa_history_status",
        "wa_stt_status",
        "wa_stt_settings",
        "wa_stt_check",
        "wa_privacy_status",
        "wa_privacy_settings",
        "wa_media_backfill_start",
        "wa_media_backfill_status",
        "wa_directory_refresh",
        "wa_ingestion_restart",
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

  it("filters visible chats before paginating by name, JID, kind and audio", async () => {
    const { client, server, db } = await connectedClient();
    upsertMessage(db, {
      accountId: "personal", chatJid: "33600000000@s.whatsapp.net",
      messageId: "audio-visible", senderJid: "33600000000@s.whatsapp.net",
      timestamp: 1_700_000_003, messageType: "audio",
    });
    upsertMessage(db, {
      accountId: "personal", chatJid: "33600000001@s.whatsapp.net",
      messageId: "audio-hidden", senderJid: "33600000001@s.whatsapp.net",
      timestamp: 1_700_000_004, messageType: "audio",
    });
    const items = async (arguments_: Record<string, unknown>) => {
      const result = await client.callTool({ name: "wa_chats_list", arguments: arguments_ });
      return JSON.parse(((result as { content: Array<{ text: string }> }).content[0]!).text) as {
        items: Array<{ jid: string }>; nextCursor: string | null;
      };
    };
    expect((await items({ query: "Allowed contact" })).items.map((c) => c.jid))
      .toEqual(["33600000000@s.whatsapp.net"]);
    expect((await items({ query: "120@" })).items.map((c) => c.jid))
      .toEqual(["120@g.us"]);
    expect((await items({ kind: "contact", hasAudio: true })).items.map((c) => c.jid))
      .toEqual(["33600000000@s.whatsapp.net"]);
    expect((await items({ kind: "group", hasAudio: false })).items.map((c) => c.jid))
      .toEqual(["120@g.us"]);
    expect((await items({ kind: "status" })).items).toEqual([]);
    const first = await items({ limit: 1 });
    const second = await items({ limit: 1, cursor: first.nextCursor });
    expect([...first.items, ...second.items].map((c) => c.jid))
      .toEqual(["120@g.us", "33600000000@s.whatsapp.net"]);
    expect(JSON.stringify(await items({ query: "Hidden" }))).not.toContain("Hidden");
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
    expect(JSON.stringify(chats)).toContain("Allowed contact");
    expect(JSON.stringify(chats)).not.toContain("Allowed chat");
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

  it("refuses a message context once its chat is blocked, even if is_allowed lingers", async () => {
    const { client, server, db } = await connectedClient();
    // setChatBlocked always clears is_allowed, so this inconsistent state can
    // only arise from a raw write bypassing it (a migration, an admin fix).
    // messageContext's own window query now checks is_blocked too, not just
    // the upstream allowedChat() guard, so it can't come to rely on that
    // invariant holding.
    db.prepare(
      "update chats set is_blocked = 1 where account_id = 'personal' and jid = '33600000000@s.whatsapp.net'",
    ).run();
    const result = await client.callTool({
      name: "wa_message_context",
      arguments: { chat: "33600000000@s.whatsapp.net", messageId: "M1" },
    });
    expect(result.isError).toBe(true);
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

  it("reports a missing transcription without inventing text", async () => {
    const { client, server, db } = await connectedClient();
    const result = await client.callTool({
      name: "wa_get_transcript",
      arguments: {
        chat: "33600000000@s.whatsapp.net",
        messageId: "M1",
      },
    });
    // The tables exist since migration 0007, so an untranscribed message is
    // pending rather than unsupported. Either way it never returns the written
    // message text as if it were a transcript.
    expect(JSON.stringify(result)).toContain('status\\":\\"pending');
    expect(JSON.stringify(result)).not.toContain("hello from allowed chat");
    await client.close();
    await server.close();
    db.close();
  });

  it("returns the effective transcript and keeps raw access explicit", async () => {
    const { client, server, db } = await connectedClient();
    upsertMessage(db, {
      accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "A1",
      senderJid: "33600000000@s.whatsapp.net",
      timestamp: 1_700_000_003,
      messageType: "audio",
      hasMedia: true,
      durationS: 6,
    });
    insertTranscription(db, {
      accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      messageId: "A1",
      textRaw: "sortie brute",
      language: "fr",
      engine: "whisper-local",
      engineModel: "large-v3-turbo",
    });
    db.prepare(
      "update transcriptions set text_corrected = ? where message_id = ?",
    ).run("sortie corrigée", "A1");

    const effective = await client.callTool({
      name: "wa_get_transcript",
      arguments: {
        chat: "33600000000@s.whatsapp.net",
        messageId: "A1",
      },
    });
    const effectiveText = JSON.stringify(effective);
    expect(effectiveText).toContain("sortie corrigée");
    expect(effectiveText).not.toContain("sortie brute");

    const raw = await client.callTool({
      name: "wa_get_transcript",
      arguments: {
        chat: "33600000000@s.whatsapp.net",
        messageId: "A1",
        raw: true,
      },
    });
    const rawText = JSON.stringify(raw);
    expect(rawText).toContain("sortie brute");
    expect(rawText).toContain("sortie corrigée");

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
    const active = await client.callTool({ name: "wa_history_active", arguments: {} });
    expect(JSON.stringify(active)).toContain("job-1");
    expect(JSON.stringify(result)).not.toContain("hello from allowed chat");
    await client.close();
    await server.close();
    db.close();
  });

  it("hides historical jobs when their chat is unavailable", async () => {
    const { client, server, db } = await connectedClient();
    createHistoryJob(db, {
      id: "hidden-job", accountId: "personal",
      chatJid: "33600000001@s.whatsapp.net",
      sinceTs: 1_600_000_000, untilTs: 1_700_000_000,
    });
    const active = await client.callTool({ name: "wa_history_active", arguments: {} });
    expect((active as { content: Array<{ text: string }> }).content[0]!.text).toBe("null");
    const status = await client.callTool({
      name: "wa_history_status", arguments: { jobId: "hidden-job" },
    });
    expect(status.isError).toBe(true);
    expect(JSON.stringify(status)).not.toContain("33600000001@s.whatsapp.net");
    db.prepare("update history_jobs set status = 'completed' where id = 'hidden-job'").run();
    createHistoryJob(db, {
      id: "revoked-job", accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      sinceTs: 1_600_000_000, untilTs: 1_700_000_000,
    });
    setChatBlocked(db, "personal", "33600000000@s.whatsapp.net", true);
    const revoked = await client.callTool({
      name: "wa_history_status", arguments: { jobId: "revoked-job" },
    });
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).not.toContain("33600000000@s.whatsapp.net");
    await client.close();
    await server.close();
    db.close();
  });

  it("keeps history controls behind configured chat blocks", async () => {
    const { client, server, db } = await connectedClient(
      async () => ({ jobId: "should-not-start", status: "queued", reused: false }),
      { privacy: { include_groups: true }, filters: { blocked_chats: ["33600000000@s.whatsapp.net"] } },
    );
    createHistoryJob(db, {
      id: "configured-block", accountId: "personal",
      chatJid: "33600000000@s.whatsapp.net",
      sinceTs: 1_600_000_000, untilTs: 1_700_000_000,
    });
    const list = await client.callTool({ name: "wa_chats_list", arguments: {} });
    expect(JSON.stringify(list)).not.toContain("33600000000@s.whatsapp.net");
    const start = await client.callTool({
      name: "wa_history_download",
      arguments: { chat: "33600000000@s.whatsapp.net", since: 1_600_000_000 },
    });
    expect(start.isError).toBe(true);
    const active = await client.callTool({ name: "wa_history_active", arguments: {} });
    expect((active as { content: Array<{ text: string }> }).content[0]!.text).toBe("null");
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
