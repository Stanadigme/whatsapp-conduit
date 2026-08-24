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
import { ensureDashboardToken } from "../src/dashboard/token.js";

describe("dashboard token", () => {
  it("creates and reloads an owner-only token", () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-token-"));
    try {
      const path = join(dir, "dashboard.token");
      const first = ensureDashboardToken(path);
      const second = ensureDashboardToken(path);
      expect(first).toHaveLength(64);
      expect(second).toBe(first);
      expect(readFileSync(path, "utf8")).toContain(first);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a symbolic-link token path", () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-dashboard-token-link-"));
    const target = join(dir, "target");
    const link = join(dir, "token");
    writeFileSync(target, "a".repeat(64));
    symlinkSync(target, link);
    expect(() => ensureDashboardToken(link)).toThrow(/symbolic link/);
    rmSync(dir, { recursive: true, force: true });
  });
});
