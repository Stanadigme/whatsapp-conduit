import type { Database } from "better-sqlite3";
import { loadConfig } from "../config.js";
import { setConfigValue } from "../commands/config.js";
import {
  countTranscriptionQueue,
  listTranscriptionFailures,
} from "../db/queries.js";
import { hasTable } from "../mcp/types.js";
import { createSttAdapter } from "../stt/index.js";
import {
  listInstalledModels,
  modelsDir,
  MODEL_CATALOGUE,
  type InstalledModel,
} from "../stt/models.js";
import { readSttStatus, sttStatusPath } from "../stt/status.js";
import type { ModelDownloadState } from "./models.js";

/** A worker that has not stamped its heartbeat for this long is not running. */
const WORKER_STALE_S = 120;

export const STT_LANGUAGES = ["fr", "en", "auto"] as const;
export type SttLanguage = (typeof STT_LANGUAGES)[number];

export interface SttViewContext {
  db: Database;
  configPath: string;
  accountId: string;
  download: ModelDownloadState;
}

export interface SttView {
  enabled: boolean;
  language: string;
  modelPath: string;
  modelInstalled: boolean;
  models: InstalledModel[];
  catalogue: Array<{
    id: string;
    label: string;
    note: string;
    sizeBytes: number;
    installed: boolean;
  }>;
  engine: {
    name: string;
    binaryPath: string;
    ffmpegPath: string;
    modelsDir: string;
  };
  worker: {
    running: boolean;
    lastPassAt: number | null;
    lastError: string | null;
  };
  queue: { pending: number; failed: number } | null;
  failures: Array<{
    chatJid: string;
    messageId: string;
    reason: string | null;
  }>;
  download: ModelDownloadState;
}

/**
 * Assemble everything the transcription card shows.
 *
 * The config is re-read from disk rather than taken from the dashboard's
 * startup snapshot, so a value written a second ago is the value displayed.
 */
export async function sttView(context: SttViewContext): Promise<SttView> {
  const config = loadConfig(context.configPath);
  const directory = modelsDir(config);
  const installed = listInstalledModels(directory);
  const status = await readSttStatus(sttStatusPath(config));
  const now = Math.floor(Date.now() / 1000);

  const hasQueue =
    hasTable(context.db, "transcriptions") &&
    hasTable(context.db, "transcription_jobs");

  return {
    enabled: config.stt.enabled,
    language: config.stt.language,
    modelPath: config.stt.whisper.modelPath,
    modelInstalled: installed.some(
      (model) => model.path === config.stt.whisper.modelPath,
    ),
    models: installed,
    catalogue: MODEL_CATALOGUE.map((model) => ({
      id: model.id,
      label: model.label,
      note: model.note,
      sizeBytes: model.sizeBytes,
      installed: installed.some((candidate) => candidate.file === model.file),
    })),
    engine: {
      name: config.stt.engine,
      binaryPath: config.stt.whisper.binaryPath,
      ffmpegPath: config.stt.ffmpegPath,
      modelsDir: directory,
    },
    worker: {
      running: status !== null && now - status.lastPassAt <= WORKER_STALE_S,
      lastPassAt: status?.lastPassAt ?? null,
      lastError: status?.lastError ?? null,
    },
    queue: hasQueue
      ? countTranscriptionQueue(
          context.db,
          context.accountId,
          config.stt.maxAttempts,
        )
      : null,
    failures: hasQueue
      ? listTranscriptionFailures(context.db, context.accountId, 5).map(
          (row) => ({
            chatJid: row.chat_jid,
            messageId: row.message_id,
            reason: row.reason,
          }),
        )
      : [],
    download: context.download,
  };
}

/**
 * Validate and write the three transcription settings the dashboard owns.
 *
 * Three named fields, hard-coded. Never a generic "write this config key"
 * relay: `EDITABLE_KEYS` also holds `privacy.store_media` and
 * `logging.log_message_text`, and a generic route would hand those to a web
 * page. The model path is checked against a scan of the models directory
 * because it becomes the `-m` argument of a locally spawned process.
 */
export function applySttSettings(
  configPath: string,
  params: URLSearchParams,
): void {
  const known = new Set(["enabled", "language", "modelPath"]);
  for (const key of params.keys()) {
    if (!known.has(key)) {
      throw new Error(`cannot set unknown transcription setting "${key}"`);
    }
  }

  const writes: Array<[string, string]> = [];

  const enabled = params.get("enabled");
  if (enabled !== null) {
    if (enabled !== "true" && enabled !== "false") {
      throw new Error("enabled must be true or false");
    }
    writes.push(["stt.enabled", enabled]);
  }

  const language = params.get("language");
  if (language !== null) {
    if (!STT_LANGUAGES.includes(language as SttLanguage)) {
      throw new Error(`language must be one of ${STT_LANGUAGES.join(", ")}`);
    }
    writes.push(["stt.language", language]);
  }

  const modelPath = params.get("modelPath");
  if (modelPath !== null) {
    const config = loadConfig(configPath);
    const installed = listInstalledModels(modelsDir(config));
    if (!installed.some((model) => model.path === modelPath)) {
      throw new Error("cannot select a model that is not installed");
    }
    writes.push(["stt.whisper.model_path", modelPath]);
  }

  if (writes.length === 0) throw new Error("nothing to set");
  for (const [key, value] of writes) {
    setConfigValue(key, value, configPath);
  }
}

/** Run the engine's own health check against the current configuration. */
export async function sttHealth(
  configPath: string,
): Promise<{ ok: boolean; detail?: string }> {
  return createSttAdapter(loadConfig(configPath)).healthCheck();
}
