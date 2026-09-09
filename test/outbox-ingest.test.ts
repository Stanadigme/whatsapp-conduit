import { describe, expect, it } from "vitest";
import type { WAMessage } from "baileys";
import { ingestMessage, ingestUpdate } from "../src/baileys/ingest.js";
import { resolveConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { countOutbox, leaseOutbox } from "../src/db/outbox.js";
import { countMessages, upsertAccount } from "../src/db/queries.js";
import { createLogger } from "../src/util/logging.js";

function message(text: string): WAMessage {
  return {
    key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "M1" },
    messageTimestamp: 1_700,
    pushName: "Alice",
    message: { conversation: text },
  } as WAMessage;
}

describe("ingestion outbox", () => {
  it("persists one encrypted latest snapshot with the local message transaction", () => {
    const db = openDb(":memory:", { migrate: true });
    const key = Buffer.alloc(32, 7);
    const deps = {
      db,
      accountId: "personal",
      config: resolveConfig({}, { dataDir: "/data" }),
      logger: createLogger({ level: "error" }),
      outboxKey: key,
    };
    upsertAccount(db, { id: "personal" });

    try {
      ingestMessage(deps, message("bonjour"));
      ingestUpdate(deps, {
        key: { remoteJid: "c@s.whatsapp.net", fromMe: false, id: "M1" },
        update: { message: null },
      });

      expect(countMessages(db)).toBe(1);
      expect(countOutbox(db).pending).toBe(1);
      const [operation] = leaseOutbox(db, key, { now: 1_800 });
      expect(operation).toMatchObject({
        operation: "message.upsert",
        payload: {
          version: 1,
          chat: { account_id: "personal", jid: "c@s.whatsapp.net" },
          message: {
            account_id: "personal",
            chat_jid: "c@s.whatsapp.net",
            message_id: "M1",
            text: "bonjour",
          },
        },
      });
      expect(
        (
          operation?.payload as {
            message: { deleted_at: number | null };
          }
        ).message.deleted_at,
      ).toEqual(expect.any(Number));
    } finally {
      db.close();
    }
  });

  it("rolls back the local message if the encrypted operation cannot be written", () => {
    const db = openDb(":memory:", { migrate: true });
    const deps = {
      db,
      accountId: "personal",
      config: resolveConfig({}, { dataDir: "/data" }),
      logger: createLogger({ level: "error" }),
      outboxKey: Buffer.alloc(1),
    };
    upsertAccount(db, { id: "personal" });

    try {
      expect(() => ingestMessage(deps, message("jamais écrit"))).toThrow(
        "outbox key must be 32 bytes",
      );
      expect(countMessages(db)).toBe(0);
      expect(countOutbox(db).pending).toBe(0);
    } finally {
      db.close();
    }
  });
});
