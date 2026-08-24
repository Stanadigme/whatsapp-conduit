import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelDownloader } from "../src/dashboard/models.js";
import { listInstalledModels, type CatalogueModel } from "../src/stt/models.js";

const payload = new TextEncoder().encode("pretend this is a ggml model");
const realDigest = createHash("sha256").update(payload).digest("hex");

function model(sha256: string): CatalogueModel {
  return {
    id: "base",
    file: "ggml-base.bin",
    label: "Rapide",
    note: "test",
    sizeBytes: payload.byteLength,
    sha256,
  };
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(payload, {
        headers: { "content-length": String(payload.byteLength) },
      }),
  );
}

async function settle(downloader: ModelDownloader): Promise<void> {
  for (let attempt = 0; attempt < 100 && downloader.busy; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model download", () => {
  it("installs a model whose digest matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-models-"));
    try {
      stubFetch();
      const downloader = new ModelDownloader(dir);
      downloader.start(model(realDigest));
      await settle(downloader);

      expect(downloader.snapshot.status).toBe("done");
      expect(listInstalledModels(dir).map((entry) => entry.file)).toEqual([
        "ggml-base.bin",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs nothing when the digest does not match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-models-"));
    try {
      stubFetch();
      const downloader = new ModelDownloader(dir);
      downloader.start(model("0".repeat(64)));
      await settle(downloader);

      const state = downloader.snapshot;
      expect(state.status).toBe("failed");
      expect(state.error).toContain("checksum mismatch");
      // Neither the final name nor the partial file survives.
      expect(readdirSync(dir)).toEqual([]);
      expect(listInstalledModels(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a second download while one is running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-models-"));
    try {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response(payload)), 50),
          ),
      );
      const downloader = new ModelDownloader(dir);
      downloader.start(model(realDigest));
      expect(() => downloader.start(model(realDigest))).toThrow(
        /already running/,
      );
      await settle(downloader);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a failed request without leaving a file behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wac-models-"));
    try {
      vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
      const downloader = new ModelDownloader(dir);
      downloader.start(model(realDigest));
      await settle(downloader);

      expect(downloader.snapshot.status).toBe("failed");
      expect(listInstalledModels(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
