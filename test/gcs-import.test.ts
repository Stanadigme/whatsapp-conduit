import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runGcsImport } from "../src/commands/gcs.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { getAttachment, upsertAccount, upsertAttachment, upsertChat, upsertMessage } from "../src/db/queries.js";

const gcsMock = vi.hoisted(() => ({
  getOrCreateGcsBucket: vi.fn(() => ({ marker: "fake-bucket" })),
  uploadMediaToGcs: vi.fn(async () => undefined),
  gcsObjectKey: vi.fn(
    (accountId: string, sha256: string) => `${accountId}/${sha256}`,
  ),
}));
vi.mock("../src/db/gcs.js", () => gcsMock);

let dir: string;
let configPath: string;

beforeEach(() => {
  gcsMock.uploadMediaToGcs.mockClear();
  dir = mkdtempSync(join(tmpdir(), "wac-gcs-import-"));
  configPath = join(dir, "config.yaml");
  runInit({ configPath, dataDir: join(dir, "data") });
  const document = parseDocument(readFileSync(configPath, "utf8"));
  document.setIn(["persistence", "gcs", "bucket"], "test-bucket");
  document.setIn(
    ["persistence", "gcs", "credentials_file"],
    join(dir, "creds.json"),
  );
  writeFileSync(configPath, String(document), { mode: 0o600 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("gcs import (backfill)", () => {
  it("uploads locally-cached media never confirmed in GCS, and skips what's already confirmed", async () => {
    const config = loadConfig(configPath);
    const db = openDb(config.paths.sqlite, { migrate: true });
    upsertAccount(db, { id: config.account.name });
    upsertChat(db, { accountId: config.account.name, jid: "a@s.whatsapp.net" });
    upsertMessage(db, {
      accountId: config.account.name,
      chatJid: "a@s.whatsapp.net",
      messageId: "M1",
      messageType: "audio",
      hasMedia: true,
    });
    mkdirSync(config.paths.mediaDir, { recursive: true });
    const sha256 = "a".repeat(64);
    writeFileSync(join(config.paths.mediaDir, `${sha256}.opus`), "fake-audio");
    upsertAttachment(db, {
      accountId: config.account.name,
      chatJid: "a@s.whatsapp.net",
      messageId: "M1",
      mimeType: "audio/ogg",
      sha256,
      downloadedAt: 1_700_000_000,
    });

    // Already confirmed: must not be re-uploaded.
    upsertMessage(db, {
      accountId: config.account.name,
      chatJid: "a@s.whatsapp.net",
      messageId: "M2",
      messageType: "audio",
      hasMedia: true,
    });
    const doneSha = "b".repeat(64);
    writeFileSync(join(config.paths.mediaDir, `${doneSha}.opus`), "already there");
    upsertAttachment(db, {
      accountId: config.account.name,
      chatJid: "a@s.whatsapp.net",
      messageId: "M2",
      mimeType: "audio/ogg",
      sha256: doneSha,
      downloadedAt: 1_700_000_000,
      gcsUploadedAt: 1_700_000_001,
    });
    db.close();

    const report = await runGcsImport({ configPath, json: true });

    expect(report).toEqual({ uploaded: 1, missingLocalFile: 0, failed: 0 });
    expect(gcsMock.uploadMediaToGcs).toHaveBeenCalledTimes(1);

    const after = openDb(config.paths.sqlite, { migrate: false });
    const attachment = getAttachment(after, config.account.name, "a@s.whatsapp.net", "M1");
    expect(attachment?.gcs_uploaded_at).toEqual(expect.any(Number));
    after.close();

    // Idempotent: a second run finds nothing left to do.
    const second = await runGcsImport({ configPath, json: true });
    expect(second).toEqual({ uploaded: 0, missingLocalFile: 0, failed: 0 });
  });

  it("counts a missing local file instead of throwing", async () => {
    const config = loadConfig(configPath);
    const db = openDb(config.paths.sqlite, { migrate: true });
    upsertAccount(db, { id: config.account.name });
    upsertChat(db, { accountId: config.account.name, jid: "a@s.whatsapp.net" });
    upsertMessage(db, {
      accountId: config.account.name,
      chatJid: "a@s.whatsapp.net",
      messageId: "M1",
      messageType: "audio",
      hasMedia: true,
    });
    upsertAttachment(db, {
      accountId: config.account.name,
      chatJid: "a@s.whatsapp.net",
      messageId: "M1",
      mimeType: "audio/ogg",
      sha256: "c".repeat(64),
      downloadedAt: 1_700_000_000,
    });
    db.close();

    const report = await runGcsImport({ configPath, json: true });

    expect(report).toEqual({ uploaded: 0, missingLocalFile: 1, failed: 0 });
    expect(gcsMock.uploadMediaToGcs).not.toHaveBeenCalled();
  });

  it("refuses to run without persistence.gcs configured", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "wac-gcs-import-bare-"));
    const bareConfigPath = join(bareDir, "config.yaml");
    runInit({ configPath: bareConfigPath, dataDir: join(bareDir, "data") });
    await expect(runGcsImport({ configPath: bareConfigPath })).rejects.toThrow(
      "No GCS bucket configured",
    );
    rmSync(bareDir, { recursive: true, force: true });
  });
});
