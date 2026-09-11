import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { getOrCreateGcsBucket, gcsObjectKey, uploadMediaToGcs } from "../db/gcs.js";
import { fromAttachmentRow, resolveLocalMediaFile } from "../db/media-serving.js";
import { upsertAttachment, type AttachmentRow } from "../db/queries.js";
import {
  configurePostgresProjection,
  flushPostgresProjection,
  shutdownPostgresProjection,
} from "../db/postgres-projection.js";
import { defaultConfigPath } from "../paths.js";
import { appLogger } from "../runtime.js";

export interface GcsImportOptions {
  configPath?: string | undefined;
  json?: boolean | undefined;
}

export interface GcsImportReport {
  uploaded: number;
  missingLocalFile: number;
  failed: number;
}

/**
 * Backfill media downloaded before `persistence.gcs` was configured: uploads
 * every locally-cached attachment GCS has not confirmed yet, then records
 * `gcs_uploaded_at` the same way the live upload path does
 * (src/ingest/audio.ts) — the moment that column is set, media-serving.ts's
 * attachmentAvailable stops trusting the local file and only GCS. Safe to run
 * more than once: already-confirmed attachments are excluded by the query.
 *
 * ponytail: sequential uploads, one at a time — fine for a pilot's existing
 * cache, batch/parallelize if a large backlog ever makes this slow.
 */
export async function runGcsImport(
  options: GcsImportOptions = {},
): Promise<GcsImportReport> {
  const config = loadConfig(options.configPath ?? defaultConfigPath());
  const gcs = config.persistence.gcs;
  if (!gcs) {
    throw new Error(
      "No GCS bucket configured. Set persistence.gcs in the config file first.",
    );
  }
  if (!existsSync(config.paths.sqlite)) {
    throw new Error("Database not found. Run `whatsapp-conduit init` first.");
  }

  const accountId = config.account.name;
  const db = openDb(config.paths.sqlite, { migrate: false });
  const logger = appLogger(config);
  configurePostgresProjection(config, logger);
  try {
    const rows = db
      .prepare<[string], AttachmentRow>(
        `select * from attachments
         where account_id = ? and downloaded_at is not null and gcs_uploaded_at is null`,
      )
      .all(accountId);

    const bucket = getOrCreateGcsBucket(gcs);
    const report: GcsImportReport = {
      uploaded: 0,
      missingLocalFile: 0,
      failed: 0,
    };
    for (const row of rows) {
      const meta = fromAttachmentRow(row);
      const local = resolveLocalMediaFile(config, meta);
      if (!local || !meta.sha256) {
        report.missingLocalFile += 1;
        continue;
      }
      try {
        const objectKey = gcsObjectKey(accountId, meta.sha256, meta);
        await uploadMediaToGcs(bucket, objectKey, local.path, meta.mimeType);
        upsertAttachment(db, {
          accountId,
          chatJid: row.chat_jid,
          messageId: row.message_id,
          attachmentIndex: row.attachment_index,
          sha256: meta.sha256,
          gcsUploadedAt: Math.floor(Date.now() / 1000),
        });
        report.uploaded += 1;
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "gcs media import failed for one attachment",
        );
        report.failed += 1;
      }
    }
    await flushPostgresProjection();

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Uploaded ${String(report.uploaded)} attachment(s) to GCS ` +
          `(${String(report.missingLocalFile)} missing locally, ${String(report.failed)} failed).\n`,
      );
    }
    return report;
  } finally {
    await shutdownPostgresProjection();
    db.close();
  }
}
