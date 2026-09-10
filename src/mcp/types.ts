import type { Database } from "better-sqlite3";
import type { Config } from "../config.js";
import type { ClientDataReader } from "../db/reader.js";
import type { RuntimeStatus } from "../runtime-status.js";

export const MCP_MAX_PAGE_SIZE = 200;

/**
 * Context for the running MCP surface (server.ts, http.ts, history.ts):
 * reader-backed, so it works identically whether the process is SQLite- or
 * PostgreSQL-backed (ADR-0033 phase 2) — see db/reader.ts. Not to be confused
 * with mcp/read.ts's SqliteMcpContext, which is the SQLite-specific shape
 * used only internally by db/sqlite-reader.ts to reuse that file's queries.
 */
export interface McpContext {
  reader: ClientDataReader;
  config: Config;
  accountId: string;
  runtimeStatus: RuntimeStatus | null;
  historyControl?: (
    chat: string,
    since: number,
  ) => Promise<{ jobId: string; status: string; reused: boolean }>;
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

// Tables can only appear during migrations, never mid-life of an open
// connection, so one sqlite_master lookup per connection and name is enough.
// Mirrors `directoryTablesCache` in db/directory.ts, including its rule: a
// `false` is never memoized, so a connection opened before migrations ran can
// still observe the tables appearing.
const schemaObjectCache = new WeakMap<Database, Set<string>>();

function memoizedSchemaLookup(
  db: Database,
  key: string,
  lookup: () => boolean,
): boolean {
  const known = schemaObjectCache.get(db);
  if (known?.has(key)) return true;
  if (!lookup()) return false;
  if (known) known.add(key);
  else schemaObjectCache.set(db, new Set([key]));
  return true;
}

export function hasTable(db: Database, name: string): boolean {
  return memoizedSchemaLookup(db, `table:${name}`, () =>
    Boolean(
      db
        .prepare<
          [string],
          { name: string }
        >("select name from sqlite_master where type = 'table' and name = ?")
        .get(name),
    ),
  );
}

export function hasVirtualTable(db: Database, name: string): boolean {
  return memoizedSchemaLookup(db, `object:${name}`, () =>
    Boolean(
      db
        .prepare<
          [string],
          { name: string }
        >("select name from sqlite_master where name = ?")
        .get(name),
    ),
  );
}
