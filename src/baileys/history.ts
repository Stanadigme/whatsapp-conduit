import { jidNormalizedUser, proto, type Chat, type WASocket } from "baileys";
import type {
  HistoryAnchor,
  TransportConnectedEvent,
  TransportHistorySyncEvent,
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
  /** Chat of the in-flight `requestHistory` call, used to match `chats[]`. */
  private requestedChat: string | null = null;
  private requestedId: string | null = null;
  private pending: TransportHistorySyncEvent[] = [];

  on(
    event: "connected",
    listener: (data: TransportConnectedEvent) => void,
  ): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "message", listener: (data: TransportMessageEvent) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "history_sync",
    listener: (data: TransportHistorySyncEvent) => void,
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
      const chatJids = [...new Set(event.messages.map((message) => message.key.remoteJid).filter((jid): jid is string => Boolean(jid)))];
      if (chatJids.length > 1) return;
      const chatJid = chatJids[0] ?? (event.chats.length === 1 ? event.chats[0]?.id : event.chats.length === 0 && event.messages.length === 0 ? this.requestedChat : undefined);
      if (!chatJid || !this.requestedChat || jidNormalizedUser(chatJid) !== jidNormalizedUser(this.requestedChat)) return;
      const endOfHistoryTransferType = this.resolveEndOfHistoryTransferType(
        event.chats,
      );
      const batch: TransportHistorySyncEvent = {
        type: "ON_DEMAND",
        chatJid,
        ...(event.peerDataRequestSessionId ? { requestId: event.peerDataRequestSessionId } : {}),
        messageCount: event.messages.length,
        ...(event.progress === null || event.progress === undefined
          ? {}
          : { progress: event.progress }),
        ...(event.chunkOrder === null || event.chunkOrder === undefined
          ? {}
          : { chunkOrder: event.chunkOrder }),
        ...(endOfHistoryTransferType === undefined
          ? {}
          : { endOfHistoryTransferType }),
      };
      if (batch.requestId && !this.requestedId) this.pending.push(batch);
      else if (!batch.requestId || batch.requestId === this.requestedId) this.emit("history_sync", batch);
    });
  }

  connected(jid: string): void {
    this.emit("connected", { jid });
  }

  disconnected(): void {
    this.socket = null;
    this.emit("disconnected");
  }

  async requestHistory(anchor: HistoryAnchor, count: number): Promise<string> {
    const socket = this.socket;
    if (!socket?.user?.id) throw new Error("transport not started");
    const selfJid = jidNormalizedUser(socket.user.id);
    const fromMe = anchor.fromMe ?? (anchor.sender ? jidNormalizedUser(anchor.sender) === selfJid : false);
    this.requestedChat = anchor.chat;
    this.requestedId = null;
    this.pending = [];
    const requestId = await socket.fetchMessageHistory(
      count,
      {
        remoteJid: anchor.chat,
        fromMe,
        ...(!fromMe && anchor.sender && isGroupJid(anchor.chat)
          ? { participant: anchor.sender }
          : {}),
        id: anchor.id,
      },
      anchor.timestamp * 1000,
    );
    this.requestedId = requestId;
    for (const batch of this.pending) if (batch.requestId === requestId) this.emit("history_sync", batch);
    this.pending = [];
    return requestId;
  }

  /**
   * Match the requested chat against `messaging-history.set`'s `chats[]` by
   * normalized JID, never by array index or array length.
   */
  private resolveEndOfHistoryTransferType(chats: Chat[]): number | undefined {
    const target = this.requestedChat
      ? jidNormalizedUser(this.requestedChat)
      : null;
    if (!target) return undefined;
    const match = chats.find(
      (chat) =>
        chat.id !== null &&
        chat.id !== undefined &&
        jidNormalizedUser(chat.id) === target,
    );
    return match?.endOfHistoryTransferType ?? undefined;
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
