import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureTokenFile, readTokenFile } from "../src/util/token-file.js";

describe("token file", () => {
  it("creates an owner-only token and reloads it verbatim", () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-token-file-"));
    try {
      const path = join(dir, "nested", "mcp-http.token");
      const created = ensureTokenFile(path);
      expect(created).toHaveLength(64);
      expect(ensureTokenFile(path)).toBe(created);
      expect(readTokenFile(path)).toBe(created);
      expect(readFileSync(path, "utf8")).toContain(created);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a symbolic-link token path", () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-token-file-link-"));
    try {
      const target = join(dir, "target");
      const link = join(dir, "token");
      writeFileSync(target, "a".repeat(64));
      symlinkSync(target, link);
      expect(() => ensureTokenFile(link)).toThrow(/symbolic link/);
      expect(() => readTokenFile(link)).toThrow(/symbolic link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a token that is too short", () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-token-file-short-"));
    try {
      const path = join(dir, "token");
      writeFileSync(path, "deadbeef\n");
      expect(() => ensureTokenFile(path)).toThrow(/invalid/);
      expect(() => readTokenFile(path)).toThrow(/invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
