import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGcsBucket, gcsObjectKey } from "../src/db/gcs.js";

describe("gcsObjectKey", () => {
  it("is content-addressed, mirroring the local cache filename scheme", () => {
    const sha256 = "a".repeat(64);
    expect(
      gcsObjectKey("personal", sha256, {
        mimeType: "audio/ogg",
        fileName: null,
      }),
    ).toBe(`personal/${sha256}.opus`);
    expect(
      gcsObjectKey("personal", sha256, {
        mimeType: null,
        fileName: "photo.jpg",
      }),
    ).toBe(`personal/${sha256}.jpg`);
  });

  it("never embeds a chat JID or message id", () => {
    const key = gcsObjectKey("personal", "b".repeat(64), {
      mimeType: "image/png",
      fileName: null,
    });
    expect(key).not.toContain("@");
  });
});

describe("createGcsBucket credentials file checks", () => {
  it("refuses a credentials file readable by group or others", () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-gcs-"));
    const path = join(dir, "creds.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    expect(() =>
      createGcsBucket({ bucket: "test-bucket", credentialsFile: path }),
    ).toThrow("must not be readable by group or others");
  });

  it("refuses a symlinked credentials file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-gcs-"));
    const real = join(dir, "real-creds.json");
    const link = join(dir, "creds.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    symlinkSync(real, link);
    expect(() =>
      createGcsBucket({ bucket: "test-bucket", credentialsFile: link }),
    ).toThrow("must not be a symbolic link");
  });

  it("accepts an owner-only credentials file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-gcs-"));
    const path = join(dir, "creds.json");
    writeFileSync(path, "{}", { mode: 0o600 });
    expect(() =>
      createGcsBucket({ bucket: "test-bucket", credentialsFile: path }),
    ).not.toThrow();
  });
});
