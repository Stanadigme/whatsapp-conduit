import { proto, type WASocket } from "baileys";
import { describe, expect, it, vi } from "vitest";
import { BaileysHistoryTransport } from "../src/baileys/history.js";
import { registerIngestion } from "../src/baileys/ingest.js";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { upsertDirectoryContact } from "../src/db/directory.js";
import {
  getHistoryJob,
  getMessage,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import { HistoryCoordinator } from "../src/history/coordinator.js";
import { createLogger } from "../src/util/logging.js";

const ACCOUNT = "personal";
const CHAT = "33600000001@s.whatsapp.net";
const CHAT_LID = "900000000001@lid";
const SELF = "33600000000@s.whatsapp.net";

describe("Baileys on-demand history adapter", () => {
  it("only uses Baileys' bounded history request and relays completion", async () => {
    const listeners = new Map<string, (event: never) => void>();
    const fetchMessageHistory = vi.fn().mockResolvedValue("request-id");
    const socket = {
      user: { id: "33600000000:1@s.whatsapp.net" },
      fetchMessageHistory,
      ev: {
        on: (event: string, listener: (value: never) => void) => {
          listeners.set(event, listener);
        },
      },
    } as unknown as WASocket;
    const transport = new BaileysHistoryTransport();
    const events: string[] = [];
    transport.on("history_sync", (event) => events.push(event.type));
    transport.attach(socket);

    await transport.requestHistory(
      {
        chat: "33600000001@s.whatsapp.net",
        sender: "33600000000@s.whatsapp.net",
        id: "M1",
        timestamp: 1_700_000_000,
      },
      50,
    );
    expect(fetchMessageHistory).toHaveBeenCalledWith(
      50,
      {
        remoteJid: "33600000001@s.whatsapp.net",
        fromMe: true,
        id: "M1",
      },
      1_700_000_000_000,
    );
    await transport.requestHistory({ chat: CHAT, fromMe: true, id: "M2", timestamp: 2 }, 10);
    expect(fetchMessageHistory).toHaveBeenLastCalledWith(10, { remoteJid: CHAT, fromMe: true, id: "M2" }, 2_000);
    listeners.get("messaging-history.status")?.({
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      status: "complete",
    } as never);
    expect(events).toEqual([]);
  });

  it("reports messageCount and matches endOfHistoryTransferType by JID, not by array index", async () => {
    const listeners = new Map<string, (event: never) => void>();
    const fetchMessageHistory = vi.fn().mockResolvedValue("request-id");
    const socket = {
      user: { id: "33600000000:1@s.whatsapp.net" },
      fetchMessageHistory,
      ev: {
        on: (event: string, listener: (value: never) => void) => {
          listeners.set(event, listener);
        },
      },
    } as unknown as WASocket;
    const transport = new BaileysHistoryTransport();
    const events: Array<{
      type: string;
      messageCount?: number;
      endOfHistoryTransferType?: number;
    }> = [];
    transport.on("history_sync", (event) => events.push(event));
    transport.attach(socket);

    await transport.requestHistory(
      { chat: CHAT, sender: SELF, id: "M1", timestamp: 1_700_000_000 },
      50,
    );
    // Requested chat's entry is second in the array on purpose: a by-index
    // match would pick CHAT_LID's flag (0) instead of CHAT's (2).
    listeners.get("messaging-history.set")?.({
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      peerDataRequestSessionId: "other-request",
      contacts: [],
      messages: [],
      chats: [{ id: CHAT, endOfHistoryTransferType: 0 }],
    } as never);
    expect(events).toEqual([]);
    listeners.get("messaging-history.set")?.({
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      peerDataRequestSessionId: "request-id",
      contacts: [],
      messages: [{ key: { remoteJid: CHAT, fromMe: false, id: "M2" } }],
      chats: [
        { id: CHAT_LID, endOfHistoryTransferType: 0 },
        { id: CHAT, endOfHistoryTransferType: 2 },
      ],
    } as never);

    expect(events).toEqual([
      { type: "ON_DEMAND", chatJid: CHAT, requestId: "request-id", messageCount: 1, endOfHistoryTransferType: 2 },
    ]);
  });

  it("ignores a batch for another chat even when it is the sole chats[] entry", async () => {
    const listeners = new Map<string, (event: never) => void>();
    const fetchMessageHistory = vi.fn().mockResolvedValue("request-id");
    const socket = {
      user: { id: "33600000000:1@s.whatsapp.net" },
      fetchMessageHistory,
      ev: {
        on: (event: string, listener: (value: never) => void) => {
          listeners.set(event, listener);
        },
      },
    } as unknown as WASocket;
    const transport = new BaileysHistoryTransport();
    const events: Array<{
      type: string;
      messageCount?: number;
      endOfHistoryTransferType?: number;
    }> = [];
    transport.on("history_sync", (event) => events.push(event));
    transport.attach(socket);

    await transport.requestHistory(
      { chat: CHAT, sender: SELF, id: "M1", timestamp: 1_700_000_000 },
      50,
    );
    listeners.get("messaging-history.set")?.({
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      contacts: [],
      messages: [],
      chats: [{ id: "unexpected@lid", endOfHistoryTransferType: 2 }],
    } as never);

    expect(events).toEqual([]);
  });

  it("launches and follows an on-demand job through Baileys history events", async () => {
    const listeners = new Map<string, Array<(event: never) => void>>();
    const emit = (event: string, value: unknown): void => {
      for (const listener of listeners.get(event) ?? []) {
        listener(value as never);
      }
    };
    const fetchMessageHistory = vi.fn(async () => {
      queueMicrotask(() =>
        emit("messaging-history.set", {
          chats: [],
          contacts: [],
          syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
          progress: 100,
          messages: [
            {
              key: { remoteJid: CHAT, fromMe: false, id: "M90" },
              messageTimestamp: 90,
              message: { conversation: "inside-window" },
            },
            {
              key: { remoteJid: CHAT, fromMe: false, id: "M70" },
              messageTimestamp: 70,
              message: { conversation: "before-window" },
            },
          ],
        }),
      );
      return "request-id";
    });
    const socket = {
      user: { id: `${SELF.split("@")[0]}:1@s.whatsapp.net` },
      fetchMessageHistory,
      ev: {
        on: (event: string, listener: (value: never) => void) => {
          const group = listeners.get(event) ?? [];
          group.push(listener);
          listeners.set(event, group);
        },
      },
    } as unknown as WASocket;
    const db = openDb(":memory:", { migrate: true });
    const config = resolveConfig(
      { filters: { allowed_chats: [CHAT_LID] } },
      { dataDir: "/data" },
    );
    const logger = createLogger({ level: "error" });
    upsertAccount(db, { id: ACCOUNT, selfJid: SELF });
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
      fromMe: false,
      timestamp: 100,
      messageType: "text",
    });

    const transport = new BaileysHistoryTransport();
    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport,
      logger,
    });
    transport.attach(socket);
    registerIngestion(
      socket,
      { db, accountId: ACCOUNT, config, logger },
      {
        classify: (message) =>
          coordinator.classifyMessage(
            message.key.remoteJid ?? "",
            Number(message.messageTimestamp),
          ),
        onStored: (message, stored, classification) =>
          coordinator.onStoredResult(stored, classification, message.key.remoteJid ?? undefined, message.key.id ?? undefined),
      },
    );
    transport.connected(SELF);

    const started = await coordinator.start(CHAT_LID, 80, 100);
    await vi.waitFor(() => {
      expect(getHistoryJob(db, ACCOUNT, started.job.id)?.status).toBe(
        "completed",
      );
    });

    expect(fetchMessageHistory).toHaveBeenCalledOnce();
    expect(fetchMessageHistory).toHaveBeenCalledWith(
      50,
      { remoteJid: CHAT, fromMe: false, id: "M100" },
      100_000,
    );
    expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
      messages_received: 2,
      // ADR-0037 §1: the phone delivered M70 even though it precedes `since`;
      // it is written, never discarded, since the phone will not resend it.
      messages_inserted: 2,
      coverage_complete: 0,
      completion_reason: "boundary_reached",
    });
    expect(getMessage(db, ACCOUNT, CHAT, "M90")?.ingestion_source).toBe(
      "history",
    );
    expect(getMessage(db, ACCOUNT, CHAT, "M70")?.ingestion_source).toBe(
      "history",
    );
    db.close();
  });

  it("does not fail a job in flight on an ingestion error from another chat or a live message", async () => {
    const listeners = new Map<string, Array<(event: never) => void>>();
    const emit = (event: string, value: unknown): void => {
      for (const listener of listeners.get(event) ?? []) listener(value as never);
    };
    let resolveFetch: ((requestId: string) => void) | undefined;
    // Pending until resolved: keeps the batch "in flight" while we probe
    // onStorageError with contexts that must not belong to it.
    const fetchMessageHistory = vi.fn(
      () => new Promise<string>((resolve) => { resolveFetch = resolve; }),
    );
    const socket = {
      user: { id: `${SELF.split("@")[0]}:1@s.whatsapp.net` },
      fetchMessageHistory,
      ev: {
        on: (event: string, listener: (value: never) => void) => {
          const group = listeners.get(event) ?? [];
          group.push(listener);
          listeners.set(event, group);
        },
      },
    } as unknown as WASocket;
    const db = openDb(":memory:", { migrate: true });
    const logger = createLogger({ level: "error" });
    upsertAccount(db, { id: ACCOUNT, selfJid: SELF });
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
      fromMe: false,
      timestamp: 100,
      messageType: "text",
    });

    const transport = new BaileysHistoryTransport();
    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport,
      logger,
    });
    transport.attach(socket);
    transport.connected(SELF);

    const started = await coordinator.start(CHAT_LID, 80, 100);
    await vi.waitFor(() => expect(fetchMessageHistory).toHaveBeenCalledOnce());

    // Neither belongs to the batch in flight: an unrelated chat's history
    // error, and a live message on the job's own chat.
    coordinator.onStorageError({
      chatJid: "99999999@s.whatsapp.net",
      source: "history",
    });
    coordinator.onStorageError({ chatJid: CHAT, source: "live" });

    resolveFetch?.("request-id");
    emit("messaging-history.set", {
      chats: [],
      contacts: [],
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      messages: [
        {
          key: { remoteJid: CHAT, fromMe: false, id: "M90" },
          messageTimestamp: 90,
          message: { conversation: "inside-window" },
        },
      ],
    } as never);

    await vi.waitFor(() => {
      expect(getHistoryJob(db, ACCOUNT, started.job.id)?.status).toBe(
        "completed",
      );
    });
    db.close();
  });

  it("still fails the job on a real storage error inside the batch in flight", async () => {
    const fetchMessageHistory = vi.fn(
      () => new Promise<string>(() => {
        // Never resolves: only the storage error below should settle the batch.
      }),
    );
    const socket = {
      user: { id: `${SELF.split("@")[0]}:1@s.whatsapp.net` },
      fetchMessageHistory,
      ev: { on: () => undefined },
    } as unknown as WASocket;
    const db = openDb(":memory:", { migrate: true });
    const logger = createLogger({ level: "error" });
    upsertAccount(db, { id: ACCOUNT, selfJid: SELF });
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
      fromMe: false,
      timestamp: 100,
      messageType: "text",
    });

    const transport = new BaileysHistoryTransport();
    const coordinator = new HistoryCoordinator({
      db,
      accountId: ACCOUNT,
      transport,
      logger,
    });
    transport.attach(socket);
    transport.connected(SELF);

    const started = await coordinator.start(CHAT_LID, 80, 100);
    await vi.waitFor(() => expect(fetchMessageHistory).toHaveBeenCalledOnce());

    // Same chat as the job (via its LID alias), source "history": a genuine
    // storage failure for the batch in flight must still fail the job.
    coordinator.onStorageError({ chatJid: CHAT_LID, source: "history" });

    await vi.waitFor(() => {
      expect(getHistoryJob(db, ACCOUNT, started.job.id)).toMatchObject({
        status: "failed",
        error_code: "history_storage_failed",
      });
    });
    db.close();
  });
});
