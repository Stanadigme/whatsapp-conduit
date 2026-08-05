import { describe, expect, it } from "vitest";
import { normalizeWhatsmeowMessage } from "../src/whatsmeow/normalize.js";

function event(message: Record<string, unknown>, overrides = {}) {
  return {
    info: {
      id: "M1",
      chat: "25954537754701@lid",
      sender: "25954537754701@lid",
      isFromMe: false,
      isGroup: false,
      timestamp: 1_700_000_000,
      pushName: "Contact",
      ...overrides,
    },
    message,
  } as never;
}

describe("normalizeWhatsmeowMessage", () => {
  it("normalizes a conversation received with a LID", () => {
    const result = normalizeWhatsmeowMessage(event({ conversation: "hello" }));
    expect(result).toMatchObject({
      action: "store",
      message: {
        chatJid: "25954537754701@lid",
        senderJid: "25954537754701@lid",
        messageType: "text",
        text: "hello",
        timestamp: 1_700_000_000,
      },
    });
  });

  it("normalizes extended text and quoted context", () => {
    const result = normalizeWhatsmeowMessage(
      event({
        extendedTextMessage: {
          text: "reply",
          contextInfo: {
            stanzaId: "ORIGINAL",
            participant: "33600000000@s.whatsapp.net",
          },
        },
        messageContextInfo: { deviceListMetadataVersion: 2 },
      }),
    );
    expect(result).toMatchObject({
      action: "store",
      message: {
        messageType: "text",
        text: "reply",
        quotedMessageId: "ORIGINAL",
        quotedSenderJid: "33600000000@s.whatsapp.net",
      },
    });
  });

  it("persists audio duration before media download", () => {
    const result = normalizeWhatsmeowMessage(
      event({
        audioMessage: { seconds: 37, mimetype: "audio/ogg; codecs=opus" },
      }),
    );
    expect(result).toMatchObject({
      action: "store",
      message: { messageType: "audio", hasMedia: true, durationS: 37 },
    });
  });

  it("maps reactions deterministically", () => {
    const result = normalizeWhatsmeowMessage(
      event({
        reactionMessage: {
          text: "👍",
          key: { id: "TARGET", participant: "33600000000@s.whatsapp.net" },
        },
      }),
    );
    expect(result).toMatchObject({
      action: "store",
      message: {
        messageId: "reaction:TARGET:25954537754701@lid",
        messageType: "reaction",
        quotedMessageId: "TARGET",
      },
    });
  });

  it("does not invent fields for unknown content", () => {
    const result = normalizeWhatsmeowMessage(
      event({ futureMessage: { value: 1 } }),
    );
    expect(result).toMatchObject({
      action: "store",
      message: { messageType: "unknown", text: null },
    });
  });
});
