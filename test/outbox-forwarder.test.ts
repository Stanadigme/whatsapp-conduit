import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { flushOutbox } from "../src/db/outbox-forwarder.js";
import { countOutbox, enqueueOutbox } from "../src/db/outbox.js";

function setup(): { db: ReturnType<typeof openDb>; key: Buffer } {
  return {
    db: openDb(":memory:", { migrate: true }),
    key: Buffer.alloc(32, 9),
  };
}

describe("outbox forwarder", () => {
  it("acknowledges a delivered ordered batch", async () => {
    const { db, key } = setup();
    try {
      enqueueOutbox(db, key, {
        operation: "message.upsert",
        dedupeKey: "M1",
        payload: { id: "M1" },
      });
      enqueueOutbox(db, key, {
        operation: "message.upsert",
        dedupeKey: "M2",
        payload: { id: "M2" },
      });
      const forwarded: string[] = [];

      await expect(
        flushOutbox(
          db,
          key,
          async ({ payload }) => {
            forwarded.push((payload as { id: string }).id);
          },
          { now: 100 },
        ),
      ).resolves.toEqual({ leased: 2, acknowledged: 2, retryPending: 0 });
      expect(forwarded).toEqual(["M1", "M2"]);
      expect(countOutbox(db).pending).toBe(0);
    } finally {
      db.close();
    }
  });

  it("retains the failed operation and does not overtake it", async () => {
    const { db, key } = setup();
    try {
      enqueueOutbox(db, key, {
        operation: "message.upsert",
        dedupeKey: "M1",
        payload: { id: "M1" },
      });
      enqueueOutbox(db, key, {
        operation: "message.upsert",
        dedupeKey: "M2",
        payload: { id: "M2" },
      });
      const forwarded: string[] = [];

      await expect(
        flushOutbox(
          db,
          key,
          async ({ payload }) => {
            const id = (payload as { id: string }).id;
            forwarded.push(id);
            if (id === "M1") throw new Error("destination unavailable");
          },
          { now: 100 },
        ),
      ).resolves.toEqual({ leased: 2, acknowledged: 0, retryPending: 2 });
      expect(forwarded).toEqual(["M1"]);
      expect(countOutbox(db).pending).toBe(2);

      await expect(
        flushOutbox(
          db,
          key,
          async ({ payload }) => {
            forwarded.push((payload as { id: string }).id);
          },
          { now: 101 },
        ),
      ).resolves.toEqual({ leased: 2, acknowledged: 2, retryPending: 0 });
      expect(forwarded).toEqual(["M1", "M1", "M2"]);
    } finally {
      db.close();
    }
  });
});
