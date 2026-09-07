import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChatsList } from "../src/commands/chats.js";
import { runInit } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { upsertDirectoryContact } from "../src/db/directory.js";
import { openDb } from "../src/db/index.js";
import { upsertAccount, upsertChat } from "../src/db/queries.js";

let dir: string;
let configPath: string;
let output: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-chats-command-"));
  configPath = join(dir, "config.yaml");
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  runInit({ configPath, dataDir: join(dir, "data") });
  output = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("chats list", () => {
  it("uses the local directory name before chat and public names", () => {
    const config = loadConfig(configPath);
    const db = openDb(config.paths.sqlite);
    upsertAccount(db, { id: config.account.name });
    upsertChat(db, {
      accountId: config.account.name,
      jid: "491239@s.whatsapp.net",
      name: "Ancien nom de chat",
      pushName: "Nom public",
    });
    upsertDirectoryContact(db, {
      accountId: config.account.name,
      jid: "491239@s.whatsapp.net",
      displayName: "Nom local",
      verifiedName: "Entreprise vérifiée",
      pushName: "Nom public",
    });
    db.close();

    runChatsList({ configPath, json: true });

    const chats = JSON.parse(output.join("")) as Array<{ name: string }>;
    expect(chats[0]?.name).toBe("Nom local");
  });
});
