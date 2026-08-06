import type { Database } from "better-sqlite3";
import type { Config } from "../config.js";
import type { RuntimeStatus } from "../runtime-status.js";

export const MCP_MAX_PAGE_SIZE = 200;

export interface McpContext {
  db: Database;
  config: Config;
  accountId: string;
  runtimeStatus: RuntimeStatus | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export class McpRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRequestError";
  }
}

export function assertLimit(limit: number | undefined): number {
  const value = limit ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > MCP_MAX_PAGE_SIZE) {
    throw new McpRequestError(
      `limit must be an integer between 1 and ${MCP_MAX_PAGE_SIZE}`,
    );
  }
  return value;
}

export function assertWindow(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MCP_MAX_PAGE_SIZE) {
    throw new McpRequestError(
      `window must be an integer between 0 and ${MCP_MAX_PAGE_SIZE}`,
    );
  }
  return value;
}

export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T extends Record<string, unknown>>(
  cursor: string | undefined,
): T | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    return parsed as T;
  } catch {
    throw new McpRequestError("invalid cursor");
  }
}

export function page<T>(
  items: T[],
  limit: number,
  cursor: string | null,
): Page<T> {
  return {
    items: items.slice(0, limit),
    nextCursor: items.length > limit ? cursor : null,
  };
}

export function hasTable(db: Database, name: string): boolean {
  return Boolean(
    db
      .prepare<
        [string],
        { name: string }
      >("select name from sqlite_master where type = 'table' and name = ?")
      .get(name),
  );
}

export function hasVirtualTable(db: Database, name: string): boolean {
  return Boolean(
    db
      .prepare<
        [string],
        { name: string }
      >("select name from sqlite_master where name = ?")
      .get(name),
  );
}
