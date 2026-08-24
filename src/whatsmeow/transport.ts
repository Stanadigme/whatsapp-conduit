import { EventEmitter } from "node:events";
import {
  createClient,
  type ClientOptions,
  type GroupInfo,
  type UserInfo,
  type WhatsmeowClient,
} from "@whatsmeow-node/whatsmeow-node";
import type { WhatsmeowConfig } from "../config.js";
import type {
  DirectoryReadTransport,
  ObserveTransport,
  TransportConnectedEvent,
  TransportGroupInfoEvent,
  TransportGroupJoinedEvent,
  TransportMessageEvent,
  HistoryAnchor,
  HistoryTransport,
  TransportHistorySyncEvent,
} from "../transport/types.js";

export interface WhatsmeowTransportOptions {
  store: string;
  config: WhatsmeowConfig;
}

/**
 * Observe-only Node adapter for the whatsmeow Go client.
 *
 * Deliberately exposes only connection, inbound-message and directory metadata
 * events. The sole protocol-level exception is requestHistory, which asks the
 * user's primary device for older messages and never sends a user-visible
 * message.
 */
export class WhatsmeowTransport
  extends EventEmitter
  implements ObserveTransport, DirectoryReadTransport, HistoryTransport
{
  private readonly client: WhatsmeowClient;
  private initialized = false;
  private started = false;

  constructor(options: WhatsmeowTransportOptions) {
    super();
    const clientOptions: ClientOptions = {
      store: options.store,
      commandTimeout: options.config.commandTimeoutMs,
    };
    if (options.config.binaryPath !== undefined) {
      clientOptions.binaryPath = options.config.binaryPath;
    }
    this.client = createClient(clientOptions);
    this.client.on("connected", (data) =>
      this.emit("connected", data as TransportConnectedEvent),
    );
    this.client.on("disconnected", () => this.emit("disconnected"));
    this.client.on("message", (data) =>
      this.emit("message", data as TransportMessageEvent),
    );
    this.client.on("history_sync", (data) =>
      this.emit("history_sync", data as TransportHistorySyncEvent),
    );
    this.client.on("group:info", (data) =>
      this.emit("group:info", data as TransportGroupInfoEvent),
    );
    this.client.on("group:joined", (data) =>
      this.emit("group:joined", data as TransportGroupJoinedEvent),
    );
    this.client.on("error", (error) => this.emit("error", error));
  }

  override on(
    event: "connected",
    listener: (data: TransportConnectedEvent) => void,
  ): this;
  override on(event: "disconnected", listener: () => void): this;
  override on(
    event: "message",
    listener: (data: TransportMessageEvent) => void,
  ): this;
  override on(
    event: "history_sync",
    listener: (data: TransportHistorySyncEvent) => void,
  ): this;
  override on(
    event: "group:info",
    listener: (data: TransportGroupInfoEvent) => void,
  ): this;
  override on(
    event: "group:joined",
    listener: (data: TransportGroupJoinedEvent) => void,
  ): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as never);
  }

  async start(): Promise<void> {
    if (this.started) return;
    const result = await this.client.init();
    this.initialized = true;
    if (!result.jid) {
      throw new Error("No paired whatsmeow session found; run link first.");
    }
    this.started = true;
    await this.client.connect();
  }

  async stop(): Promise<void> {
    if (!this.initialized) return;
    this.started = false;
    await this.client.disconnect().catch(() => undefined);
    this.client.close();
  }

  /** Read-only directory metadata operations. */
  async getJoinedGroups(): Promise<GroupInfo[]> {
    if (!this.started) throw new Error("whatsmeow transport is not started");
    return this.client.getJoinedGroups();
  }

  async getGroupInfo(jid: string): Promise<GroupInfo> {
    if (!this.started) throw new Error("whatsmeow transport is not started");
    return this.client.getGroupInfo(jid);
  }

  async getUserInfo(jids: string[]): Promise<Record<string, UserInfo>> {
    if (!this.started) throw new Error("whatsmeow transport is not started");
    return this.client.getUserInfo(jids);
  }

  /** Download a media payload only for the explicit local media worker. */
  async downloadAny(message: Record<string, unknown>): Promise<string> {
    if (!this.started) throw new Error("whatsmeow transport is not started");
    return this.client.downloadAny(message);
  }

  /** Request one bounded batch of older messages from the primary device. */
  async requestHistory(anchor: HistoryAnchor, count: number): Promise<void> {
    if (!this.started) throw new Error("whatsmeow transport is not started");
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new Error("history batch count must be between 1 and 50");
    }
    const request = await this.client.buildHistorySyncRequest(anchor, count);
    await this.client.sendPeerMessage(request);
  }

  /** Prepare an explicit interactive QR pairing session for the link command. */
  async startPairing(onQr: (code: string) => void): Promise<void> {
    if (this.started) return;
    this.client.on("qr", ({ code }) => onQr(code));
    const result = await this.client.init();
    this.initialized = true;
    if (result.jid) {
      throw new Error(`Whatsmeow store is already paired as ${result.jid}.`);
    }
    await this.client.getQRChannel();
    this.started = true;
    await this.client.connect();
  }

  override emit(event: "connected", data: TransportConnectedEvent): boolean;
  override emit(event: "disconnected"): boolean;
  override emit(event: "message", data: TransportMessageEvent): boolean;
  override emit(
    event: "history_sync",
    data: TransportHistorySyncEvent,
  ): boolean;
  override emit(event: "group:info", data: TransportGroupInfoEvent): boolean;
  override emit(
    event: "group:joined",
    data: TransportGroupJoinedEvent,
  ): boolean;
  override emit(event: "error", error: Error): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}
