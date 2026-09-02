import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { whatsmeowSessionLinked } from "../src/whatsmeow/session.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-wm-session-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore(withTable: boolean, deviceRows: number): string {
  const path = join(dir, "whatsmeow.db");
  const db = new Database(path);
  if (withTable) {
    db.exec("create table whatsmeow_device (jid text primary key)");
    for (let i = 0; i < deviceRows; i += 1) {
      db.prepare("insert into whatsmeow_device (jid) values (?)").run(
        `dev${i}@s.whatsapp.net`,
      );
    }
  }
  db.close();
  return path;
}

describe("whatsmeowSessionLinked", () => {
  it("is false when the store file is absent", () => {
    expect(whatsmeowSessionLinked(join(dir, "missing.db"))).toBe(false);
  });

  it("is false for a store left by an interrupted link (no device row)", () => {
    expect(whatsmeowSessionLinked(makeStore(true, 0))).toBe(false);
  });

  it("is false when the whatsmeow_device table does not exist", () => {
    expect(whatsmeowSessionLinked(makeStore(false, 0))).toBe(false);
  });

  it("is true once a device row is present", () => {
    expect(whatsmeowSessionLinked(makeStore(true, 1))).toBe(true);
  });
});
