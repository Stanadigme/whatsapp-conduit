import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authStateExists,
  clearPendingPairing,
  openAuthState,
} from "../src/baileys/auth.js";
import type { AuthState } from "../src/baileys/auth.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-auth-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openAuthState permissions", () => {
  it("creates the auth directory owner-only and tightens key files", async () => {
    const authDir = join(dir, "auth");
    await openAuthState(authDir);
    expect(statSync(authDir).mode & 0o777).toBe(0o700);

    // A pre-existing creds file is tightened on next open.
    writeFileSync(join(authDir, "creds.json"), "{}", { mode: 0o644 });
    await openAuthState(authDir);
    expect(statSync(join(authDir, "creds.json")).mode & 0o777).toBe(0o600);
  });

  it("treats an authenticated (me.id) creds.json as a linked session", async () => {
    const authDir = join(dir, "auth");
    await openAuthState(authDir);
    const creds = join(authDir, "creds.json");

    expect(authStateExists(authDir)).toBe(false);
    // Aborted/stale auth: file present but no authenticated identity yet.
    writeFileSync(creds, JSON.stringify({ registered: false }));
    expect(authStateExists(authDir)).toBe(false);
    // Malformed creds are not a session either.
    writeFileSync(creds, "not json");
    expect(authStateExists(authDir)).toBe(false);
    // QR-linked session: me.id present even though registered stays false
    // (Baileys v7 sets me from pair-success but leaves registered false).
    writeFileSync(
      creds,
      JSON.stringify({
        registered: false,
        me: { id: "49123:1@s.whatsapp.net" },
      }),
    );
    expect(authStateExists(authDir)).toBe(true);
  });

  it("clears provisional pairing credentials without touching an account", async () => {
    const saveCreds = vi.fn(async () => undefined);
    const creds = {
      me: { id: "49123@s.whatsapp.net" },
      pairingCode: "ABCD1234",
      registered: false,
    } as { me?: { id: string }; pairingCode?: string; account?: object };
    const authState = {
      state: { creds },
      saveCreds,
    } as unknown as AuthState;

    await clearPendingPairing(authState);

    expect(creds.me).toBeUndefined();
    expect(creds.pairingCode).toBeUndefined();
    expect(saveCreds).toHaveBeenCalledOnce();
  });

  it("makes an interrupted pairing appear unlinked to status", async () => {
    const authDir = join(dir, "auth");
    await openAuthState(authDir);
    writeFileSync(
      join(authDir, "creds.json"),
      JSON.stringify({
        registered: false,
        me: { id: "49123@s.whatsapp.net" },
        pairingCode: "ABCD1234",
      }),
    );

    const authState = await openAuthState(authDir);
    expect(authStateExists(authDir)).toBe(true);

    await clearPendingPairing(authState);

    expect(authStateExists(authDir)).toBe(false);
  });

  it("preserves completed account credentials", async () => {
    const saveCreds = vi.fn(async () => undefined);
    const creds = {
      account: {},
      me: { id: "49123@s.whatsapp.net" },
      pairingCode: "ABCD1234",
    } as { me?: { id: string }; pairingCode?: string; account?: object };
    const authState = {
      state: { creds },
      saveCreds,
    } as unknown as AuthState;

    await clearPendingPairing(authState);

    expect(creds.me).toEqual({ id: "49123@s.whatsapp.net" });
    expect(creds.pairingCode).toBe("ABCD1234");
    expect(saveCreds).not.toHaveBeenCalled();
  });
});
