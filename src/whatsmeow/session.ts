import { existsSync } from "node:fs";
import Database from "better-sqlite3";

/**
 * Whether the whatsmeow store at `storePath` holds a real linked device.
 *
 * A file left behind by an interrupted `link` still exists on disk and still
 * has the whatsmeow schema, but its `whatsmeow_device` table is empty. Callers
 * that only check `existsSync` therefore report a half-paired store as linked
 * and spin `run` in a crash loop. This opens the store read-only and checks for
 * at least one device row.
 */
export function whatsmeowSessionLinked(storePath: string): boolean {
  if (!existsSync(storePath)) return false;
  let db: Database.Database | undefined;
  try {
    db = new Database(storePath, { readonly: true, fileMustExist: true });
    const hasDeviceTable = db
      .prepare<
        [],
        { name: string }
      >("select name from sqlite_master where type = 'table' and name = 'whatsmeow_device'")
      .get();
    if (!hasDeviceTable) return false;
    const row = db
      .prepare<[], { n: number }>("select count(*) as n from whatsmeow_device")
      .get();
    return (row?.n ?? 0) > 0;
  } catch {
    // An unreadable or malformed store is not a usable session.
    return false;
  } finally {
    db?.close();
  }
}
