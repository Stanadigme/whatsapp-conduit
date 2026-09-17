import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { upsertDirectoryContact } from "../src/db/directory.js";
import {
  getHistoryJob,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import { registerWhatsmeowIngestion } from "../src/whatsmeow/ingest.js";
import {
  HistoryCoordinator,
  type HistoryCapableTransport,
} from "../src/history/coordinator.js";
import type {
  HistoryAnchor,
  ObserveTransport,
  TransportMessageEvent,
} from "../src/transport/types.js";

const ACCOUNT = "personal";
const CHAT = "33600000000@s.whatsapp.net";
const CHAT_LID = "900000000000@lid";
const GROUP_JID = "120363000000000@g.us";
const MEMBER_JID = "33600000001@s.whatsapp.net";

class FakeHistoryTransport extends EventEmitter {
  readonly requests: HistoryAnchor[] = [];

  async requestHistory(anchor: HistoryAnchor, _count: number): Promise<void> {
    this.requests.push(anchor);
    queueMicrotask(() => {
      this.emit("message", messageEvent("M90", 90));
      this.emit("message", messageEvent("M70", 70));
      this.emit("history_sync", { type: "ON_DEMAND" });
    });
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

function messageEvent(id: string, timestamp: number): TransportMessageEvent {
  return {
    info: {
      id,
      chat: CHAT,
      sender: CHAT,
      isFromMe: false,
      isGroup: false,
      timestamp,
      pushName: "Contact",
    },
    message: { conversation: id },
  };
}

function groupMessageEvent(
  id: string,
  timestamp: number,
): TransportMessageEvent {
  return {
    info: {
      id,
      chat: GROUP_JID,
      sender: MEMBER_JID,
      isFromMe: false,
      isGroup: true,
      timestamp,
      pushName: "Group Member",
    },
    message: { conversation: id },
  };
}

/** Requests a batch and reports completion via `history_sync` alone, never
 * emitting a `message` event — the shape of an empty on-demand batch. */
class FakeEmptyBatchTransport extends EventEmitter {
  readonly requests: HistoryAnchor[] = [];

  constructor(private readonly historySyncEvent: Record<string, unknown>) {
    super();
  }

  async requestHistory(anchor: HistoryAnchor, _count: number): Promise<void> {
    this.requests.push(anchor);
    queueMicrotask(() => {
      this.emit("history_sync", this.historySyncEvent);
    });
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeGroupHistoryTransport extends EventEmitter {
  readonly requests: HistoryAnchor[] = [];

  async requestHistory(anchor: HistoryAnchor, _count: number): Promise<void> {
    this.requests.push(anchor);
    queueMicrotask(() => {
      this.emit("message", groupMessageEvent("G90", 90));
      this.emit("message", groupMessageEvent("G70", 70));
      this.emit("history_sync", { type: "ON_DEMAND" });
    });
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe("history coordinator", () => {
  it("finishes without coverage when WhatsApp cannot be queried without a local anchor", async () => {
    const db = openDb(":memory:", { migrate: true });
    const transport = new FakeHistoryTransport();
    upsertAccount(db, { id: ACCOUNT, selfJid: CHAT });
    upsertChat(db, { accountId: ACCOUNT, jid: CHAT });
    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport: transport as unknown as HistoryCapableTransport,
      logger: pino({ level: "silent" }),
    });

    const started = await coordinator.start(CHAT, 80, 100);
    await waitFor(
      () => getHistoryJob(db, ACCOUNT, started.job.id)?.status === "completed",
    );

    expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
      status: "completed",
      coverage_complete: 0,
      completion_reason: "no_local_anchor",
      error_code: null,
    });
    expect(transport.requests).toHaveLength(0);
    db.close();
  });

  it("requests a bounded batch, persists only the requested window and completes", async () => {
    const db = openDb(":memory:", { migrate: true });
    const config = resolveConfig({}, { dataDir: "/data" });
    const transport = new FakeHistoryTransport();
    upsertAccount(db, { id: ACCOUNT, selfJid: CHAT });
    upsertChat(db, { accountId: ACCOUNT, jid: CHAT, name: "Allowed" });
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: CHAT,
      messageId: "M100",
      senderJid: CHAT,
      timestamp: 100,
      messageType: "text",
      text: "anchor",
    });

    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport: transport as unknown as HistoryCapableTransport,
      logger: pino({ level: "silent" }),
    });
    registerWhatsmeowIngestion(
      transport as unknown as ObserveTransport,
      {
        db,
        accountId: ACCOUNT,
        config,
        logger: pino({ level: "silent" }),
      },
      {
        classify: (event) => coordinator.classify(event),
        onStored: (event, stored, classification) =>
          coordinator.onStored(event, stored, classification),
      },
    );
    transport.emit("connected", { jid: CHAT });

    const started = await coordinator.start(CHAT, 80, 100);
    await waitFor(
      () => getHistoryJob(db, ACCOUNT, started.job.id)?.status === "completed",
    );

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ id: "M100", timestamp: 100 });
    expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
      status: "completed",
      coverage_complete: 1,
      batches_completed: 1,
      messages_received: 2,
      messages_inserted: 2,
      oldest_seen_ts: 70,
    });
    // ADR-0037 §1: M70 precedes sinceTs=80 but was delivered, so it is stored.
    expect(
      db
        .prepare(
          "select ingestion_source from messages where message_id = 'M70'",
        )
        .get(),
    ).toEqual({ ingestion_source: "history" });
    expect(
      db
        .prepare(
          "select ingestion_source from messages where message_id = 'M90'",
        )
        .get(),
    ).toEqual({ ingestion_source: "history" });
    db.close();
  });

  it("stores a batch entirely older than sinceTs instead of discarding it (ADR-0037 §1)", async () => {
    const db = openDb(":memory:", { migrate: true });
    const config = resolveConfig({}, { dataDir: "/data" });
    const transport = new FakeHistoryTransport();
    upsertAccount(db, { id: ACCOUNT, selfJid: CHAT });
    upsertChat(db, { accountId: ACCOUNT, jid: CHAT, name: "Allowed" });
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: CHAT,
      messageId: "M100",
      senderJid: CHAT,
      timestamp: 100,
      messageType: "text",
      text: "anchor",
    });

    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport: transport as unknown as HistoryCapableTransport,
      logger: pino({ level: "silent" }),
    });
    registerWhatsmeowIngestion(
      transport as unknown as ObserveTransport,
      {
        db,
        accountId: ACCOUNT,
        config,
        logger: pino({ level: "silent" }),
      },
      {
        classify: (event) => coordinator.classify(event),
        onStored: (event, stored, classification) =>
          coordinator.onStored(event, stored, classification),
      },
    );
    transport.emit("connected", { jid: CHAT });

    // sinceTs=95: both M90 and M70 (delivered by the batch) precede it. The
    // phone will not resend them once delivered, so both must be stored.
    const started = await coordinator.start(CHAT, 95, 100);
    await waitFor(
      () => getHistoryJob(db, ACCOUNT, started.job.id)?.status === "completed",
    );

    expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
      status: "completed",
      coverage_complete: 1,
      completion_reason: "boundary_reached",
      messages_received: 2,
      messages_inserted: 2,
    });
    expect(
      db
        .prepare(
          "select ingestion_source from messages where message_id = 'M90'",
        )
        .get(),
    ).toEqual({ ingestion_source: "history" });
    expect(
      db
        .prepare(
          "select ingestion_source from messages where message_id = 'M70'",
        )
        .get(),
    ).toEqual({ ingestion_source: "history" });
    db.close();
  });

  it("uses a caller-supplied anchor instead of consulting the local anchor table", async () => {
    const db = openDb(":memory:", { migrate: true });
    const config = resolveConfig({}, { dataDir: "/data" });
    const transport = new FakeHistoryTransport();
    upsertAccount(db, { id: ACCOUNT, selfJid: CHAT });
    upsertChat(db, { accountId: ACCOUNT, jid: CHAT, name: "Allowed" });
    // No upsertMessage: there is no local anchor row for getHistoryAnchor to
    // find. Without the explicit anchor, process() would stop at
    // "no_local_anchor" the way the first test in this file does.

    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport: transport as unknown as HistoryCapableTransport,
      logger: pino({ level: "silent" }),
    });
    registerWhatsmeowIngestion(
      transport as unknown as ObserveTransport,
      {
        db,
        accountId: ACCOUNT,
        config,
        logger: pino({ level: "silent" }),
      },
      {
        classify: (event) => coordinator.classify(event),
        onStored: (event, stored, classification) =>
          coordinator.onStored(event, stored, classification),
      },
    );
    transport.emit("connected", { jid: CHAT });

    const anchor = { sender: CHAT, id: "M100", timestamp: 100 };
    const started = await coordinator.start(CHAT, 80, 100, false, anchor);
    await waitFor(
      () => getHistoryJob(db, ACCOUNT, started.job.id)?.status === "completed",
    );

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ id: "M100", timestamp: 100 });
    expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
      status: "completed",
      coverage_complete: 1,
      anchor_sender_jid: CHAT,
      anchor_message_id: "M100",
      anchor_timestamp: 100,
    });
    db.close();
  });

  it("follows a direct chat across its LID and phone aliases", async () => {
    const db = openDb(":memory:", { migrate: true });
    const config = resolveConfig({}, { dataDir: "/data" });
    const transport = new FakeHistoryTransport();
    upsertAccount(db, { id: ACCOUNT, selfJid: MEMBER_JID });
    upsertChat(db, { accountId: ACCOUNT, jid: CHAT });
    upsertChat(db, { accountId: ACCOUNT, jid: CHAT_LID });
    upsertDirectoryContact(db, {
      accountId: ACCOUNT,
      jid: CHAT,
      lid: CHAT_LID,
    });
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: CHAT_LID,
      messageId: "M100",
      senderJid: CHAT_LID,
      timestamp: 100,
      messageType: "text",
    });

    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport: transport as unknown as HistoryCapableTransport,
      logger: pino({ level: "silent" }),
    });
    registerWhatsmeowIngestion(
      transport as unknown as ObserveTransport,
      {
        db,
        accountId: ACCOUNT,
        config,
        logger: pino({ level: "silent" }),
      },
      {
        classify: (event) => coordinator.classify(event),
        onStored: (event, stored, classification) =>
          coordinator.onStored(event, stored, classification),
      },
    );
    transport.emit("connected", { jid: MEMBER_JID });

    const started = await coordinator.start(CHAT_LID, 80, 100);
    await waitFor(
      () => getHistoryJob(db, ACCOUNT, started.job.id)?.status === "completed",
    );

    expect(transport.requests[0]).toMatchObject({
      chat: CHAT,
      timestamp: 100,
    });
    expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
      coverage_complete: 1,
      messages_received: 2,
      messages_inserted: 2,
    });
    db.close();
  });

  it("reuses the active account job instead of starting a second one", async () => {
    const db = openDb(":memory:", { migrate: true });
    const transport = new FakeHistoryTransport();
    upsertAccount(db, { id: ACCOUNT, selfJid: CHAT });
    upsertChat(db, { accountId: ACCOUNT, jid: CHAT });
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: CHAT,
      messageId: "M100",
      senderJid: CHAT,
      timestamp: 100,
      messageType: "text",
    });
    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport: transport as unknown as HistoryCapableTransport,
      logger: pino({ level: "silent" }),
    });
    const first = await coordinator.start(CHAT, 80, 100);
    const second = await coordinator.start(CHAT, 70, 100);
    expect(second).toMatchObject({ reused: true, job: { id: first.job.id } });
    db.close();
  });

  it("reports window_already_delivered when the phone flags an empty batch as already delivered", async () => {
    const db = openDb(":memory:", { migrate: true });
    const transport = new FakeEmptyBatchTransport({
      type: "ON_DEMAND",
      messageCount: 0,
      endOfHistoryTransferType: 2,
    });
    upsertAccount(db, { id: ACCOUNT, selfJid: CHAT });
    upsertChat(db, { accountId: ACCOUNT, jid: CHAT });
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: CHAT,
      messageId: "M100",
      senderJid: CHAT,
      timestamp: 100,
      messageType: "text",
      text: "anchor",
    });

    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport: transport as unknown as HistoryCapableTransport,
      logger: pino({ level: "silent" }),
    });
    transport.emit("connected", { jid: CHAT });

    const started = await coordinator.start(CHAT, 80, 100);
    await waitFor(
      () => getHistoryJob(db, ACCOUNT, started.job.id)?.status === "completed",
    );

    expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
      status: "completed",
      coverage_complete: 0,
      completion_reason: "window_already_delivered",
      messages_received: 0,
    });
    db.close();
  });

  it("still reports source_exhausted when the transport does not expose completion flags", async () => {
    const db = openDb(":memory:", { migrate: true });
    const transport = new FakeEmptyBatchTransport({ type: "ON_DEMAND" });
    upsertAccount(db, { id: ACCOUNT, selfJid: CHAT });
    upsertChat(db, { accountId: ACCOUNT, jid: CHAT });
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: CHAT,
      messageId: "M100",
      senderJid: CHAT,
      timestamp: 100,
      messageType: "text",
      text: "anchor",
    });

    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport: transport as unknown as HistoryCapableTransport,
      logger: pino({ level: "silent" }),
    });
    transport.emit("connected", { jid: CHAT });

    const started = await coordinator.start(CHAT, 80, 100);
    await waitFor(
      () => getHistoryJob(db, ACCOUNT, started.job.id)?.status === "completed",
    );

    expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
      status: "completed",
      coverage_complete: 0,
      completion_reason: "source_exhausted",
      messages_received: 0,
    });
    db.close();
  });

  it("handles group chats: classifies by group JID, stores only the requested window", async () => {
    const db = openDb(":memory:", { migrate: true });
    const config = resolveConfig(
      { privacy: { include_groups: true } },
      { dataDir: "/data" },
    );
    const transport = new FakeGroupHistoryTransport();
    upsertAccount(db, { id: ACCOUNT, selfJid: CHAT });
    upsertChat(db, {
      accountId: ACCOUNT,
      jid: GROUP_JID,
      name: "Test Group",
      isGroup: true,
    });
    // Anchor: oldest known message in the group (from a participant, not the group JID)
    upsertMessage(db, {
      accountId: ACCOUNT,
      chatJid: GROUP_JID,
      messageId: "G100",
      senderJid: MEMBER_JID,
      timestamp: 100,
      messageType: "text",
      text: "anchor",
    });

    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport: transport as unknown as HistoryCapableTransport,
      logger: pino({ level: "silent" }),
    });
    registerWhatsmeowIngestion(
      transport as unknown as ObserveTransport,
      { db, accountId: ACCOUNT, config, logger: pino({ level: "silent" }) },
      {
        classify: (event) => coordinator.classify(event),
        onStored: (event, stored, classification) =>
          coordinator.onStored(event, stored, classification),
      },
    );
    transport.emit("connected", { jid: CHAT });

    const started = await coordinator.start(GROUP_JID, 80, 100);
    await waitFor(
      () => getHistoryJob(db, ACCOUNT, started.job.id)?.status === "completed",
    );

    expect(transport.requests).toHaveLength(1);
    // Anchor uses the group JID as chat and participant JID as sender
    expect(transport.requests[0]).toMatchObject({
      chat: GROUP_JID,
      sender: MEMBER_JID,
      id: "G100",
      timestamp: 100,
    });
    expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
      status: "completed",
      coverage_complete: 1,
      batches_completed: 1,
      messages_received: 2,
      messages_inserted: 2,
      oldest_seen_ts: 70,
    });
    // ADR-0037 §1: G70 precedes sinceTs=80 but was delivered by the phone, so
    // it is stored — `since` only stops pagination, it never discards a row.
    expect(
      db
        .prepare(
          "select ingestion_source from messages where message_id = 'G70'",
        )
        .get(),
    ).toEqual({ ingestion_source: "history" });
    // G90 is inside the window, stored as history in the group chat
    expect(
      db
        .prepare(
          "select ingestion_source, chat_jid from messages where message_id = 'G90'",
        )
        .get(),
    ).toEqual({ ingestion_source: "history", chat_jid: GROUP_JID });
    db.close();
  });
});
