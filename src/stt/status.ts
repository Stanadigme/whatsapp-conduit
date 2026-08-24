import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { nowSec } from "../util/time.js";

/**
 * Transcription worker heartbeat.
 *
 * The dashboard can enable transcription, but nothing there starts the worker.
 * Without this file, an "enabled" switch would claim work is happening while no
 * process is running. The worker stamps the file at the end of every pass; the
 * dashboard treats a stale stamp as "worker stopped".
 *
 * ponytail: a dedicated writer rather than generalizing RuntimeStatusWriter,
 * whose shape is specific to ingestion. Merge them if a third consumer appears.
 */
export interface SttStatus {
  lastPassAt: number;
  enabled: boolean;
  engine: string;
  /** Last failure reason, or null. Never carries transcript text. */
  lastError: string | null;
}

/** Derived from the data directory: a heartbeat needs no config key. */
export function sttStatusPath(config: Config): string {
  return join(config.paths.dataDir, "stt-status.json");
}

export async function writeSttStatus(
  path: string,
  status: Omit<SttStatus, "lastPassAt">,
): Promise<void> {
  const snapshot: SttStatus = { ...status, lastPassAt: nowSec() };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readSttStatus(path: string): Promise<SttStatus | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.lastPassAt !== "number" ||
      typeof record.enabled !== "boolean" ||
      typeof record.engine !== "string"
    ) {
      return null;
    }
    return {
      lastPassAt: record.lastPassAt,
      enabled: record.enabled,
      engine: record.engine,
      lastError: typeof record.lastError === "string" ? record.lastError : null,
    };
  } catch {
    return null;
  }
}
