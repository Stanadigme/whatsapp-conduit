import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  insertTranscription,
  setChatAllowed,
  setChatBlocked,
  upsertAccount,
  upsertChat,
  upsertMessage,
  upsertParticipant,
} from "../src/db/queries.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { ensureDashboardToken } from "../src/dashboard/token.js";
import { ModelDownloader } from "../src/dashboard/models.js";

const accountId = "personal";
const allowedChat = "33600000000@s.whatsapp.net";
const hiddenChat = "33600000001@s.whatsapp.net";
const blockedChat = "33600000002@s.whatsapp.net";
const resources: Array<{ close: () => void; remove: () => void }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.close();
    resource.remove();
  }
});

describe("dashboard message consultation", () => {
  it("lists allowed messages with metadata, transcripts, and opaque pagination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-messages-"));
    const config = resolveConfig({}, { dataDir: dir });
    const token = ensureDashboardToken(config.web.tokenFile);
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: accountId });
    upsertChat(db, {
      accountId,
      jid: allowedChat,
      name: "Discussion autorisée",
    });
    upsertChat(db, { accountId, jid: hiddenChat, name: "Discussion cachée" });
    upsertChat(db, { accountId, jid: blockedChat, name: "Discussion bloquée" });
    setChatAllowed(db, accountId, allowedChat, true);
    setChatBlocked(db, accountId, blockedChat, true);
    upsertParticipant(db, {
      accountId,
      jid: "33600000003@s.whatsapp.net",
      displayName: "Alice",
    });
    for (let index = 0; index < 55; index += 1) {
      upsertMessage(db, {
        accountId,
        chatJid: allowedChat,
        messageId: `M${String(index).padStart(2, "0")}`,
        senderJid: "33600000003@s.whatsapp.net",
        timestamp: 1_700_000_000 + index,
        messageType: index === 54 ? "audio" : "text",
        text: `message ${index}`,
        hasMedia: index === 54,
        durationS: index === 54 ? 7 : null,
        ingestionSource: index === 54 ? "history" : "live",
        editedMessageId: index === 54 ? "M53" : null,
        deletedAt: index === 54 ? 1_700_000_100 : null,
        rawJson: "private raw payload",
      });
    }
    insertTranscription(db, {
      accountId,
      chatJid: allowedChat,
      messageId: "M54",
      textRaw: "transcription brute",
      language: "fr",
      engine: "whisper-local",
      engineModel: "large-v3-turbo",
    });
    // Post-correction does not exist yet (Jalon 6), so its output is simulated
    // here to keep the corrected-transcript rendering covered.
    db.prepare(
      "update transcriptions set text_corrected = ? where message_id = ?",
    ).run("transcription corrigée", "M54");

    const dashboard = await createDashboardServer(config, {
      db,
      config,
      configPath: join(dir, "config.yaml"),
      models: new ModelDownloader(join(dir, "models")),
      accountId,
      pairing: { status: "disabled", qr: null, error: null },
      startPairing: async () => undefined,
      stopPairing: async () => undefined,
    });
    await new Promise<void>((resolve) =>
      dashboard.server.listen(0, "127.0.0.1", resolve),
    );
    resources.push({
      close: () => dashboard.server.close(),
      remove: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    });
    const address = dashboard.server.address();
    if (!address || typeof address === "string")
      throw new Error("dashboard did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: `Bearer ${token}` };

    const first = await fetch(
      `${base}/api/chats/${encodeURIComponent(allowedChat)}/messages?limit=50`,
      { headers },
    );
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.items[0]).toMatchObject({
      messageId: "M54",
      senderName: "Alice",
      text: "message 54",
      textRaw: "transcription brute",
      textCorrected: "transcription corrigée",
      hasMedia: true,
      durationS: 7,
      ingestionSource: "history",
      editedMessageId: "M53",
      deletedAt: 1_700_000_100,
    });
    expect(firstPage.items[0]).not.toHaveProperty("raw_json");
    expect(JSON.stringify(firstPage)).not.toContain("private raw payload");
    expect(firstPage.items[49]).toMatchObject({ messageId: "M05" });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await fetch(
      `${base}/api/chats/${encodeURIComponent(allowedChat)}/messages?limit=50&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      { headers },
    );
    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(secondPage.items.map((item) => item.messageId)).toEqual([
      "M04",
      "M03",
      "M02",
      "M01",
      "M00",
    ]);
    expect(secondPage.nextCursor).toBeNull();

    const hidden = await fetch(
      `${base}/api/chats/${encodeURIComponent(hiddenChat)}/messages`,
      { headers },
    );
    const blocked = await fetch(
      `${base}/api/chats/${encodeURIComponent(blockedChat)}/messages`,
      { headers },
    );
    const unknown = await fetch(
      `${base}/api/chats/${encodeURIComponent("unknown@s.whatsapp.net")}/messages`,
      { headers },
    );
    expect(hidden.status).toBe(404);
    expect(blocked.status).toBe(404);
    expect(unknown.status).toBe(404);

    const invalidLimit = await fetch(
      `${base}/api/chats/${encodeURIComponent(allowedChat)}/messages?limit=201`,
      { headers },
    );
    const invalidCursor = await fetch(
      `${base}/api/chats/${encodeURIComponent(allowedChat)}/messages?cursor=invalid`,
      { headers },
    );
    expect(invalidLimit.status).toBe(400);
    expect(invalidCursor.status).toBe(400);
  });

  it("saves manual corrections without changing the raw transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-correction-"));
    const config = resolveConfig({}, { dataDir: dir });
    const token = ensureDashboardToken(config.web.tokenFile);
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: accountId });
    upsertChat(db, {
      accountId,
      jid: allowedChat,
      name: "Discussion autorisée",
    });
    upsertChat(db, { accountId, jid: hiddenChat, name: "Discussion cachée" });
    setChatAllowed(db, accountId, allowedChat, true);
    upsertMessage(db, {
      accountId,
      chatJid: allowedChat,
      messageId: "AUDIO-1",
      senderJid: allowedChat,
      timestamp: 1_700_000_000,
      messageType: "audio",
      hasMedia: true,
      durationS: 8,
    });
    upsertMessage(db, {
      accountId,
      chatJid: allowedChat,
      messageId: "AUDIO-2",
      senderJid: allowedChat,
      timestamp: 1_700_000_001,
      messageType: "audio",
      hasMedia: true,
      durationS: 8,
    });
    insertTranscription(db, {
      accountId,
      chatJid: allowedChat,
      messageId: "AUDIO-1",
      textRaw: "sortie moteur à préserver",
      language: "fr",
      engine: "whisper-local",
      engineModel: "large-v3-turbo",
    });
    const dashboard = await createDashboardServer(config, {
      db,
      config,
      configPath: join(dir, "config.yaml"),
      models: new ModelDownloader(join(dir, "models")),
      accountId,
      pairing: { status: "disabled", qr: null, error: null },
      startPairing: async () => undefined,
      stopPairing: async () => undefined,
    });
    await new Promise<void>((resolve) =>
      dashboard.server.listen(0, "127.0.0.1", resolve),
    );
    resources.push({
      close: () => dashboard.server.close(),
      remove: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    });
    const address = dashboard.server.address();
    if (!address || typeof address === "string")
      throw new Error("dashboard did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const path = `${base}/api/chats/${encodeURIComponent(allowedChat)}/messages/AUDIO-1/transcription/correction`;

    expect(
      (
        await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ textCorrected: "ne doit pas être accepté" }),
        })
      ).status,
    ).toBe(401);

    const saved = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ textCorrected: "sortie corrigée" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      messageId: "AUDIO-1",
      textRaw: "sortie moteur à préserver",
      textCorrected: "sortie corrigée",
    });
    expect(
      db
        .prepare(
          "select text_raw, text_corrected from transcriptions where message_id = ?",
        )
        .get("AUDIO-1"),
    ).toEqual({
      text_raw: "sortie moteur à préserver",
      text_corrected: "sortie corrigée",
    });

    const empty = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ textCorrected: "" }),
    });
    expect(empty.status).toBe(200);
    const emptyPayload = (await empty.json()) as { textCorrected: string };
    expect(emptyPayload.textCorrected).toBe("");

    const invalid = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ textCorrected: "ok", extra: "refusé" }),
    });
    expect(invalid.status).toBe(400);

    const hidden = await fetch(
      `${base}/api/chats/${encodeURIComponent(hiddenChat)}/messages/AUDIO-1/transcription/correction`,
      { method: "POST", headers, body: JSON.stringify({ textCorrected: "x" }) },
    );
    expect(hidden.status).toBe(404);

    const missing = await fetch(
      `${base}/api/chats/${encodeURIComponent(allowedChat)}/messages/MISSING/transcription/correction`,
      { method: "POST", headers, body: JSON.stringify({ textCorrected: "x" }) },
    );
    expect(missing.status).toBe(404);

    const withoutTranscript = await fetch(
      `${base}/api/chats/${encodeURIComponent(allowedChat)}/messages/AUDIO-2/transcription/correction`,
      { method: "POST", headers, body: JSON.stringify({ textCorrected: "x" }) },
    );
    expect(withoutTranscript.status).toBe(409);
  });

  it("serves the dedicated conversation route and navigation asset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-route-"));
    const config = resolveConfig({}, { dataDir: dir });
    ensureDashboardToken(config.web.tokenFile);
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: accountId });
    upsertChat(db, {
      accountId,
      jid: allowedChat,
      name: "Discussion autorisée",
    });
    setChatAllowed(db, accountId, allowedChat, true);
    const dashboard = await createDashboardServer(config, {
      db,
      config,
      configPath: join(dir, "config.yaml"),
      models: new ModelDownloader(join(dir, "models")),
      accountId,
      pairing: { status: "disabled", qr: null, error: null },
      startPairing: async () => undefined,
      stopPairing: async () => undefined,
    });
    await new Promise<void>((resolve) =>
      dashboard.server.listen(0, "127.0.0.1", resolve),
    );
    resources.push({
      close: () => dashboard.server.close(),
      remove: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    });
    const address = dashboard.server.address();
    if (!address || typeof address === "string")
      throw new Error("dashboard did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const route = await fetch(
      `${base}/conversation/${encodeURIComponent(allowedChat)}`,
    );
    const app = await fetch(`${base}/app.js`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("conversation-messages");
    const appText = await app.text();
    expect(appText).toContain("Lire la discussion");
    expect(appText).toContain("Corriger");
    expect(appText).toContain("transcription/correction");
    expect(await (await fetch(`${base}/styles.css`)).text()).toContain(
      "message-list",
    );
  });
});
