import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
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
import { ModelDownloader } from "../src/dashboard/models.js";

const accountId = "personal";
const chatJid = "120363000000000@g.us";

const resources: Array<{ close: () => void; remove: () => void }> = [];

interface RawDashboardResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function rawDashboardRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawDashboardResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.close();
    resource.remove();
  }
});

describe("local dashboard HTTP API", () => {
  it("serves only a live Baileys link QR through the authenticated dashboard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-link-qr-"));
    const config = resolveConfig({}, { dataDir: dir });
    const token = ensureDashboardToken(config.web.tokenFile);
    config.paths.controlSocket = join(dir, "control.sock");
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: accountId });
    const qr =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
    writeFileSync(join(dir, "pairing-qr.svg"), `${qr}\n`, { mode: 0o600 });
    let pairingRequests = 0;
    const control = new HistoryControlServer(
      config.paths.controlSocket,
      async (request) => {
        if (request.op === "pairing.start") {
          pairingRequests += 1;
          return { pairing: { status: "starting" } };
        }
        throw new Error("not available");
      },
    );
    await control.start();
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
    resources.push({
      close: () => void control.close(),
      remove: () => undefined,
    });
    const address = dashboard.server.address();
    if (!address || typeof address === "string")
      throw new Error("dashboard did not bind");
    const base = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${base}/api/pairing/baileys/status`)).status).toBe(
      401,
    );
    const status = await fetch(`${base}/api/pairing/baileys/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "waiting_qr" });

    const svg = await fetch(`${base}/api/pairing/baileys/qr.svg`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect(await svg.text()).toBe(qr);

    const runtime = await fetch(`${base}/api/runtime`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await runtime.json()).toEqual({
      connection: "disconnected",
      authLinked: false,
    });

    const start = await fetch(`${base}/api/pairing/baileys/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(start.status).toBe(202);
    expect(await start.json()).toEqual({ status: "starting" });
    expect(pairingRequests).toBe(1);

    writeFileSync(join(dir, "pairing-qr.svg"), "<script>bad</script>");
    const unavailable = await fetch(`${base}/api/pairing/baileys/qr.svg`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unavailable.status).toBe(404);
  });

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
    const pairing = { status: "waiting_qr" as const, qr: null, error: null };
    const dashboard = await createDashboardServer(config, {
      db,
      config,
      configPath: join(dir, "config.yaml"),
      models: new ModelDownloader(join(dir, "models")),
      accountId,
      pairing,
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
    expect(staticHtml).toContain("data-requires-connection hidden");
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
    expect(appJs).toContain("refreshRuntimeView");
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

    const pendingQr = await fetch(`${base}/api/pairing/qr`, {
      headers: { Cookie: sessionCookie ?? "" },
    });
    expect(pendingQr.status).toBe(202);
    expect(await pendingQr.json()).toEqual({ qr: null, pending: true });

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

  it("uses the configured HTTPS origin behind an authenticated proxy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-public-"));
    const config = resolveConfig(
      { web: { public_origin: "https://dashboard.example.test" } },
      { dataDir: dir },
    );
    ensureDashboardToken(config.web.tokenFile);
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
    const proxyHeaders = { Host: "dashboard.example.test" };

    const bootstrap = await rawDashboardRequest(`${base}/`, {
      headers: proxyHeaders,
    });
    expect(bootstrap.status).toBe(200);
    const setCookie = bootstrap.headers["set-cookie"]?.[0];
    const sessionCookie = setCookie?.split(";", 1)[0];
    expect(setCookie).toMatch(
      /^dashboard_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Secure$/,
    );
    expect(sessionCookie).toBeDefined();

    const allowed = await rawDashboardRequest(
      `${base}/api/chats/${encodeURIComponent(chatJid)}/allow`,
      {
        method: "POST",
        headers: {
          ...proxyHeaders,
          Cookie: sessionCookie ?? "",
          Origin: "https://dashboard.example.test",
        },
      },
    );
    expect(allowed.status).toBe(200);

    const forgedOrigin = await rawDashboardRequest(
      `${base}/api/chats/${encodeURIComponent(chatJid)}/block`,
      {
        method: "POST",
        headers: {
          ...proxyHeaders,
          Cookie: sessionCookie ?? "",
          Origin: "https://attacker.example.test",
        },
      },
    );
    expect(forgedOrigin.status).toBe(403);

    const wrongHost = await rawDashboardRequest(`${base}/`, {
      headers: { Host: `127.0.0.1:${address.port}` },
    });
    expect(wrongHost.status).toBe(421);
    expect(wrongHost.headers["set-cookie"]).toBeUndefined();

    const forwardedHostOnly = await rawDashboardRequest(`${base}/`, {
      headers: {
        Host: `127.0.0.1:${address.port}`,
        "X-Forwarded-Host": "dashboard.example.test",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(forwardedHostOnly.status).toBe(421);
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
      configPath: join(dir, "config.yaml"),
      models: new ModelDownloader(join(dir, "models")),
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
      if (request.op === "directory.resync") {
        return { resynced: { contacts: 7, groups: 2 } };
      }
      if (request.op !== "history.start") {
        return { pairing: { status: "starting" } };
      }
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
      configPath: join(dir, "config.yaml"),
      models: new ModelDownloader(join(dir, "models")),
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

    const refreshed = await fetch(`${base}/api/directory/refresh`, {
      method: "POST",
      headers,
    });
    expect(refreshed.status).toBe(202);
    expect(await refreshed.json()).toEqual({
      status: "done",
      contacts: 7,
      groups: 2,
    });
  });

  it("returns 409 when the control socket is unreachable for a resync", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dash-resync-"));
    const config = resolveConfig({}, { dataDir: dir });
    const token = ensureDashboardToken(config.web.tokenFile);
    config.paths.controlSocket = join(dir, "control.sock"); // nothing listening
    const db = openDb(":memory:", { migrate: true });
    upsertAccount(db, { id: accountId });
    const dashboard = await createDashboardServer(config, {
      db,
      config,
      configPath: join(dir, "config.yaml"),
      models: new ModelDownloader(join(dir, "models")),
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
    const res = await fetch(
      `http://127.0.0.1:${address.port}/api/directory/refresh`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(409);
  });
});
