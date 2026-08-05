/** Shared normalized message contract, independent of the WhatsApp transport. */
export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "contact"
  | "location"
  | "poll"
  | "reaction"
  | "protocol"
  | "unknown";

export interface NormalizedMessage {
  chatJid: string;
  messageId: string;
  senderJid: string | null;
  fromMe: boolean;
  timestamp: number | null;
  messageType: MessageType;
  text: string | null;
  hasMedia: boolean;
  durationS: number | null;
  quotedMessageId: string | null;
  quotedSenderJid: string | null;
  isGroup: boolean;
  isStatus: boolean;
  pushName: string | null;
}

export type NormalizeResult =
  | { action: "store"; message: NormalizedMessage }
  | {
      action: "revoke";
      chatJid: string;
      targetId: string;
      senderJid: string | null;
      isGroup: boolean;
      isStatus: boolean;
    }
  | {
      action: "edit";
      chatJid: string;
      targetId: string;
      text: string | null;
      editId: string;
      senderJid: string | null;
      isGroup: boolean;
      isStatus: boolean;
    }
  | { action: "skip"; reason: string };
