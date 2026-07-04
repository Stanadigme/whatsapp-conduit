import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runExport, type ExportRecord } from "../src/commands/export.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  getConsumerOffset,
  selectExportMessages,
  setChatAllowed,
  setChatBlocked,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";

let dir: string;
let configPath: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-export-"));
  configPath = join(dir, "config.yaml");
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: unknown, ...args: unknown[]) => {
      stdout.push(String(chunk));
      // Invoke the write callback (used by flushStdout) if one was passed.
      const cb = args.find((a) => typeof a === "function") as
        | ((err?: Error | null) => void)
        | undefined;
      cb?.();
      return true;
    },
  );
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  runInit({ configPath, dataDir: join(dir, "data") });
  stdout = []; // discard init output
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const config = loadConfig(configPath);
  const db = openDb(config.paths.sqlite);
  upsertAccount(db, { id: config.account.name });
  upsertChat(db, { accountId: config.account.name, jid: "a@s.whatsapp.net" });
  upsertChat(db, { accountId: config.account.name, jid: "b@s.whatsapp.net" });
  setChatAllowed(db, config.account.name, "a@s.whatsapp.net", true);
  for (let i = 1; i <= 3; i++) {
    upsertMessage(db, {
      accountId: config.account.name,
      chatJid: "a@s.whatsapp.net",
      messageId: `A${i}`,
      senderJid: "49123@s.whatsapp.net",
      timestamp: 1000 + i,
      text: `allowed ${i}`,
    });
  }
  upsertMessage(db, {
    accountId: config.account.name,
    chatJid: "b@s.whatsapp.net",
    messageId: "B1",
    timestamp: 2000,
    text: "not allowed",
  });
  db.close();
}

function records(): ExportRecord[] {
  return stdout
    .join("")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ExportRecord);
}

describe("runExport", () => {
  it("defaults to allowed-only (does not leak non-allowed chats)", async () => {
    seed();
    const result = await runExport({ configPath });
    expect(result.count).toBe(3);
    const recs = records();
    expect(recs.every((r) => r.chat_jid === "a@s.whatsapp.net")).toBe(true);
  });

  it("--all includes non-allowed chats, in ascending cursor order", async () => {
    seed();
    const result = await runExport({ configPath, all: true });
    expect(result.count).toBe(4);
    const recs = records();
    expect(recs.map((r) => r.message_id)).toEqual(["A1", "A2", "A3", "B1"]);
    expect(recs.map((r) => r.cursor)).toEqual(
      [...recs.map((r) => r.cursor)].sort((x, y) => x - y),
    );
  });

  it("never exports a chat blocked via the DB flag, even with --all", async () => {
    seed();
    const config = loadConfig(configPath);
    const db = openDb(config.paths.sqlite);
    setChatBlocked(db, config.account.name, "b@s.whatsapp.net", true);
    db.close();

    await runExport({ configPath, all: true });
    const recs = records();
    expect(recs.every((r) => r.chat_jid !== "b@s.whatsapp.net")).toBe(true);
  });

  it("excludes config blocked_chats (selectExportMessages), even under --all", () => {
    const db = openDb(join(dir, "data", "whatsapp-conduit.db"));
    upsertAccount(db, { id: "personal" });
    upsertChat(db, { accountId: "personal", jid: "a@s.whatsapp.net" });
    upsertChat(db, { accountId: "personal", jid: "b@s.whatsapp.net" });
    upsertMessage(db, {
      accountId: "personal",
      chatJid: "a@s.whatsapp.net",
      messageId: "A",
      timestamp: 1,
      text: "keep",
    });
    upsertMessage(db, {
      accountId: "personal",
      chatJid: "b@s.whatsapp.net",
      messageId: "B",
      timestamp: 2,
      text: "drop",
    });
    const rows = selectExportMessages(db, {
      accountId: "personal",
      blockedChats: ["b@s.whatsapp.net"],
    });
    expect(rows.map((r) => r.chat_jid)).toEqual(["a@s.whatsapp.net"]);
    db.close();
  });

  it("quotes the --config path in the offset commit hint", async () => {
    seed();
    await runExport({ configPath, sinceLast: "hermes", all: true });
    expect(stderr.join("")).toContain(`--config '${configPath}'`);
  });

  it("--redact-phone-numbers redacts sender JIDs", async () => {
    seed();
    await runExport({ configPath, redactPhoneNumbers: true });
    const recs = records();
    const dm = recs.find((r) => r.message_id === "A1");
    expect(dm?.sender_jid).toMatch(/^redacted-/);
    expect(JSON.stringify(recs)).not.toContain("49123@s.whatsapp.net");
  });

  it("rejects --redact-phone-numbers combined with --include-raw-json", async () => {
    seed();
    await expect(
      runExport({ configPath, redactPhoneNumbers: true, includeRawJson: true }),
    ).rejects.toThrow(/raw/i);
  });

  it("two-phase: --since-last does not advance offset without --commit", async () => {
    seed();
    const first = await runExport({
      configPath,
      sinceLast: "hermes",
      all: true,
    });
    expect(first.count).toBe(4);
    expect(first.committed).toBe(false);

    const config = loadConfig(configPath);
    const ro = openDb(config.paths.sqlite, { migrate: false, readonly: true });
    expect(getConsumerOffset(ro, "hermes")).toBeUndefined();
    ro.close();
  });

  it("--since-last --commit advances the offset and resumes after it", async () => {
    seed();
    const first = await runExport({
      configPath,
      sinceLast: "hermes",
      all: true,
      commit: true,
    });
    expect(first.count).toBe(4);
    expect(first.committed).toBe(true);

    stdout = [];
    const second = await runExport({
      configPath,
      sinceLast: "hermes",
      all: true,
      commit: true,
    });
    expect(second.count).toBe(0);
  });
});
