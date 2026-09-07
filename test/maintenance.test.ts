import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertDirectoryContact } from "../src/db/directory.js";
import { openDb } from "../src/db/index.js";
import {
  completeMaintenanceOperation,
  getMaintenanceOperation,
  maintenanceState,
  recoverInterruptedMaintenanceOperations,
  runMaintenanceOperation,
  startMaintenanceOperation,
} from "../src/db/maintenance.js";
import {
  upsertAccount,
  upsertChat,
  upsertMessage,
  upsertParticipant,
  setChatAllowed,
} from "../src/db/queries.js";

const accountId = "acct";
const chatJid = "491234@s.whatsapp.net";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "wac-maintenance-"));
  temporaryDirectories.push(directory);
  const mediaDir = join(directory, "media");
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: accountId });
  upsertChat(db, {
    accountId,
    jid: chatJid,
    name: "Ancien nom",
    pushName: "Ancien push",
    lastMessageTs: 200,
  });
  setChatAllowed(db, accountId, chatJid, true);
  upsertParticipant(db, {
    accountId,
    jid: chatJid,
    lid: "opaque@lid",
    displayName: "Ancien nom",
    pushName: "Ancien push",
    verifiedName: "Ancien vérifié",
  });
  upsertDirectoryContact(db, {
    accountId,
    jid: chatJid,
    lid: "opaque@lid",
    displayName: "Ancien nom",
  });
  return { db, mediaDir };
}

async function reset(
  db: ReturnType<typeof openDb>,
  mediaDir: string,
  scope:
    | "directory"
    | "live_messages"
    | "history"
    | "transcriptions"
    | "media"
    | "audit"
    | "all",
) {
  const operation = startMaintenanceOperation(db, accountId, scope);
  return runMaintenanceOperation({
    db,
    accountId,
    scope,
    mediaDir,
    operationId: operation.id,
  });
}

describe("maintenance resets", () => {
  it("marks an interrupted operation as failed so a retry is explicit", () => {
    const { db } = setup();
    const operation = startMaintenanceOperation(db, accountId, "audit");

    expect(recoverInterruptedMaintenanceOperations(db, accountId)).toBe(1);
    expect(getMaintenanceOperation(db, accountId, operation.id)).toMatchObject({
      status: "failed",
      error_code: "interrupted",
    });
    expect(() =>
      startMaintenanceOperation(db, accountId, "audit"),
    ).not.toThrow();
    db.close();
  });

  it("keeps a coupled directory rebuild exclusive until its caller completes it", async () => {
    const { db, mediaDir } = setup();
    const operation = startMaintenanceOperation(db, accountId, "directory");

    await runMaintenanceOperation({
      db,
      accountId,
      scope: "directory",
      mediaDir,
      operationId: operation.id,
      deferCompletion: true,
    });

    expect(getMaintenanceOperation(db, accountId, operation.id)?.status).toBe(
      "running",
    );
    expect(() => startMaintenanceOperation(db, accountId, "audit")).toThrow(
      "already active",
    );
    completeMaintenanceOperation(db, accountId, operation.id);
    expect(getMaintenanceOperation(db, accountId, operation.id)?.status).toBe(
      "completed",
    );
    db.close();
  });

  it("clears directory projections but retains the chat policy and identities", async () => {
    const { db, mediaDir } = setup();

    await reset(db, mediaDir, "directory");

    expect(
      db
        .prepare(
          "select name, push_name, is_allowed, is_blocked from chats where account_id = ? and jid = ?",
        )
        .get(accountId, chatJid),
    ).toEqual({ name: null, push_name: null, is_allowed: 1, is_blocked: 0 });
    expect(
      db
        .prepare(
          "select lid, display_name, push_name, verified_name from participants where account_id = ? and jid = ?",
        )
        .get(accountId, chatJid),
    ).toEqual({
      lid: null,
      display_name: null,
      push_name: null,
      verified_name: null,
    });
    expect(
      db
        .prepare(
          "select count(*) as count from directory_entities where account_id = ?",
        )
        .get(accountId),
    ).toEqual({ count: 0 });
    expect(maintenanceState(db, accountId)).toMatchObject({
      directoryRebuildRequired: true,
      active: false,
    });
    db.close();
  });

  it("removes live message dependants and recomputes the remaining chat recency", async () => {
    const { db, mediaDir } = setup();
    upsertMessage(db, {
      accountId,
      chatJid,
      messageId: "LIVE",
      timestamp: 200,
      messageType: "audio",
      hasMedia: true,
      ingestionSource: "live",
    });
    upsertMessage(db, {
      accountId,
      chatJid,
      messageId: "HISTORY",
      timestamp: 100,
      ingestionSource: "history",
    });
    db.prepare(
      `insert into attachments (account_id, chat_jid, message_id, media_type)
       values (?, ?, 'LIVE', 'audio')`,
    ).run(accountId, chatJid);
    db.prepare(
      `insert into transcriptions
         (account_id, chat_jid, message_id, text_raw, engine, transcribed_at)
       values (?, ?, 'LIVE', 'private output', 'test', 1)`,
    ).run(accountId, chatJid);
    db.prepare(
      `insert into transcription_jobs
         (account_id, chat_jid, message_id, status, attempts, target_lexicon_version, created_at, updated_at)
       values (?, ?, 'LIVE', 'done', 1, 0, 1, 1)`,
    ).run(accountId, chatJid);

    await reset(db, mediaDir, "live_messages");

    expect(
      db.prepare("select message_id from messages order by message_id").all(),
    ).toEqual([{ message_id: "HISTORY" }]);
    expect(
      db.prepare("select count(*) as count from attachments").get(),
    ).toEqual({ count: 0 });
    expect(
      db.prepare("select count(*) as count from transcriptions").get(),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          "select last_message_ts from chats where account_id = ? and jid = ?",
        )
        .get(accountId, chatJid),
    ).toEqual({ last_message_ts: 100 });
    db.close();
  });

  it("never follows an attachment path outside the configured media directory", async () => {
    const { db, mediaDir } = setup();
    const outside = join(tmpdir(), `wac-maintenance-outside-${Date.now()}`);
    writeFileSync(outside, "private media");
    upsertMessage(db, {
      accountId,
      chatJid,
      messageId: "MEDIA",
      hasMedia: true,
    });
    db.prepare(
      `insert into attachments (account_id, chat_jid, message_id, file_path)
       values (?, ?, 'MEDIA', ?)`,
    ).run(accountId, chatJid, outside);
    const operation = startMaintenanceOperation(db, accountId, "media");

    await expect(
      runMaintenanceOperation({
        db,
        accountId,
        scope: "media",
        mediaDir,
        operationId: operation.id,
      }),
    ).rejects.toThrow("outside");

    expect(existsSync(outside)).toBe(true);
    expect(
      db.prepare("select count(*) as count from attachments").get(),
    ).toEqual({ count: 1 });
    expect(getMaintenanceOperation(db, accountId, operation.id)?.status).toBe(
      "failed",
    );
    rmSync(outside, { force: true });
    db.close();
  });

  it("removes all local content while preserving allow/block policy and auth-independent account metadata", async () => {
    const { db, mediaDir } = setup();
    const file = join(mediaDir, "voice.ogg");
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(file, "audio");
    upsertMessage(db, {
      accountId,
      chatJid,
      messageId: "ALL",
      timestamp: 50,
      hasMedia: true,
    });
    db.prepare(
      `insert into attachments (account_id, chat_jid, message_id, file_path)
       values (?, ?, 'ALL', ?)`,
    ).run(accountId, chatJid, file);
    db.prepare(
      "insert into events (account_id, event_type, ingested_at, raw_json) values (?, 'event', 1, '{}')",
    ).run(accountId);
    db.prepare(
      "insert into consumer_offsets (consumer_name, updated_at) values ('consumer', 1)",
    ).run();

    await reset(db, mediaDir, "all");

    expect(existsSync(file)).toBe(false);
    expect(db.prepare("select count(*) as count from messages").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("select count(*) as count from events").get()).toEqual({
      count: 0,
    });
    expect(
      db.prepare("select count(*) as count from consumer_offsets").get(),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          "select is_allowed, is_blocked from chats where account_id = ? and jid = ?",
        )
        .get(accountId, chatJid),
    ).toEqual({ is_allowed: 1, is_blocked: 0 });
    expect(
      db.prepare("select id from accounts where id = ?").get(accountId),
    ).toEqual({ id: accountId });
    db.close();
  });
});
