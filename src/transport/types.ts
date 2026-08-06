import type {
  GroupInfo,
  GroupInfoEvent,
  MessageInfo,
  UserInfo,
} from "@whatsmeow-node/whatsmeow-node";

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
