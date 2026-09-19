import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proto, type WASocket } from "baileys";
import type { ConnectionDeps } from "../src/baileys/connect.js";
import { requestPairingCode, runLink } from "../src/commands/link.js";
import { runInit } from "../src/commands/init.js";
import { buildStatusReport } from "../src/commands/status.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import {
  countMessages,
  getChat,
  getMessage,
  setChatAllowed,
  upsertAccount,
  upsertChat,
  upsertMessage,
} from "../src/db/queries.js";
import {
  getDirectoryEntityByJid,
  upsertDirectoryContact,
} from "../src/db/directory.js";
import { prepareBaileysRelink } from "../src/baileys/relink.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-link-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("pairing-code readiness", () => {
  it("preserves existing messages, names, aliases and permissions through a relink", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });
    const config = loadConfig(configPath);
    const chatJid = "491234@s.whatsapp.net";
    const lid = "opaque@lid";
    const db = openDb(config.paths.sqlite, { migrate: true });
    upsertAccount(db, {
      id: config.account.name,
      selfJid: "49123@s.whatsapp.net",
    });
    upsertChat(db, {
      accountId: config.account.name,
      jid: chatJid,
      name: "Nom conservé",
    });
    setChatAllowed(db, config.account.name, chatJid, true);
    upsertDirectoryContact(db, {
      accountId: config.account.name,
      jid: chatJid,
      lid,
      displayName: "Nom conservé",
    });
    upsertMessage(db, {
      accountId: config.account.name,
      chatJid,
      messageId: "OLD",
      timestamp: 1700,
      text: "ancien",
    });
    db.close();

    writeFileSync(join(config.paths.authDir, "old-marker"), "former-session");
    expect(prepareBaileysRelink(config.paths.authDir)).not.toBeNull();
    const listeners = new Map<string, (value: unknown) => void>();
    const socket = {
      ev: {
        on: (event: string, listener: (value: unknown) => void) =>
          listeners.set(event, listener),
      },
    } as unknown as WASocket;
    await runLink(
      { configPath, qr: true },
      {
        connectionFactory: ({ handlers }) => ({
          async start(): Promise<void> {
            handlers.registerSocket?.(socket);
            listeners.get("messaging-history.set")?.({
              syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
              chats: [{ id: chatJid }],
              contacts: [],
              messages: [
                {
                  key: { remoteJid: chatJid, id: "OLD" },
                  messageTimestamp: 1700,
                  message: { conversation: "ancien" },
                },
                {
                  key: { remoteJid: chatJid, id: "NEW" },
                  messageTimestamp: 1800,
                  message: { conversation: "nouveau" },
                },
              ],
            });
            handlers.onOpen?.({ selfJid: "49123@s.whatsapp.net" });
            handlers.onCredsUpdate?.({ myAppStateKeyId: "app-state-key" });
          },
          stop(): void {},
        }),
      },
    );

    const after = openDb(config.paths.sqlite);
    expect(countMessages(after, config.account.name)).toBe(2);
    expect(getMessage(after, config.account.name, chatJid, "OLD")?.text).toBe(
      "ancien",
    );
    expect(
      getMessage(after, config.account.name, chatJid, "NEW")?.ingestion_source,
    ).toBe("history");
    expect(getChat(after, config.account.name, chatJid)).toMatchObject({
      name: "Nom conservé",
      is_allowed: 1,
      is_blocked: 0,
    });
    expect(
      getDirectoryEntityByJid(after, config.account.name, lid),
    ).toMatchObject({
      canonical_jid: chatJid,
      display_name: "Nom conservé",
    });
    after.close();
  });

  it("ingests the initial batch before credentials are ready and preserves its metadata", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });
    const listeners = new Map<string, (value: unknown) => void>();
    const socket = {
      ev: {
        on: (event: string, listener: (value: unknown) => void) =>
          listeners.set(event, listener),
      },
    } as unknown as WASocket;
    let stopped = false;
    const connectionFactory = ({ handlers }: ConnectionDeps) => ({
      async start(): Promise<void> {
        handlers.registerSocket?.(socket);
        listeners.get("messaging-history.set")?.({
          syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
          chats: [{ id: "c@s.whatsapp.net", name: "Pairing name" }],
          contacts: [],
          messages: [
            {
              key: { remoteJid: "c@s.whatsapp.net", id: "BEFORE" },
              messageTimestamp: 1700,
              message: { conversation: "before" },
            },
          ],
        });
        handlers.onOpen?.({ selfJid: "49123@s.whatsapp.net" });
        handlers.onCredsUpdate?.({ myAppStateKeyId: "app-state-key" });
      },
      stop(): void {
        stopped = true;
      },
    });

    await runLink({ configPath, qr: true }, { connectionFactory });
    const db = openDb(loadConfig(configPath).paths.sqlite);
    expect(
      getMessage(db, "personal", "c@s.whatsapp.net", "BEFORE")
        ?.ingestion_source,
    ).toBe("history");
    expect(getChat(db, "personal", "c@s.whatsapp.net")?.name).toBe(
      "Pairing name",
    );
    expect(stopped).toBe(true);
    db.close();
  });

  it("writes a headless QR without retaining it after a successful link", async () => {
    const configPath = join(dir, "config.yaml");
    const dataDir = join(dir, "data");
    const qrOut = join(dataDir, "pairing-qr.svg");
    runInit({ configPath, dataDir });
    let opened: (() => void) | undefined;
    let appStateKeySaved: (() => void) | undefined;
    const connectionFactory = ({ handlers }: ConnectionDeps) => ({
      async start(): Promise<void> {
        handlers.onQr?.("opaque-qr-payload");
        opened = () => handlers.onOpen?.({ selfJid: "49123@s.whatsapp.net" });
        appStateKeySaved = () =>
          handlers.onCredsUpdate?.({ myAppStateKeyId: "app-state-key" });
      },
      stop(): void {},
    });

    const linking = runLink(
      { configPath, qr: true, qrOut },
      { connectionFactory },
    );
    await vi.waitFor(() => expect(existsSync(qrOut)).toBe(true));
    expect(process.stdout.write).toHaveBeenCalledWith(
      `QR code written to ${qrOut}\n`,
    );

    opened?.();
    // Opening the websocket proves the QR was scanned, but the app-state key
    // can arrive shortly afterwards. The QR must remain unavailable only once
    // this credential has been persisted.
    expect(existsSync(qrOut)).toBe(true);
    appStateKeySaved?.();
    await expect(linking).resolves.toEqual(
      expect.objectContaining({ selfJid: "49123@s.whatsapp.net" }),
    );
    expect(existsSync(qrOut)).toBe(false);
  });

  it("does not declare a scanned QR successful before the app-state key is saved", async () => {
    const configPath = join(dir, "config.yaml");
    const dataDir = join(dir, "data");
    const qrOut = join(dataDir, "pairing-qr.svg");
    runInit({ configPath, dataDir });
    const connectionFactory = ({ handlers }: ConnectionDeps) => ({
      async start(): Promise<void> {
        handlers.onQr?.("opaque-qr-payload");
        handlers.onOpen?.({ selfJid: "49123@s.whatsapp.net" });
      },
      stop(): void {},
    });

    await expect(
      runLink(
        { configPath, qr: true, qrOut, timeoutSec: 0.01 },
        { connectionFactory },
      ),
    ).rejects.toThrow("timed out");
    expect(existsSync(qrOut)).toBe(false);
  });

  it("waits for the WebSocket before requesting a code", async () => {
    let releaseReady!: () => void;
    const waitForSocketOpen = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReady = resolve;
        }),
    );
    const requestPairingCodeMock = vi.fn().mockResolvedValue("ABCD1234");
    const socket = {
      waitForSocketOpen,
      requestPairingCode: requestPairingCodeMock,
    };

    const result = requestPairingCode(socket, "49123456789");
    await Promise.resolve();

    expect(waitForSocketOpen).toHaveBeenCalledOnce();
    expect(requestPairingCodeMock).not.toHaveBeenCalled();

    releaseReady();
    await expect(result).resolves.toBe("ABCD1234");
    expect(requestPairingCodeMock).toHaveBeenCalledWith("49123456789");
  });

  it("does not request a code when the socket readiness wait fails", async () => {
    const requestPairingCodeMock = vi.fn();
    const socket = {
      waitForSocketOpen: vi.fn().mockRejectedValue(new Error("closed")),
      requestPairingCode: requestPairingCodeMock,
    };

    await expect(requestPairingCode(socket, "49123456789")).rejects.toThrow(
      "closed",
    );
    expect(requestPairingCodeMock).not.toHaveBeenCalled();
  });

  it("starts pairing only after Baileys emits the post-handshake QR event", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });

    const requestPairingCodeMock = vi.fn().mockResolvedValue("ABCD1234");
    const socket = {
      waitForSocketOpen: vi.fn(async () => undefined),
      requestPairingCode: requestPairingCodeMock,
    } as unknown as WASocket;

    const connectionFactory = ({ handlers }: ConnectionDeps) => ({
      async start(): Promise<void> {
        handlers.onSocket?.(socket);
        handlers.onConnecting?.();
        expect(requestPairingCodeMock).not.toHaveBeenCalled();
        handlers.onQr?.("opaque-qr-payload");
        await Promise.resolve();
        handlers.onOpen?.({ selfJid: "49123@s.whatsapp.net" });
        handlers.onCredsUpdate?.({ myAppStateKeyId: "app-state-key" });
      },
      stop(): void {},
    });

    await runLink(
      { configPath, phoneNumber: "49123456789" },
      { connectionFactory },
    );

    expect(requestPairingCodeMock).toHaveBeenCalledWith("49123456789");
  });

  it("cleans auth state when pairing fails after the readiness event", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });

    const requestPairingCodeMock = vi
      .fn()
      .mockRejectedValue({ output: { statusCode: 428 } });
    const socket = {
      waitForSocketOpen: vi.fn(async () => undefined),
      requestPairingCode: requestPairingCodeMock,
    } as unknown as WASocket;

    const connectionFactory = ({ handlers }: ConnectionDeps) => ({
      async start(): Promise<void> {
        handlers.onSocket?.(socket);
        handlers.onQr?.("opaque-qr-payload");
        await Promise.resolve();
      },
      stop(): void {},
    });

    await expect(
      runLink(
        { configPath, phoneNumber: "49123456789" },
        { connectionFactory },
      ),
    ).rejects.toThrow("status 428");
    expect(buildStatusReport(configPath).authLinked).toBe(false);
  });
});

describe("Baileys link session lock", () => {
  it("refuses to link while the ingestion daemon holds the auth directory", async () => {
    const configPath = join(dir, "config.yaml");
    runInit({ configPath, dataDir: join(dir, "data") });
    const { paths } = (await import("../src/config.js")).loadConfig(configPath);
    writeFileSync(
      `${paths.authDir}.lock`,
      `${JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt: 1,
      })}\n`,
    );

    await expect(runLink({ configPath, qr: true })).rejects.toThrow(
      /Baileys.*auth|auth state/i,
    );
  });
});
