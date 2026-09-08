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
    listeners.get("messaging-history.status")?.({
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      status: "complete",
    } as never);
    expect(events).toEqual(["ON_DEMAND"]);
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
        onStored: (_message, stored, classification) =>
          coordinator.onStoredResult(stored, classification),
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
      messages_inserted: 1,
      coverage_complete: 1,
    });
    expect(getMessage(db, ACCOUNT, CHAT, "M90")?.ingestion_source).toBe(
      "history",
    );
    expect(getMessage(db, ACCOUNT, CHAT, "M70")).toBeUndefined();
    db.close();
  });
});
