import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runInit } from "../src/commands/init.js";
import { runPostgresImport } from "../src/commands/postgres.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { upsertDirectoryGroupMember } from "../src/db/directory.js";
import {
  createHistoryJob,
  setChatAllowed,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import { runPostgresMigrations } from "../src/db/postgres.js";
import { shutdownPostgresProjection } from "../src/db/postgres-projection.js";

/**
 * Needs the same TLS-enabled PostgreSQL as mcp-postgres-integration.test.ts
 * (see that file's docstring for the container recipe) — createPostgresPool
 * requires TLS unconditionally, so a plain postgres:17-alpine is not enough.
 */
const url = process.env.WA_TEST_POSTGRES_TLS_URL;
const caFile = process.env.WA_TEST_POSTGRES_CA_FILE;
const pool = url ? new Pool({ connectionString: url, max: 1 }) : undefined;

afterAll(async () => {
  await pool?.end();
});

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-pg-import-"));
  configPath = join(dir, "config.yaml");
  runInit({ configPath, dataDir: join(dir, "data") });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!url || !caFile)("postgres import (backfill)", () => {
  it("backfills chats, directory, messages, and history jobs already in SQLite", async () => {
    await pool!.query("drop schema public cascade; create schema public");
    const client = await pool!.connect();
    try {
      await runPostgresMigrations(client);
    } finally {
      client.release();
    }
    await shutdownPostgresProjection();

    // Seed SQLite as if the account had been ingesting for a while, entirely
    // before persistence.postgres was ever configured — no projection active.
    const config = loadConfig(configPath);
    const db = openDb(config.paths.sqlite, { migrate: true });
    upsertAccount(db, { id: config.account.name });
    upsertChat(db, {
      accountId: config.account.name,
      jid: "a@s.whatsapp.net",
      name: "Ancien contact",
    });
    setChatAllowed(db, config.account.name, "a@s.whatsapp.net", true);
    upsertChat(db, {
      accountId: config.account.name,
      jid: "g@g.us",
      name: "Ancien groupe",
      isGroup: true,
    });
    upsertDirectoryGroupMember(db, {
      accountId: config.account.name,
      groupJid: "g@g.us",
      participantJid: "33600000009@s.whatsapp.net",
      role: "member",
    });
    for (let i = 1; i <= 3; i += 1) {
      upsertMessage(db, {
        accountId: config.account.name,
        chatJid: "a@s.whatsapp.net",
        messageId: `M${i}`,
        timestamp: 1_700_000_000 + i,
        messageType: "text",
        text: `message ${i}`,
      });
    }
    createHistoryJob(db, {
      id: "job-old-1",
      accountId: config.account.name,
      chatJid: "a@s.whatsapp.net",
      sinceTs: 1_000,
      untilTs: 2_000,
    });
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

    const report = await runPostgresImport({ configPath, json: true });
    expect(report).toEqual({
      chats: 2,
      directoryEntities: 2, // the group + its one member, projected as entities
      groups: 1,
      messages: 3,
      historyJobs: 1,
    });

    const chats = await pool!.query<{ jid: string; is_allowed: boolean }>(
      "select jid, is_allowed from chats order by jid",
    );
    expect(chats.rows).toEqual([
      { jid: "a@s.whatsapp.net", is_allowed: true },
      { jid: "g@g.us", is_allowed: false },
    ]);

    expect(
      Number(
        (await pool!.query("select count(*) as n from messages")).rows[0].n,
      ),
    ).toBe(3);

    const member = await pool!.query<{ group_jid: string; member_jid: string }>(
      "select group_jid, member_jid from directory_group_members",
    );
    expect(member.rows).toEqual([
      { group_jid: "g@g.us", member_jid: "33600000009@s.whatsapp.net" },
    ]);

    const job = await pool!.query<{ id: string }>(
      "select id from history_jobs",
    );
    expect(job.rows).toEqual([{ id: "job-old-1" }]);

    // Idempotent: importing twice must not duplicate anything.
    await runPostgresImport({ configPath, json: true });
    expect(
      Number(
        (await pool!.query("select count(*) as n from messages")).rows[0].n,
      ),
    ).toBe(3);
  });

  it("refuses to run without persistence.postgres configured", async () => {
    await expect(runPostgresImport({ configPath })).rejects.toThrow(
      "No client database configured",
    );
  });
});
