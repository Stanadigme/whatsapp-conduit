import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** Load or create the owner-only dashboard bearer token. */
export function ensureDashboardToken(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let existing = false;
  try {
    existing = true;
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("dashboard token file must not be a symbolic link");
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Some filesystems do not implement chmod.
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = false;
  }
  if (existing) {
    const token = readFileSync(path, "utf8").trim();
    if (token.length >= 32) return token;
    throw new Error("dashboard token file is invalid");
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some filesystems do not implement chmod; the write mode remains best effort.
  }
  return token;
}

export function readDashboardToken(path: string): string {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("dashboard token file must not be a symbolic link");
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error("dashboard token file is invalid");
  return token;
}
