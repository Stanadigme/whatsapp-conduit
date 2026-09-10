import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { runInit } from "../src/commands/init.js";
import { runExport } from "../src/commands/export.js";
import { runOffsetsCommit, runOffsetsShow } from "../src/commands/offsets.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { setChatAllowed, upsertAccount, upsertChat, upsertMessage } from "../src/db/queries.js";
import {
  flushPostgresProjection,
  shutdownPostgresProjection,
  startPostgresProjection,
} from "../src/db/postgres-projection.js";
import { runPostgresMigrations } from "../src/db/postgres.js";
import { createLogger } from "../src/util/logging.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-offsets-"));
  configPath = join(dir, "config.yaml");
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: unknown, ...args: unknown[]) => {
      const cb = args.find((a) => typeof a === "function") as
        | ((err?: Error | null) => void)
        | undefined;
      cb?.();
      return true;
    },
  );
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  runInit({ configPath, dataDir: join(dir, "data") });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("offsets (SQLite)", () => {
  it("round-trips a commit through `offsets show`", async () => {
    expect(await runOffsetsShow("export", { configPath, json: true })).toBe(1);
    await runOffsetsCommit("export", { configPath, through: 42 });
    expect(await runOffsetsShow("export", { configPath, json: true })).toBe(0);
  });
});

/**
 * Proves offsets.ts and export.ts resolve to the *same* backend: without
 * this, `export --since-last --commit` could advance the cursor in
 * PostgreSQL while `offsets show`/`offsets commit` kept reading and writing
 * SQLite, silently splitting the two into different states.
 *
 * Needs the same TLS-enabled PostgreSQL as mcp-postgres-integration.test.ts
 * (see that file's docstring for the container recipe) — plain
 * postgres:17-alpine is not enough since phase 1 requires TLS.
 */
const url = process.env.WA_TEST_POSTGRES_TLS_URL;
const caFile = process.env.WA_TEST_POSTGRES_CA_FILE;
const pool = url ? new Pool({ connectionString: url, max: 1 }) : undefined;
const logger = createLogger({ level: "error" });

afterAll(async () => {
  await shutdownPostgresProjection();
  await pool?.end();
});

describe.skipIf(!url || !caFile)("offsets and export agree on PostgreSQL", () => {
  it("makes export --commit's offset immediately visible to offsets show, and vice versa", async () => {
    await pool!.query("drop schema public cascade; create schema public");
    const client = await pool!.connect();
    try {
      await runPostgresMigrations(client);
    } finally {
      client.release();
    }
    await shutdownPostgresProjection();

    const config = loadConfig(configPath);
    const db = openDb(config.paths.sqlite, { migrate: true });
    startPostgresProjection(
      { connect: () => pool!.connect(), end: async () => undefined },
      logger,
    );
    upsertAccount(db, { id: config.account.name });
    upsertChat(db, { accountId: config.account.name, jid: "a@s.whatsapp.net" });
    setChatAllowed(db, config.account.name, "a@s.whatsapp.net", true);
    upsertMessage(db, {
      accountId: config.account.name,
      chatJid: "a@s.whatsapp.net",
      messageId: "M1",
      timestamp: 1_700_000_000,
      text: "hello",
    });
    await flushPostgresProjection();
    db.close();

    const passwordFile = join(dir, "postgres.password");
    const caFileCopy = join(dir, "ca.pem");
    writeFileSync(passwordFile, "test", { mode: 0o600 });
    writeFileSync(caFileCopy, readFileSync(caFile!), { mode: 0o600 });
    const parsed = new URL(url!);
    const document = parseDocument(readFileSync(configPath, "utf8"));
    document.setIn(
      ["persistence", "postgres", "url"],
      `postgresql://${parsed.username}@${parsed.hostname}:${parsed.port}${parsed.pathname}`,
    );
    document.setIn(["persistence", "postgres", "password_file"], passwordFile);
    document.setIn(["persistence", "postgres", "ca_file"], caFileCopy);
    writeFileSync(configPath, String(document), { mode: 0o600 });

    // export --since-last --commit advances the offset in PostgreSQL...
    const result = await runExport({
      configPath,
      sinceLast: "downstream",
      commit: true,
    });
    expect(result.committed).toBe(true);
    expect(result.count).toBe(1);

    // ...and offsets show, run separately, reads that same PostgreSQL cursor.
    const shown = await runOffsetsShow("downstream", {
      configPath,
      json: true,
    });
    expect(shown).toBe(0);

    // offsets commit's own write must be visible the same way, in reverse.
    await runOffsetsCommit("downstream", { configPath, through: 999 });
    const row = await pool!.query<{ last_seen_event_id: string }>(
      "select last_seen_event_id from consumer_offsets where consumer_name = 'downstream'",
    );
    expect(Number(row.rows[0]?.last_seen_event_id)).toBe(999);
  });
});
