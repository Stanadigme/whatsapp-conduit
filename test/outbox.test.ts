import { lstatSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import {
  acknowledgeOutbox,
  countOutbox,
  enqueueOutbox,
  ensureOutboxKey,
  leaseOutbox,
  retryOutbox,
} from "../src/db/outbox.js";

function setup(): { db: ReturnType<typeof openDb>; dir: string; key: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "wac-outbox-"));
  return {
    db: openDb(":memory:", { migrate: true }),
    dir,
    key: ensureOutboxKey(join(dir, "outbox.key")),
  };
}

describe("encrypted outbox", () => {
  it("stores no plaintext, decrypts after leasing, and only deletes after acknowledgement", () => {
    const { db, dir, key } = setup();
    try {
      const source = "message privé qui ne doit pas apparaître dans SQLite";
      const id = enqueueOutbox(db, key, {
        operation: "message.upsert",
        dedupeKey: "acct\\0chat\\0M1",
        payload: { text: source, messageId: "M1" },
      });

      const stored = db
        .prepare(
          "select operation, dedupe_key, nonce, ciphertext, auth_tag from outbox",
        )
        .get() as Record<string, Buffer | string>;
      expect(JSON.stringify(stored)).not.toContain(source);
      expect(lstatSync(join(dir, "outbox.key")).isSymbolicLink()).toBe(false);

      const [leased] = leaseOutbox(db, key, { now: 100, leaseS: 30 });
      expect(leased).toMatchObject({
        id,
        operation: "message.upsert",
        payload: { text: source, messageId: "M1" },
        attempts: 1,
      });
      expect(acknowledgeOutbox(db, id, "not-the-lease")).toBe(false);
      expect(countOutbox(db).pending).toBe(1);
      expect(acknowledgeOutbox(db, id, leased?.leaseToken ?? "")).toBe(true);
      expect(countOutbox(db)).toEqual({ pending: 0, encryptedBytes: 0 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("coalesces replayed operations and resumes an expired lease", () => {
    const { db, dir, key } = setup();
    try {
      const first = enqueueOutbox(
        db,
        key,
        {
          operation: "message.upsert",
          dedupeKey: "acct\\0chat\\0M1",
          payload: { text: "avant" },
        },
        10,
      );
      const second = enqueueOutbox(
        db,
        key,
        {
          operation: "message.upsert",
          dedupeKey: "acct\\0chat\\0M1",
          payload: { text: "après" },
        },
        20,
      );
      expect(second).toBe(first);
      expect(countOutbox(db).pending).toBe(1);

      const [firstLease] = leaseOutbox(db, key, { now: 100, leaseS: 10 });
      expect(firstLease?.payload).toEqual({ text: "après" });
      expect(leaseOutbox(db, key, { now: 109 })).toEqual([]);

      const [resumed] = leaseOutbox(db, key, { now: 110 });
      expect(resumed).toMatchObject({ id: first, attempts: 2 });
      expect(retryOutbox(db, resumed?.id ?? 0, resumed?.leaseToken ?? "")).toBe(
        true,
      );
      expect(leaseOutbox(db, key, { now: 110 })).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a modified payload and owner-protects the key file", () => {
    const { db, dir, key } = setup();
    try {
      enqueueOutbox(db, key, {
        operation: "message.upsert",
        dedupeKey: "acct\\0chat\\0M1",
        payload: { text: "secret" },
      });
      db.prepare("update outbox set ciphertext = x'00'").run();
      expect(() => leaseOutbox(db, key, { now: 100 })).toThrow(
        "outbox payload authentication failed",
      );
      expect(statSync(join(dir, "outbox.key")).mode & 0o777).toBe(0o600);

      const target = join(dir, "target.key");
      const link = join(dir, "link.key");
      ensureOutboxKey(target);
      symlinkSync(target, link);
      expect(() => ensureOutboxKey(link)).toThrow(
        "outbox key file must not be a symbolic link",
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
