import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireSessionLock,
  sessionLockHeld,
} from "../src/whatsmeow/session-lock.js";

let dir: string;
let store: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-lock-"));
  store = join(dir, "whatsmeow.db");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("session lock", () => {
  it("creates and removes a lock file around a holder", () => {
    expect(sessionLockHeld(store)).toBe(false);
    const lock = acquireSessionLock(store);
    expect(existsSync(`${store}.lock`)).toBe(true);
    expect(sessionLockHeld(store)).toBe(true);
    lock.release();
    expect(existsSync(`${store}.lock`)).toBe(false);
  });

  it("refuses a second acquire while a live holder exists", () => {
    const lock = acquireSessionLock(store);
    expect(() => acquireSessionLock(store)).toThrow(/ingestion|store/i);
    lock.release();
  });

  it("overwrites a stale lock from a dead pid on this host", () => {
    writeFileSync(
      `${store}.lock`,
      `${JSON.stringify({ pid: 2147483646, host: hostname(), startedAt: 1 })}\n`,
    );
    expect(sessionLockHeld(store)).toBe(false);
    const lock = acquireSessionLock(store);
    const info = JSON.parse(readFileSync(`${store}.lock`, "utf8")) as {
      pid: number;
    };
    expect(info.pid).toBe(process.pid);
    lock.release();
  });

  it("release only removes the lock it owns", () => {
    const lock = acquireSessionLock(store);
    lock.release();
    writeFileSync(
      `${store}.lock`,
      `${JSON.stringify({ pid: 2147483646, host: hostname(), startedAt: 1 })}\n`,
    );
    lock.release(); // second call is a no-op, must not delete the other lock
    expect(existsSync(`${store}.lock`)).toBe(true);
  });
});
