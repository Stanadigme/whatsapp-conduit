import type {
  GroupInfo,
  GroupInfoEvent,
  MessageInfo,
  UserInfo,
} from "@whatsmeow-node/whatsmeow-node";

export interface HistoryAnchor {
  chat: string;
  sender?: string;
  fromMe?: boolean;
  id: string;
  timestamp: number;
}

export interface TransportHistorySyncEvent {
  type: string;
  chatJid?: string;
  requestId?: string;
  progress?: number;
  chunkOrder?: number;
  /** Messages carried by this batch, when the transport can count them. */
  messageCount?: number;
  /**
   * Baileys' `proto.Conversation.EndOfHistoryTransferType` for the chat this
   * batch belongs to, when the transport exposes chat-level history state.
   * Absent on transports (whatsmeow) that do not surface it.
   */
  endOfHistoryTransferType?: number;
}

export interface TransportMessageEvent {
  info: MessageInfo;
  message: Record<string, unknown>;
}

export interface TransportConnectedEvent {
  jid: string;
}

export type TransportGroupInfoEvent = GroupInfoEvent;
export type TransportGroupJoinedEvent = { jid: string; name: string };

export interface DirectoryReadTransport {
  on(event: "message", listener: (data: TransportMessageEvent) => void): this;
  on(
    event: "group:info",
    listener: (data: TransportGroupInfoEvent) => void,
  ): this;
  on(
    event: "group:joined",
    listener: (data: TransportGroupJoinedEvent) => void,
  ): this;
  getJoinedGroups(): Promise<GroupInfo[]>;
  getGroupInfo(jid: string): Promise<GroupInfo>;
  getUserInfo(jids: string[]): Promise<Record<string, UserInfo>>;
}

export interface HistoryTransport {
  requestHistory(anchor: HistoryAnchor, count: number): Promise<string | void>;
}

export interface ObserveTransport {
  on(
    event: "connected",
    listener: (data: TransportConnectedEvent) => void,
  ): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "message", listener: (data: TransportMessageEvent) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  start(): Promise<void>;
  stop(): Promise<void>;
}
