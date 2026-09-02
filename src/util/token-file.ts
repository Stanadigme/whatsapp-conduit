import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** Minimum accepted length of a bearer token loaded from disk. */
export const MIN_TOKEN_LENGTH = 32;

/**
 * Load or create an owner-only bearer token file.
 *
 * The parent directory is created `0700`, an existing file is tightened to
 * `0600`, and a symlink at `path` is rejected outright: the token file is a
 * live credential and must not be redirected. A freshly created token is 32
 * random bytes rendered as hex (64 characters).
 */
export function ensureTokenFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let existing = false;
  try {
    existing = true;
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("token file must not be a symbolic link");
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
    if (token.length >= MIN_TOKEN_LENGTH) return token;
    throw new Error("token file is invalid");
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

/** Read an existing owner-only bearer token file, rejecting a symlink. */
export function readTokenFile(path: string): string {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("token file must not be a symbolic link");
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length < MIN_TOKEN_LENGTH) throw new Error("token file is invalid");
  return token;
}
