import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import { loadConfig, type Config } from "../config.js";
import {
  insertTranscription,
  listTranscriptionCandidates,
  upsertTranscriptionJob,
  type TranscriptionCandidateRow,
} from "../db/queries.js";
import { execCapture } from "../util/exec.js";
import { createSttAdapter } from "./index.js";
import { sttStatusPath, writeSttStatus } from "./status.js";
import type { SttAdapter } from "./types.js";

const BATCH_LIMIT = 20;
const POLL_INTERVAL_MS = 10_000;
/** Whisper hallucinates on near-silence; a sub-second clip is not worth it. */
const MIN_DURATION_S = 1;
const FFMPEG_TIMEOUT_MS = 120_000;

export interface TranscribeWorkerDeps {
  db: Database;
  config: Config;
  accountId: string;
  adapter: SttAdapter;
  logger: Logger;
}

export interface TranscribePassResult {
  done: number;
  failed: number;
  skipped: number;
  /**
   * Set when the engine was unusable and the pass did nothing. The pending
   * voice notes are left untouched: burning their attempts against a missing
   * model would mark them failed for good, and installing the model later
   * would not bring them back.
   */
  blocked?: string;
}

/**
 * Decode to the 16 kHz mono WAV every engine accepts.
 *
 * Done once here rather than in each adapter (rule 5 of
 * `specs/stt-adapter.md`): WhatsApp ships Opus, whisper.cpp reads WAV only.
 */
async function toWav(
  config: Config,
  source: string,
  directory: string,
): Promise<string> {
  const target = join(directory, "audio.wav");
  const result = await execCapture(
    config.stt.ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      source,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      target,
    ],
    { timeoutMs: FFMPEG_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    throw new Error(`ffmpeg exited with code ${String(result.code)}`);
  }
  return target;
}

/** Guardrails owned by the worker, not the adapter. */
function skipReason(
  config: Config,
  row: TranscriptionCandidateRow,
): string | null {
  if (row.duration_s === null) return null;
  if (row.duration_s > config.media.maxAudioDurationS) return "audio too long";
  if (row.duration_s < MIN_DURATION_S) return "audio too short";
  return null;
}

async function transcribeOne(
  deps: TranscribeWorkerDeps,
  row: TranscriptionCandidateRow,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "wa-stt-"));
  try {
    const wav = await toWav(deps.config, row.file_path, directory);
    const result = await deps.adapter.transcribe({
      audioPath: wav,
      durationS: row.duration_s,
      language: deps.config.stt.language,
      // ponytail: inert until the lexicon layer lands (Jalon 6).
      lexicon: [],
      lexiconVersion: 0,
    });
    insertTranscription(deps.db, {
      accountId: deps.accountId,
      chatJid: row.chat_jid,
      messageId: row.message_id,
      audioSha256: row.sha256,
      textRaw: result.textRaw,
      language: result.language,
      confidence: result.confidence ?? null,
      engine: result.engine,
      engineModel: result.engineModel,
      durationS: row.duration_s,
      costUsd: result.costUsd ?? null,
      rawJson: JSON.stringify(result.raw),
    });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Run one pass over the pending voice notes.
 *
 * There is no ingestion-side hook: the worker polls for downloaded audio that
 * has no transcription. That is self-healing (it catches anything a hook would
 * have missed on a crash or a restart) and leaves the ingestion path untouched.
 *
 * Nothing here logs transcript text (invariant 6): counters only.
 */
export async function transcribeOnce(
  deps: TranscribeWorkerDeps,
): Promise<TranscribePassResult> {
  const result: TranscribePassResult = { done: 0, failed: 0, skipped: 0 };
  const candidates = listTranscriptionCandidates(deps.db, {
    accountId: deps.accountId,
    maxAttempts: deps.config.stt.maxAttempts,
    limit: BATCH_LIMIT,
  });

  if (candidates.length > 0) {
    const health = await deps.adapter.healthCheck();
    if (!health.ok) {
      return { ...result, blocked: health.detail ?? "engine unavailable" };
    }
  }

  for (const row of candidates) {
    const skip = skipReason(deps.config, row);
    if (skip !== null) {
      upsertTranscriptionJob(deps.db, {
        accountId: deps.accountId,
        chatJid: row.chat_jid,
        messageId: row.message_id,
        status: "skipped",
        reason: skip,
        attempts: row.attempts,
      });
      result.skipped += 1;
      continue;
    }

    // Count the attempt when it is claimed, not when it ends: a process killed
    // mid-job must not let the same file loop forever.
    const attempts = row.attempts + 1;
    upsertTranscriptionJob(deps.db, {
      accountId: deps.accountId,
      chatJid: row.chat_jid,
      messageId: row.message_id,
      status: "running",
      attempts,
    });

    try {
      await transcribeOne(deps, row);
      upsertTranscriptionJob(deps.db, {
        accountId: deps.accountId,
        chatJid: row.chat_jid,
        messageId: row.message_id,
        status: "done",
        attempts,
      });
      result.done += 1;
    } catch (error) {
      upsertTranscriptionJob(deps.db, {
        accountId: deps.accountId,
        chatJid: row.chat_jid,
        messageId: row.message_id,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        attempts,
      });
      result.failed += 1;
      deps.logger.warn(
        { attempts, engine: deps.adapter.name },
        "transcription failed",
      );
    }
  }

  return result;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface TranscribeLoopDeps {
  db: Database;
  /** Reloaded on every pass so dashboard edits apply without a restart. */
  configPath: string;
  accountId: string;
  logger: Logger;
}

/**
 * Poll until aborted, one job at a time: a local engine already saturates the
 * machine, and a single worker is what makes the claim in
 * `listTranscriptionCandidates` safe.
 *
 * The configuration is re-read at the top of every pass. It is a 2 KB file
 * parsed every ten seconds, which costs nothing next to a transcription, and it
 * removes the need for any reload mechanism.
 */
export async function runTranscribeLoop(
  deps: TranscribeLoopDeps,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    let lastError: string | null = null;
    let config: Config | null = null;
    let engine = "unknown";

    try {
      config = loadConfig(deps.configPath);
      engine = config.stt.engine;
      if (config.stt.enabled) {
        const adapter = createSttAdapter(config);
        engine = adapter.name;
        const pass = await transcribeOnce({
          db: deps.db,
          config,
          accountId: deps.accountId,
          adapter,
          logger: deps.logger,
        });
        if (pass.blocked !== undefined) {
          lastError = pass.blocked;
          deps.logger.warn({ engine }, "transcription engine unavailable");
        } else if (pass.done > 0 || pass.failed > 0 || pass.skipped > 0) {
          deps.logger.info(
            {
              done: pass.done,
              failed: pass.failed,
              skipped: pass.skipped,
              engine,
            },
            "transcribed",
          );
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      deps.logger.warn({ engine }, "transcription pass failed");
    }

    if (config) {
      await writeSttStatus(sttStatusPath(config), {
        enabled: config.stt.enabled,
        engine,
        lastError,
      }).catch(() => undefined);
    }

    if (signal?.aborted) break;
    await sleep(POLL_INTERVAL_MS, signal);
  }
}
