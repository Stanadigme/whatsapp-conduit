import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDbBackup } from "../src/commands/db.js";
import { runInit } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  setChatAllowed,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";

let dir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("db backup", () => {
  it("writes a readable owner-only snapshot while the source stays open", async () => {
    dir = mkdtempSync(join(tmpdir(), "wac-db-backup-"));
    const configPath = join(dir, "config.yaml");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runInit({ configPath, dataDir: join(dir, "data") });
    const config = loadConfig(configPath);

    // Hold the source open with WAL active, as ingestion does: copying the
    // .db file in this state is exactly what the backup API avoids.
    const source = openDb(config.paths.sqlite);
    upsertAccount(source, { id: config.account.name });
    upsertChat(source, {
      accountId: config.account.name,
      jid: "c@s.whatsapp.net",
    });
    setChatAllowed(source, config.account.name, "c@s.whatsapp.net", true);
    upsertMessage(source, {
      accountId: config.account.name,
      chatJid: "c@s.whatsapp.net",
      messageId: "M1",
      timestamp: 1_700_000_000,
      messageType: "text",
      text: "message a sauvegarder",
    });

    const output = join(dir, "snapshot.db");
    const report = await runDbBackup({ configPath, output });
    expect(report.sizeBytes).toBeGreaterThan(0);
    // 0600: the snapshot carries the same private messages as the source.
    expect(statSync(output).mode & 0o777).toBe(0o600);

    const restored = openDb(output, { migrate: false, readonly: true });
    expect(
      restored
        .prepare("select text from messages where message_id = ?")
        .get("M1"),
    ).toEqual({ text: "message a sauvegarder" });
    restored.close();
    source.close();
  });
});
