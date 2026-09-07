import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareBaileysRelink,
  restoreBaileysRelink,
} from "../src/baileys/relink.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-relink-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Baileys relink archive", () => {
  it("archives the former auth and restores it after a failed pairing", () => {
    const authDir = join(dir, "auth");
    mkdirSync(authDir);
    writeFileSync(join(authDir, "creds.json"), "former-session");

    const archived = prepareBaileysRelink(authDir);
    expect(archived).not.toBeNull();
    expect(existsSync(authDir)).toBe(true);
    expect(readFileSync(join(archived ?? "", "creds.json"), "utf8")).toBe(
      "former-session",
    );

    writeFileSync(join(authDir, "creds.json"), "failed-session");
    restoreBaileysRelink(authDir, archived);

    expect(readFileSync(join(authDir, "creds.json"), "utf8")).toBe(
      "former-session",
    );
    expect(existsSync(archived ?? "")).toBe(false);
  });
});
