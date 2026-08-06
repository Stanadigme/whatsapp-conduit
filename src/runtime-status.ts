import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nowSec } from "./util/time.js";

export type RuntimeConnection = "connected" | "disconnected" | "unknown";

export interface RuntimeStatus {
  transport: string;
  connection: RuntimeConnection;
  authLinked: boolean;
  lastEventAt: number | null;
  updatedAt: number;
}

/** Private, atomic status snapshot shared by ingestion and read-only MCP. */
export class RuntimeStatusWriter {
  private current: RuntimeStatus;
  private writeQueue = Promise.resolve();

  constructor(
    private readonly path: string,
    initial: Partial<RuntimeStatus> = {},
  ) {
    this.current = {
      transport: initial.transport ?? "unknown",
      connection: initial.connection ?? "unknown",
      authLinked: initial.authLinked ?? false,
      lastEventAt: initial.lastEventAt ?? null,
      updatedAt: initial.updatedAt ?? nowSec(),
    };
  }

  async update(patch: Partial<RuntimeStatus> = {}): Promise<void> {
    this.current = {
      ...this.current,
      ...patch,
      updatedAt: nowSec(),
    };
    const snapshot = this.current;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, this.path);
    });
    await this.writeQueue;
  }
}

export async function readRuntimeStatus(
  path: string,
): Promise<RuntimeStatus | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRuntimeStatus(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.transport === "string" &&
    (record.connection === "connected" ||
      record.connection === "disconnected" ||
      record.connection === "unknown") &&
    typeof record.authLinked === "boolean" &&
    (record.lastEventAt === null || typeof record.lastEventAt === "number") &&
    typeof record.updatedAt === "number"
  );
}
