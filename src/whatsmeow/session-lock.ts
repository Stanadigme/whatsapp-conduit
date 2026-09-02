import { hostname } from "node:os";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { nowSec } from "../util/time.js";

/**
 * A single-writer lock beside the whatsmeow store.
 *
 * Two whatsmeow clients on one session are forbidden (ADR-0009): the ingestion
 * daemon and an interactive `link` must never hold the store at the same time.
 * whatsmeow-node has no lock of its own, so `run` takes this one and `link`
 * refuses while it is held by a live process on the same host.
 */

export interface SessionLockInfo {
  pid: number;
  host: string;
  startedAt: number;
}

export interface SessionLock {
  release(): void;
}

function lockPath(storePath: string): string {
  return `${storePath}.lock`;
}

function readLock(storePath: string): SessionLockInfo | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(lockPath(storePath), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as SessionLockInfo).pid === "number" &&
      typeof (parsed as SessionLockInfo).host === "string"
    ) {
      return parsed as SessionLockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when a live process on this host currently holds the store. */
export function sessionLockHeld(storePath: string): boolean {
  const info = readLock(storePath);
  if (!info) return false;
  if (info.host !== hostname()) return true; // cannot verify a remote pid
  try {
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false; // stale: the recorded pid is gone
  }
}

/**
 * Acquire the store lock. Throws when a live holder exists; overwrites a stale
 * lock left by a crashed process on this host.
 */
export function acquireSessionLock(storePath: string): SessionLock {
  if (sessionLockHeld(storePath)) {
    throw new Error(
      "The ingestion daemon is holding the whatsmeow store. Stop it before linking.",
    );
  }
  const info: SessionLockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: nowSec(),
  };
  writeFileSync(lockPath(storePath), `${JSON.stringify(info)}\n`, {
    mode: 0o600,
  });
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        const current = readLock(storePath);
        if (current && current.pid === process.pid) {
          rmSync(lockPath(storePath), { force: true });
        }
      } catch {
        // best-effort
      }
    },
  };
}
