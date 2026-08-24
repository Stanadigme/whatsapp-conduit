import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DASHBOARD_SESSION_COOKIE = "dashboard_session";
export const DASHBOARD_SESSION_MAX_AGE_S = 8 * 60 * 60;
const DASHBOARD_SESSION_VERSION = "v1";

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

/** Create an opaque, non-persistent browser session bound to the dashboard token. */
export function createDashboardSession(
  token: string,
  now = Date.now(),
): string {
  const expiresAt = Math.floor(now / 1000) + DASHBOARD_SESSION_MAX_AGE_S;
  const nonce = randomBytes(16).toString("base64url");
  const payload = `${DASHBOARD_SESSION_VERSION}.${expiresAt}.${nonce}`;
  const signature = createHmac("sha256", token)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

/** Validate a browser session without exposing the dashboard token to it. */
export function verifyDashboardSession(
  token: string,
  session: string,
  now = Date.now(),
): boolean {
  const parts = session.split(".");
  if (parts.length !== 4) return false;
  const [version, expiresAtRaw, nonce, providedSignature] = parts;
  if (
    version !== DASHBOARD_SESSION_VERSION ||
    !expiresAtRaw ||
    !nonce ||
    !providedSignature ||
    !/^\d+$/.test(expiresAtRaw)
  ) {
    return false;
  }

  const expiresAt = Number(expiresAtRaw);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) {
    return false;
  }

  const payload = `${version}.${expiresAtRaw}.${nonce}`;
  const expectedSignature = createHmac("sha256", token)
    .update(payload)
    .digest("base64url");
  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
