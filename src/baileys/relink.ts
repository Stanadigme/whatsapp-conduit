import { existsSync, mkdirSync, renameSync } from "node:fs";

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "");
}

function uniquePath(base: string): string {
  let candidate = base;
  let attempt = 1;
  while (existsSync(candidate)) {
    candidate = `${base}-${attempt}`;
    attempt += 1;
  }
  return candidate;
}

/** Move the existing account aside and create a private, empty auth directory. */
export function prepareBaileysRelink(authDir: string): string | null {
  if (!existsSync(authDir)) {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    return null;
  }
  const archived = uniquePath(`${authDir}.pre-repair-${timestamp()}`);
  renameSync(authDir, archived);
  try {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    return archived;
  } catch (error) {
    renameSync(archived, authDir);
    throw error;
  }
}

/** Preserve the failed attempt, then restore the previous working account. */
export function restoreBaileysRelink(
  authDir: string,
  archivedAuthDir: string | null,
): void {
  if (!archivedAuthDir) return;
  if (existsSync(authDir)) {
    renameSync(authDir, uniquePath(`${authDir}.failed-link-${timestamp()}`));
  }
  renameSync(archivedAuthDir, authDir);
}
