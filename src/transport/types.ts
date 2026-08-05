import type { MessageInfo } from "@whatsmeow-node/whatsmeow-node";

export interface TransportMessageEvent {
  info: MessageInfo;
  message: Record<string, unknown>;
}

export interface TransportConnectedEvent {
  jid: string;
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
