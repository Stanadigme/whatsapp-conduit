import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { upsertAccount } from "../src/db/queries.js";
import { createSqliteReader } from "../src/db/sqlite-reader.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { ModelDownloader } from "../src/dashboard/models.js";
import { ensureDashboardToken } from "../src/dashboard/token.js";
import { modelsDir } from "../src/stt/models.js";

const resources: Array<{ close: () => void; remove: () => void }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.close();
    resource.remove();
  }
});

async function harness(oauth = true): Promise<{
  base: string;
  headers: { Authorization: string };
  dataDir: string;
  tokenFile: string;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "wac-dashboard-oauth-"));
  const config = resolveConfig(
    oauth
      ? {
          mcp: {
            http: {
              oauth: { enabled: true, issuer: "https://mcp.example.test" },
            },
          },
        }
      : {},
    { dataDir },
  );
  const token = ensureDashboardToken(config.web.tokenFile);
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "personal" });
  const dashboard = await createDashboardServer(config, {
    db,
    reader: createSqliteReader(db, config, "personal"),
    config,
    configPath: join(dataDir, "config.yaml"),
    models: new ModelDownloader(modelsDir(config)),
    accountId: "personal",
  });
  await new Promise<void>((resolve) =>
    dashboard.server.listen(0, "127.0.0.1", resolve),
  );
  resources.push({
    close: () => dashboard.server.close(),
    remove: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  });
  const address = dashboard.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    headers: { Authorization: `Bearer ${token}` },
    dataDir,
    tokenFile: config.mcp.http.tokenFile,
  };
}

function passwordForm(password: string, confirmation = password): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, confirmation }),
  };
}

describe("dashboard OAuth password", () => {
  it("requires dashboard authentication and never caches the response", async () => {
    const { base } = await harness();
    const response = await fetch(
      `${base}/api/oauth/password`,
      passwordForm("secret"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("secret");
  });

  it("validates the form without persisting a password", async () => {
    const { base, headers, tokenFile } = await harness();
    const response = await fetch(`${base}/api/oauth/password`, {
      ...passwordForm("secret", "different"),
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    expect(response.status).toBe(400);
    expect(existsSync(join(tokenFile, "..", "mcp-oauth-password"))).toBe(false);
    expect(await response.text()).not.toContain("secret");
  });

  it("changes the password, revokes OAuth state, and keeps credentials out of views", async () => {
    const { base, headers, dataDir, tokenFile } = await harness();
    const secret = "operator password";
    writeFileSync(join(dataDir, "mcp-oauth.json"), "{}\n");
    const response = await fetch(`${base}/api/oauth/password`, {
      ...passwordForm(secret),
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(existsSync(join(dataDir, "mcp-oauth.json"))).toBe(false);
    expect(
      readFileSync(join(tokenFile, "..", "mcp-oauth-password"), "utf8"),
    ).not.toContain(secret);

    const page = await fetch(`${base}/`);
    const html = await page.text();
    expect(html).toContain("Accès MCP OAuth");
    expect(html).toContain("https://mcp.example.test");
    expect(html).not.toContain(secret);
    expect(html).not.toContain(headers.Authorization.slice(7));
  });

  it("hides the OAuth form when OAuth is disabled", async () => {
    const { base, headers } = await harness(false);
    expect((await fetch(`${base}/`, { headers })).status).toBe(200);
    expect(await (await fetch(`${base}/`, { headers })).text()).not.toContain(
      "Accès MCP OAuth",
    );
    expect(
      (
        await fetch(`${base}/api/oauth/password`, {
          ...passwordForm("secret"),
          headers: {
            ...headers,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        })
      ).status,
    ).toBe(404);
  });
});
