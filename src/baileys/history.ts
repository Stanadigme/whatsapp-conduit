import { jidNormalizedUser, proto, type WASocket } from "baileys";
import type {
  HistoryAnchor,
  TransportConnectedEvent,
  TransportMessageEvent,
} from "../transport/types.js";
import { isGroupJid } from "./jid.js";

type Listener = (...args: never[]) => void;

/**
 * Small adapter around Baileys' supported on-demand history request.
 *
 * It deliberately exposes no generic socket operation. The only outbound
 * protocol action is `fetchMessageHistory`, which asks the account's own
 * linked devices for a bounded historic batch.
 */
export class BaileysHistoryTransport {
  private socket: WASocket | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  on(
    event: "connected",
    listener: (data: TransportConnectedEvent) => void,
  ): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "message", listener: (data: TransportMessageEvent) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "history_sync",
    listener: (data: {
      type: string;
      progress?: number;
      chunkOrder?: number;
    }) => void,
  ): this;
  on(event: string, listener: Listener): this {
    const group = this.listeners.get(event) ?? new Set<Listener>();
    group.add(listener);
    this.listeners.set(event, group);
    return this;
  }

  attach(socket: WASocket): void {
    this.socket = socket;
    socket.ev.on("messaging-history.set", (event) => {
      if (event.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
        return;
      }
      this.emit("history_sync", {
        type: "ON_DEMAND",
        ...(event.progress === null || event.progress === undefined
          ? {}
          : { progress: event.progress }),
        ...(event.chunkOrder === null || event.chunkOrder === undefined
          ? {}
          : { chunkOrder: event.chunkOrder }),
      });
    });
    socket.ev.on("messaging-history.status", (event) => {
      if (event.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND) {
        return;
      }
      this.emit("history_sync", { type: "ON_DEMAND" });
    });
  }

  connected(jid: string): void {
    this.emit("connected", { jid });
  }

  disconnected(): void {
    this.socket = null;
    this.emit("disconnected");
  }

  async requestHistory(anchor: HistoryAnchor, count: number): Promise<void> {
    const socket = this.socket;
    if (!socket?.user?.id) throw new Error("transport not started");
    const selfJid = jidNormalizedUser(socket.user.id);
    const fromMe = jidNormalizedUser(anchor.sender) === selfJid;
    await socket.fetchMessageHistory(
      count,
      {
        remoteJid: anchor.chat,
        fromMe,
        ...(!fromMe && isGroupJid(anchor.chat)
          ? { participant: anchor.sender }
          : {}),
        id: anchor.id,
      },
      anchor.timestamp * 1000,
    );
  }

  private emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (input?: unknown) => void)(value);
    }
  }
}

/** Convert Baileys' number/Long timestamp representation to epoch seconds. */
export function baileysTimestamp(value: unknown): number {
  if (typeof value === "number") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number.NaN;
}
