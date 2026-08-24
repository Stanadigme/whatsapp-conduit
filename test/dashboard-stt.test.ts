import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfigYaml, resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { upsertAccount } from "../src/db/queries.js";
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
  modelsDirectory: string;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-stt-"));
  const configPath = join(dir, "config.yaml");
  // A real generated config: the comment-preservation assertion below is only
  // meaningful against the file operators actually get.
  writeFileSync(configPath, defaultConfigYaml(dir), { mode: 0o600 });
  const config = resolveConfig({}, { dataDir: dir });
  const token = ensureDashboardToken(config.web.tokenFile);
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: accountId });
  const dashboard = await createDashboardServer(config, {
    db,
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
    modelsDirectory: modelsDir(config),
  };
}

describe("dashboard transcription settings", () => {
  it("reports settings, the catalogue, and an absent worker", async () => {
    const { base, headers } = await harness();
    const response = await fetch(`${base}/api/stt`, { headers });
    expect(response.status).toBe(200);
    const view = (await response.json()) as Record<string, unknown>;

    expect(view.enabled).toBe(false);
    expect(view.language).toBe("fr");
    expect(view.models).toEqual([]);
    expect(view.modelInstalled).toBe(false);
    expect(view.catalogue).toHaveLength(4);
    expect(view.worker).toMatchObject({ running: false, lastPassAt: null });
    expect(view.queue).toEqual({ pending: 0, failed: 0 });
  });

  it("writes the three settings it owns and keeps the file readable", async () => {
    const { base, headers, configPath } = await harness();
    const before = readFileSync(configPath, "utf8");

    const response = await fetch(`${base}/api/stt?enabled=true&language=auto`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      enabled: true,
      language: "auto",
    });

    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("enabled: true");
    expect(after).toContain("language: auto");
    // Comments are what make this file editable by hand afterwards.
    expect(after).toContain("# Voice-note transcription.");
    expect(before).toContain("enabled: false");
  });

  it("refuses a language outside the supported set", async () => {
    const { base, headers, configPath } = await harness();
    const before = readFileSync(configPath, "utf8");

    const response = await fetch(`${base}/api/stt?language=de`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "language must be one of",
    );
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("refuses any key other than the three it owns", async () => {
    const { base, headers, configPath } = await harness();
    const before = readFileSync(configPath, "utf8");

    // The config allowlist also holds privacy.store_media and
    // logging.log_message_text: this route must never become a generic relay.
    const response = await fetch(`${base}/api/stt?privacy.store_media=true`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "unknown transcription setting",
    );
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(readFileSync(configPath, "utf8")).toContain("store_media: false");
  });

  it("refuses a model path that is not on disk", async () => {
    const { base, headers, configPath } = await harness();
    const before = readFileSync(configPath, "utf8");

    const response = await fetch(
      `${base}/api/stt?modelPath=${encodeURIComponent("/etc/passwd")}`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "not installed",
    );
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("refuses a download for a model outside the catalogue", async () => {
    const { base, headers } = await harness();
    const response = await fetch(`${base}/api/stt/models/pull?model=evil`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(404);
  });

  it("requires authentication", async () => {
    const { base } = await harness();
    expect((await fetch(`${base}/api/stt`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/stt?enabled=true`, { method: "POST" })).status,
    ).toBe(401);
  });
});
