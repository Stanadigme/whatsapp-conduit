import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfigYaml, resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { upsertAccount } from "../src/db/queries.js";
import { createSqliteReader } from "../src/db/sqlite-reader.js";
import { createDashboardServer } from "../src/dashboard/server.js";
import { ModelDownloader } from "../src/dashboard/models.js";
import { ensureDashboardToken } from "../src/dashboard/token.js";
import { modelsDir } from "../src/stt/models.js";

const accountId = "personal";
const resources: Array<{ close: () => void; remove: () => void }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.close();
    resource.remove();
  }
});

interface Harness {
  base: string;
  headers: { Authorization: string };
  configPath: string;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-privacy-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, defaultConfigYaml(dir), { mode: 0o600 });
  const config = resolveConfig({}, { dataDir: dir });
  const token = ensureDashboardToken(config.web.tokenFile);
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: accountId });
  const dashboard = await createDashboardServer(config, {
    db,
    reader: createSqliteReader(db, config, accountId),
    config,
    configPath,
    models: new ModelDownloader(modelsDir(config)),
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
  if (!address || typeof address === "string") {
    throw new Error("dashboard did not bind");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    headers: { Authorization: `Bearer ${token}` },
    configPath,
  };
}

describe("dashboard capture-scope settings", () => {
  it("reports the three settings it owns, matching config.yaml's defaults", async () => {
    const { base, headers } = await harness();
    const response = await fetch(`${base}/api/privacy`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      storeMedia: false,
      includeGroups: false,
      includeStatus: false,
    });
  });

  it("writes the settings it owns and keeps the file readable", async () => {
    const { base, headers, configPath } = await harness();
    const before = readFileSync(configPath, "utf8");

    const response = await fetch(
      `${base}/api/privacy?storeMedia=true&includeGroups=true`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      storeMedia: true,
      includeGroups: true,
      includeStatus: false,
    });

    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("# whatsapp-conduit configuration");
    expect(before).not.toEqual(after);
  });

  it("refuses an unknown field instead of ignoring it", async () => {
    const { base, headers } = await harness();
    const response = await fetch(
      `${base}/api/privacy?observeOnly=false`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'cannot set unknown privacy setting "observeOnly"',
    });
  });
});
