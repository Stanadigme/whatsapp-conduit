import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { resolveConfig, type Config } from "../src/config.js";
import {
  ingestNormalizedResult,
  type IngestDeps,
} from "../src/baileys/ingest.js";
import { openDb } from "../src/db/index.js";
import { countMessages, getMessage, upsertAccount } from "../src/db/queries.js";
import { registerWhatsmeowIngestion } from "../src/whatsmeow/ingest.js";
import { normalizeWhatsmeowMessage } from "../src/whatsmeow/normalize.js";
import { createLogger } from "../src/util/logging.js";

function deps(config: Config): IngestDeps {
  const db = openDb(":memory:", { migrate: true });
  upsertAccount(db, { id: "personal" });
  return {
    db,
    accountId: "personal",
    config,
    logger: createLogger({ level: "error" }),
  };
}

function event(message: Record<string, unknown>) {
  return {
    info: {
      id: "W1",
      chat: "25954537754701@lid",
      sender: "25954537754701@lid",
      isFromMe: false,
      isGroup: false,
      timestamp: 1_700_000_000,
      pushName: "Contact",
    },
    message,
  } as never;
}

describe("whatsmeow ingestion adapter", () => {
  it("stores inbound events and deduplicates repeated delivery", () => {
    const depsForTest = deps(resolveConfig({}, { dataDir: "/data" }));
    const transport = new EventEmitter();
    registerWhatsmeowIngestion(transport as never, depsForTest);

    const inbound = event({ conversation: "hello from whatsmeow" });
    transport.emit("message", inbound);
    transport.emit("message", inbound);

    expect(countMessages(depsForTest.db)).toBe(1);
    expect(
      getMessage(depsForTest.db, "personal", "25954537754701@lid", "W1")?.text,
    ).toBe("hello from whatsmeow");
    depsForTest.db.close();
  });

  it("applies the common normalizer contract before persistence", () => {
    const depsForTest = deps(resolveConfig({}, { dataDir: "/data" }));
    const result = normalizeWhatsmeowMessage(
      event({
        extendedTextMessage: {
          text: "quoted reply",
          contextInfo: { stanzaId: "ORIGINAL" },
        },
      }),
    );

    expect(result.action).toBe("store");
    expect(ingestNormalizedResult(depsForTest, result, null)).toBe(true);
    expect(
      getMessage(depsForTest.db, "personal", "25954537754701@lid", "W1"),
    ).toMatchObject({
      text: "quoted reply",
      quoted_message_id: "ORIGINAL",
    });
    depsForTest.db.close();
  });
});
