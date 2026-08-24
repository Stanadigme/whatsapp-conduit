import { createHash } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { modelUrl, type CatalogueModel } from "../stt/models.js";

export type ModelDownloadStatus =
  | "idle"
  | "downloading"
  | "verifying"
  | "done"
  | "failed";

export interface ModelDownloadState {
  status: ModelDownloadStatus;
  modelId: string | null;
  receivedBytes: number;
  totalBytes: number;
  error: string | null;
}

/**
 * One-at-a-time model download, held in memory like the pairing controller.
 *
 * Downloading a model is the one place this project reaches a host other than
 * WhatsApp (invariant 7). It is bounded on purpose: never automatic, always a
 * human clicking, a single pinned host, and — the part that actually protects
 * anything — a pinned SHA-256 checked before the file is installed. HuggingFace
 * redirects to a CDN, so the final host cannot be pinned; the digest is the
 * guarantee, not the origin.
 *
 * ponytail: no resume and no cancel. A failed download restarts from zero.
 * Revisit if someone pulls 1.6 GB over an unreliable link.
 */
export class ModelDownloader {
  private state: ModelDownloadState = {
    status: "idle",
    modelId: null,
    receivedBytes: 0,
    totalBytes: 0,
    error: null,
  };

  constructor(private readonly directory: string) {}

  get snapshot(): ModelDownloadState {
    return { ...this.state };
  }

  get busy(): boolean {
    return (
      this.state.status === "downloading" || this.state.status === "verifying"
    );
  }

  /** Start a download. Returns immediately; progress is polled. */
  start(model: CatalogueModel): void {
    if (this.busy) {
      throw new Error("a model download is already running");
    }
    this.state = {
      status: "downloading",
      modelId: model.id,
      receivedBytes: 0,
      totalBytes: model.sizeBytes,
      error: null,
    };
    void this.run(model).catch((error: unknown) => {
      this.state = {
        ...this.state,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    });
  }

  private async run(model: CatalogueModel): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, model.file);
    const partial = join(this.directory, `.${model.file}.part`);

    const response = await fetch(modelUrl(model));
    if (!response.ok || !response.body) {
      throw new Error(`download failed with status ${String(response.status)}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 0) {
      this.state = { ...this.state, totalBytes: declared };
    }

    const digest = createHash("sha256");
    const handle = await open(partial, "w");
    try {
      for await (const chunk of response.body) {
        digest.update(chunk);
        await handle.write(chunk);
        this.state = {
          ...this.state,
          receivedBytes: this.state.receivedBytes + chunk.length,
        };
      }
    } finally {
      await handle.close();
    }

    this.state = { ...this.state, status: "verifying" };
    const actual = digest.digest("hex");
    if (actual !== model.sha256) {
      await unlink(partial).catch(() => undefined);
      throw new Error(
        "checksum mismatch: the downloaded file was discarded, nothing installed",
      );
    }

    // Rename last: a file present under its final name is a verified file.
    await rename(partial, target);
    this.state = { ...this.state, status: "done" };
  }
}
