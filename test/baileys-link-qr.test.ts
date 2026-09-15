import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLiveBaileysLinkQr } from "../src/dashboard/baileys-link-qr.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Baileys link QR lifetime", () => {
  it("keeps the first QR available at 60 seconds and expires it after 75 seconds", () => {
    dir = mkdtempSync(join(tmpdir(), "wac-link-qr-"));
    const path = join(dir, "pairing-qr.svg");
    const qr = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    writeFileSync(path, qr, { mode: 0o600 });
    const writtenAt = 1_000_000;
    utimesSync(path, writtenAt / 1000, writtenAt / 1000);

    expect(readLiveBaileysLinkQr(dir, writtenAt + 60_000)).toBe(qr);
    expect(readLiveBaileysLinkQr(dir, writtenAt + 75_001)).toBeNull();
  });
});
