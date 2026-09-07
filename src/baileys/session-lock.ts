import { hostname } from "node:os";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { nowSec } from "../util/time.js";

interface SessionLockInfo {
  pid: number;
  host: string;
  startedAt: number;
}

export interface BaileysSessionLock {
  release(): void;
}

function lockPath(authDir: string): string {
  return `${authDir}.lock`;
}

function readLock(authDir: string): SessionLockInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath(authDir), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as SessionLockInfo).pid === "number" &&
      typeof (parsed as SessionLockInfo).host === "string"
    ) {
      return parsed as SessionLockInfo;
    }
  } catch {
    // A missing or incomplete lock is treated as stale.
  }
  return null;
}

export function baileysSessionLockHeld(authDir: string): boolean {
  const info = readLock(authDir);
  if (!info) return false;
  if (info.host !== hostname()) return true;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Prevent the daemon and a link operation from sharing Baileys auth state. */
export function acquireBaileysSessionLock(authDir: string): BaileysSessionLock {
  if (baileysSessionLockHeld(authDir)) {
    throw new Error(
      "The Baileys ingestion daemon is holding the auth state. Stop it before linking.",
    );
  }
  writeFileSync(
    lockPath(authDir),
    `${JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: nowSec(),
    } satisfies SessionLockInfo)}\n`,
    { mode: 0o600 },
  );
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        const current = readLock(authDir);
        if (current?.pid === process.pid) {
          rmSync(lockPath(authDir), { force: true });
        }
      } catch {
        // best-effort cleanup on shutdown
      }
    },
  };
}
