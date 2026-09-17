import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backfillSenderJids,
  runDbBackfillSender,
} from "../src/commands/db-backfill-sender.js";
import { runInit } from "../src/commands/init.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { getMessage, upsertAccount, upsertChat, upsertMessage } from "../src/db/queries.js";

const GROUP_JID = "120363179596188481@g.us";

function freshDb() {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "acct" });
  upsertChat(db, { accountId: "acct", jid: GROUP_JID, isGroup: true });
  upsertChat(db, { accountId: "acct", jid: "c@s.whatsapp.net" });
  return db;
}

function rawJsonWithRootParticipant(participant: string): string {
  return JSON.stringify({
    key: { remoteJid: GROUP_JID, id: "MSG-WITH-RAW", fromMe: false },
    participant,
    message: { conversation: "hello" },
  });
}

/** `fromMe` group message with no participant anywhere — on-demand history
 * carries these bare, unlike live delivery which sets `key.participant`. */
function rawJsonFromMeNoParticipant(messageId: string): string {
  return JSON.stringify({
    key: { remoteJid: GROUP_JID, id: messageId, fromMe: true },
    message: { conversation: "sent by me" },
  });
}

let dir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("backfillSenderJids", () => {
  it("resolves from raw_json, counts what it cannot, and leaves live rows alone", () => {
    const db = freshDb();

    // History row missing sender_jid, but raw_json carries a root participant.
    upsertMessage(db, {
      accountId: "acct",
      chatJid: GROUP_JID,
      messageId: "MSG-WITH-RAW",
      ingestionSource: "history",
      rawJson: rawJsonWithRootParticipant("33600000000@s.whatsapp.net"),
    });

    // History row missing both sender_jid and raw_json: unresolvable, not silently skipped.
    upsertMessage(db, {
      accountId: "acct",
      chatJid: GROUP_JID,
      messageId: "MSG-NO-RAW",
      ingestionSource: "history",
    });

    // Live row that already has a sender_jid: must stay untouched.
    upsertMessage(db, {
      accountId: "acct",
      chatJid: "c@s.whatsapp.net",
      messageId: "MSG-LIVE",
      senderJid: "c@s.whatsapp.net",
      ingestionSource: "live",
    });

    const counts = backfillSenderJids(db, "acct", false);
    expect(counts).toEqual({
      candidates: 2,
      updated: 1,
      unresolvable_no_raw_json: 1,
      unresolvable_no_participant: 0,
    });

    expect(getMessage(db, "acct", GROUP_JID, "MSG-WITH-RAW")?.sender_jid).toBe(
      "33600000000@s.whatsapp.net",
    );
    expect(getMessage(db, "acct", GROUP_JID, "MSG-NO-RAW")?.sender_jid).toBeNull();
    expect(getMessage(db, "acct", "c@s.whatsapp.net", "MSG-LIVE")?.sender_jid).toBe(
      "c@s.whatsapp.net",
    );

    db.close();
  });

  it("resolves a fromMe group history row with no participant to the account's self JID", () => {
    const db = freshDb();
    // freshDb's upsertAccount predates self_jid; re-set it on the same row.
    upsertAccount(db, { id: "acct", selfJid: "33744707085@s.whatsapp.net" });

    upsertMessage(db, {
      accountId: "acct",
      chatJid: GROUP_JID,
      messageId: "MSG-FROM-ME",
      ingestionSource: "history",
      rawJson: rawJsonFromMeNoParticipant("MSG-FROM-ME"),
    });

    const counts = backfillSenderJids(db, "acct", false);
    expect(counts).toEqual({
      candidates: 1,
      updated: 1,
      unresolvable_no_raw_json: 0,
      unresolvable_no_participant: 0,
    });
    expect(getMessage(db, "acct", GROUP_JID, "MSG-FROM-ME")?.sender_jid).toBe(
      "33744707085@s.whatsapp.net",
    );

    db.close();
  });

  it("counts a fromMe row as unresolvable_no_participant when the account has no self_jid", () => {
    const db = freshDb(); // upsertAccount(db, { id: "acct" }) — no selfJid

    upsertMessage(db, {
      accountId: "acct",
      chatJid: GROUP_JID,
      messageId: "MSG-FROM-ME",
      ingestionSource: "history",
      rawJson: rawJsonFromMeNoParticipant("MSG-FROM-ME"),
    });

    const counts = backfillSenderJids(db, "acct", false);
    expect(counts).toEqual({
      candidates: 1,
      updated: 0,
      unresolvable_no_raw_json: 0,
      unresolvable_no_participant: 1,
    });
    expect(getMessage(db, "acct", GROUP_JID, "MSG-FROM-ME")?.sender_jid).toBeNull();

    db.close();
  });

  it("--dry-run computes the same counts without writing", () => {
    const db = freshDb();
    upsertMessage(db, {
      accountId: "acct",
      chatJid: GROUP_JID,
      messageId: "MSG-WITH-RAW",
      ingestionSource: "history",
      rawJson: rawJsonWithRootParticipant("33600000000@s.whatsapp.net"),
    });

    const counts = backfillSenderJids(db, "acct", true);
    expect(counts.updated).toBe(1);
    expect(getMessage(db, "acct", GROUP_JID, "MSG-WITH-RAW")?.sender_jid).toBeNull();

    db.close();
  });
});

describe("runDbBackfillSender", () => {
  it("wires config/CLI plumbing and reports through the same shape", () => {
    dir = mkdtempSync(join(tmpdir(), "wac-db-backfill-sender-"));
    const configPath = join(dir, "config.yaml");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runInit({ configPath, dataDir: join(dir, "data") });
    const config = loadConfig(configPath);

    const db = openDb(config.paths.sqlite);
    upsertAccount(db, { id: config.account.name });
    upsertChat(db, { accountId: config.account.name, jid: GROUP_JID, isGroup: true });
    upsertMessage(db, {
      accountId: config.account.name,
      chatJid: GROUP_JID,
      messageId: "MSG-WITH-RAW",
      ingestionSource: "history",
      rawJson: rawJsonWithRootParticipant("33600000000@s.whatsapp.net"),
    });
    db.close();

    const report = runDbBackfillSender({ configPath, json: true });
    expect(report).toMatchObject({
      candidates: 1,
      updated: 1,
      unresolvable_no_raw_json: 0,
      unresolvable_no_participant: 0,
      dry_run: false,
    });

    const check = openDb(config.paths.sqlite, { migrate: false, readonly: true });
    expect(getMessage(check, config.account.name, GROUP_JID, "MSG-WITH-RAW")?.sender_jid).toBe(
      "33600000000@s.whatsapp.net",
    );
    check.close();
  });
});
