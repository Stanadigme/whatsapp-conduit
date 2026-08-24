import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  createHistoryJob,
  setChatAllowed,
  upsertAccount,
  upsertChat,
} from "../src/db/queries.js";
import { HistoryControlServer } from "../src/control/ipc.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { ensureDashboardToken } from "../src/dashboard/token.js";

const accountId = "personal";
const chatJid = "120363000000000@g.us";

const resources: Array<{ close: () => void; remove: () => void }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.close();
    resource.remove();
  }
});

describe("local dashboard HTTP API", () => {
  it("requires the bearer token while serving the static dashboard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-api-"));
    const config = resolveConfig({}, { dataDir: dir });
    const token = ensureDashboardToken(config.web.tokenFile);
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: accountId, selfJid: "33600000000@s.whatsapp.net" });
    upsertChat(db, {
      accountId,
      jid: chatJid,
      name: "Équipe produit",
      isGroup: true,
    });
    const dashboard = await createDashboardServer(config, {
      db,
      config,
      accountId,
      pairing: { status: "idle", qr: null, error: null },
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

    const staticResponse = await fetch(`${base}/`);
    expect(staticResponse.status).toBe(200);
    const staticHtml = await staticResponse.text();
    expect(staticHtml).toContain("Contacts et groupes");
    expect(staticHtml).not.toContain('id="token"');
    const setCookie = staticResponse.headers.get("set-cookie");
    expect(setCookie).toMatch(
      /^dashboard_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict$/,
    );
    expect(setCookie).not.toContain(token);
    const sessionCookie = setCookie?.split(";", 1)[0];
    expect(sessionCookie).toBeDefined();
    expect(await (await fetch(`${base}/`)).text()).toContain(
      "Synchronisation historique",
    );
    const appJs = await (await fetch(`${base}/app.js`)).text();
    expect(appJs).toContain("same-origin");
    expect(appJs).not.toContain("Bearer");
    expect(appJs).not.toContain('id="token"');
    expect(appJs).toContain("aucun message de cette discussion");
    const stylesResponse = await fetch(`${base}/styles.css`);
    expect(stylesResponse.status).toBe(200);
    expect(await stylesResponse.text()).toContain("color:#ffffff");

    const unauthorized = await fetch(`${base}/api/chats`);
    expect(unauthorized.status).toBe(401);

    const sessionAuthorized = await fetch(`${base}/api/chats`, {
      headers: { Cookie: sessionCookie ?? "" },
    });
    expect(sessionAuthorized.status).toBe(200);

    const forgedSession = await fetch(`${base}/api/chats`, {
      headers: { Cookie: `${sessionCookie}x` },
    });
    expect(forgedSession.status).toBe(401);

    const authorized = await fetch(`${base}/api/chats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual([
      expect.objectContaining({
        jid: chatJid,
        name: "Équipe produit",
        kind: "group",
        allowed: false,
      }),
    ]);
  });

  it("allows only discovered chats and returns the persisted policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-policy-"));
    const config = resolveConfig({}, { dataDir: dir });
    const token = ensureDashboardToken(config.web.tokenFile);
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: accountId });
    upsertChat(db, {
      accountId,
      jid: chatJid,
      name: "Équipe produit",
      isGroup: true,
    });
    const dashboard = await createDashboardServer(config, {
      db,
      config,
      accountId,
      pairing: { status: "idle", qr: null, error: null },
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
    const bootstrap = await fetch(`${base}/`);
    const sessionSetCookie = bootstrap.headers.get("set-cookie");
    const sessionCookie = sessionSetCookie?.split(";", 1)[0] ?? "";

    const csrfRejected = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatJid)}/allow`,
      { method: "POST", headers: { Cookie: sessionCookie } },
    );
    expect(csrfRejected.status).toBe(403);

    const sessionHeaders = {
      Cookie: sessionCookie,
      Origin: base,
    };

    const allowed = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatJid)}/allow`,
      { method: "POST", headers: sessionHeaders },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual(
      expect.objectContaining({ jid: chatJid, allowed: true, blocked: false }),
    );

    const unknown = await fetch(
      `${base}/api/chats/${encodeURIComponent("unknown@s.whatsapp.net")}/allow`,
      { method: "POST", headers },
    );
    expect(unknown.status).toBe(404);
  });

  it("starts an allowed chat history job through the ingestion control socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-history-"));
    const config = resolveConfig({}, { dataDir: dir });
    const token = ensureDashboardToken(config.web.tokenFile);
    const controlPath = join(dir, "control.sock");
    config.paths.controlSocket = controlPath;
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: accountId });
    upsertChat(db, { accountId, jid: chatJid, name: "Équipe produit" });
    setChatAllowed(db, accountId, chatJid, true);
    const control = new HistoryControlServer(controlPath, async (request) => {
      const jobId = "history-job-1";
      createHistoryJob(db, {
        id: jobId,
        accountId,
        chatJid: request.chat,
        sinceTs: request.since,
        untilTs: 1_800_000_000,
      });
      return { jobId, status: "queued", reused: false };
    });
    await control.start();
    const dashboard = await createDashboardServer(config, {
      db,
      config,
      accountId,
      pairing: { status: "idle", qr: null, error: null },
      startPairing: async () => undefined,
      stopPairing: async () => undefined,
    });
    await new Promise<void>((resolve) =>
      dashboard.server.listen(0, "127.0.0.1", resolve),
    );
    resources.push({
      close: () => {
        dashboard.server.close();
        void control.close();
      },
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

    const started = await fetch(
      `${base}/api/chats/${encodeURIComponent(chatJid)}/history?since=1700000000`,
      { method: "POST", headers },
    );
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual(
      expect.objectContaining({
        jobId: "history-job-1",
        status: "queued",
        reused: false,
      }),
    );

    const status = await fetch(`${base}/api/history/history-job-1`, {
      headers,
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(
      expect.objectContaining({
        id: "history-job-1",
        chatJid,
        status: "queued",
        sinceTs: 1_700_000_000,
      }),
    );
  });
});
