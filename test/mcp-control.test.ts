import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { defaultConfigYaml, loadConfig } from "../src/config.js";
import { HistoryControlServer } from "../src/control/ipc.js";
import { applyPrivacySettings } from "../src/dashboard/privacy.js";
import { openDb } from "../src/db/index.js";
import { setChatAllowed, upsertAccount, upsertChat } from "../src/db/queries.js";
import { createSqliteReader } from "../src/db/sqlite-reader.js";
import { createMcpServer } from "../src/mcp/server.js";

function value(result: unknown): Record<string, unknown> | null {
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return JSON.parse(text) as Record<string, unknown> | null;
}

describe("MCP bounded local controls", () => {
  it("applies settings without paths and tightens an existing reader's scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "wac-mcp-control-"));
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, defaultConfigYaml(root), { mode: 0o600 });
    applyPrivacySettings(configPath, new URLSearchParams({ includeGroups: "true" }));
    mkdirSync(join(root, "models"));
    writeFileSync(join(root, "models", "ggml-base.bin"), "model");
    const config = loadConfig(configPath);
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: config.account.name });
    for (const [jid, isGroup] of [["allowed@s.whatsapp.net", false], ["120@g.us", true]] as const) {
      upsertChat(db, { accountId: config.account.name, jid, isGroup });
      setChatAllowed(db, config.account.name, jid, true);
    }
    const server = createMcpServer({
      reader: createSqliteReader(db, config, config.account.name),
      config,
      configPath,
      accountId: config.account.name,
      runtimeStatus: null,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "control-test", version: "0.1.0" });
    const control = new HistoryControlServer(config.paths.controlSocket, async (request) => {
      if (request.op === "media-backfill.status") return { mediaBackfill: null };
      throw new Error("unexpected request");
    });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const before = await client.callTool({ name: "wa_chats_list", arguments: {} });
      expect(JSON.stringify(before)).toContain("120@g.us");

      const unchanged = readFileSync(configPath, "utf8");
      for (const [name, args] of [
        ["wa_stt_settings", { enabled: true }],
        ["wa_privacy_settings", { storeMedia: true }],
      ] as const) {
        const rejected = await client.callTool({ name, arguments: args });
        expect(rejected.isError).toBe(true);
        expect(value(rejected)).toEqual({ error: "ingestion daemon unavailable; settings were not saved" });
        expect(readFileSync(configPath, "utf8")).toBe(unchanged);
      }
      await control.start();

      const stt = await client.callTool({
        name: "wa_stt_settings", arguments: { enabled: true, language: "auto", modelId: "base" },
      });
      expect(value(stt)).toMatchObject({ enabled: true, language: "auto", modelId: "base" });
      expect(JSON.stringify(stt)).not.toContain(root);
      const badModel = await client.callTool({
        name: "wa_stt_settings", arguments: { modelId: "../../secret" },
      });
      expect(badModel.isError).toBe(true);
      expect(JSON.stringify(badModel)).not.toContain(root);
      const beforeUnknown = readFileSync(configPath, "utf8");
      for (const [name, args] of [
        ["wa_stt_settings", { enabled: false, unexpected: true }],
        ["wa_privacy_settings", { storeMedia: false, unexpected: true }],
      ] as const) {
        const rejected = await client.callTool({ name, arguments: args });
        expect(rejected.isError).toBe(true);
        expect(readFileSync(configPath, "utf8")).toBe(beforeUnknown);
      }
      const check = await client.callTool({ name: "wa_stt_check", arguments: {} });
      expect(value(check)).toMatchObject({ scope: "local_engine" });
      expect(JSON.stringify(check)).not.toContain(root);

      // The YAML may also change outside MCP, as it does through the dashboard.
      applyPrivacySettings(configPath, new URLSearchParams({ includeGroups: "false" }));
      const after = await client.callTool({ name: "wa_chats_list", arguments: {} });
      expect(JSON.stringify(after)).not.toContain("120@g.us");
      const saved = await client.callTool({
        name: "wa_privacy_settings", arguments: { storeMedia: true },
      });
      expect(value(saved)).toMatchObject({ storeMedia: true, includeGroups: false, restartRequired: true });
      expect(loadConfig(configPath).privacy.storeMedia).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await control.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires explicit bulk opt-in and keeps commands on the daemon socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "wac-mcp-commands-"));
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, defaultConfigYaml(root), { mode: 0o600 });
    const config = loadConfig(configPath);
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: config.account.name });
    upsertChat(db, { accountId: config.account.name, jid: "allowed@s.whatsapp.net" });
    setChatAllowed(db, config.account.name, "allowed@s.whatsapp.net", true);
    let started = 0;
    const control = new HistoryControlServer(config.paths.controlSocket, async (request) => {
      if (request.op === "media-backfill.start") {
        started++;
        return { jobId: "job-1", status: "queued", reused: false };
      }
      if (request.op === "media-backfill.status") {
        return { mediaBackfill: null };
      }
      if (request.op === "directory.resync") return { resynced: { contacts: 2, groups: 1 } };
      if (request.op === "daemon.restart") return { restarting: { status: "restarting" } };
      throw new Error("unexpected request");
    });
    const server = createMcpServer({
      reader: createSqliteReader(db, config, config.account.name), config,
      configPath, accountId: config.account.name, runtimeStatus: null,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "control-test", version: "0.1.0" });
    try {
      await control.start();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const unspecified = await client.callTool({ name: "wa_media_backfill_start", arguments: {} });
      expect(unspecified.isError).toBe(true);
      const hidden = await client.callTool({
        name: "wa_media_backfill_start", arguments: { chat: "hidden@s.whatsapp.net" },
      });
      expect(hidden.isError).toBe(true);
      expect(started).toBe(0);
      const one = await client.callTool({
        name: "wa_media_backfill_start", arguments: { chat: "allowed@s.whatsapp.net" },
      });
      expect(value(one)).toMatchObject({ jobId: "job-1", status: "queued" });
      const all = await client.callTool({ name: "wa_media_backfill_start", arguments: { allChats: true } });
      expect(value(all)).toMatchObject({ jobId: "job-1" });
      expect(started).toBe(2);
      const status = await client.callTool({ name: "wa_media_backfill_status", arguments: {} });
      expect(value(status)).toBeNull();
      const directory = await client.callTool({ name: "wa_directory_refresh", arguments: {} });
      expect(value(directory)).toMatchObject({ status: "done", contacts: 2, groups: 1 });
      const restart = await client.callTool({ name: "wa_ingestion_restart", arguments: {} });
      expect(value(restart)).toEqual({ status: "restarting" });
    } finally {
      await client.close();
      await server.close();
      await control.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
