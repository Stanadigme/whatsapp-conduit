/**
 * Minimal shape of an ingested message an adapter hands to the history
 * coordinator. Redefined here since ADR-0042 removed the whatsmeow dependency
 * that used to provide it: only the three fields the coordinator reads are
 * carried.
 */
export interface TransportMessageInfo {
  id: string;
  chat: string;
  timestamp: number;
}

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
   */
  endOfHistoryTransferType?: number;
}

export interface TransportMessageEvent {
  info: TransportMessageInfo;
  message: Record<string, unknown>;
}

export interface TransportConnectedEvent {
  jid: string;
}

export interface HistoryTransport {
  requestHistory(anchor: HistoryAnchor, count: number): Promise<string | void>;
}
