import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runMessagesList } from "../src/commands/messages.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  setChatAllowed,
  setChatBlocked,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";

let dir: string;
let configPath: string;
let output: string[];
let errors: string[];

const ALLOWED = "33600000001@s.whatsapp.net";
const HIDDEN = "33600000002@s.whatsapp.net";
const BLOCKED = "33600000003@s.whatsapp.net";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-messages-command-"));
  configPath = join(dir, "config.yaml");
  output = [];
  errors = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  runInit({ configPath, dataDir: join(dir, "data") });
  output = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  const config = loadConfig(configPath);
  const db = openDb(config.paths.sqlite);
  const accountId = config.account.name;
  upsertAccount(db, { id: accountId });
  for (const [jid, label] of [
    [ALLOWED, "allowed"],
    [HIDDEN, "hidden"],
    [BLOCKED, "blocked"],
  ] as const) {
    upsertChat(db, { accountId, jid });
    upsertMessage(db, {
      accountId,
      chatJid: jid,
      messageId: `M-${label}`,
      senderJid: jid,
      timestamp: 1_700_000_000,
      messageType: "text",
      text: `secret ${label} content`,
    });
  }
  setChatAllowed(db, accountId, ALLOWED, true);
  setChatAllowed(db, accountId, BLOCKED, true);
  setChatBlocked(db, accountId, BLOCKED, true);
  db.close();
}

describe("messages list", () => {
  it("only prints messages from allowed conversations", () => {
    seed();
    runMessagesList({ configPath });
    const printed = output.join("");

    expect(printed).toContain("secret allowed content");
    // The allowlist is how the account holder keeps personal conversations out
    // of the processing scope. A terminal inspection must not undo that.
    expect(printed).not.toContain("secret hidden content");
    expect(printed).not.toContain("secret blocked content");
    expect(printed).not.toContain(HIDDEN);
    expect(printed).not.toContain(BLOCKED);
  });

  it("refuses an explicit chat that is not allowed", () => {
    seed();
    runMessagesList({ configPath, chat: HIDDEN });

    expect(output.join("")).not.toContain("secret hidden content");
    expect(errors.join("")).toContain("chat is not available");
    expect(process.exitCode).toBe(1);
  });

  it("emits allowed messages only in JSON mode", () => {
    seed();
    runMessagesList({ configPath, json: true });
    const parsed = JSON.parse(output.join("")) as Array<{ chatJid: string }>;

    expect(parsed.map((row) => row.chatJid)).toEqual([ALLOWED]);
  });
});
