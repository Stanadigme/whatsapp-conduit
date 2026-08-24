import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { appLogger, resolveConfigPath } from "../runtime.js";
import { createSttAdapter } from "../stt/index.js";
import { runTranscribeLoop, transcribeOnce } from "../stt/worker.js";

export interface TranscribeOptions {
  configPath?: string;
  /** Run a single pass and exit instead of polling. */
  once?: boolean;
  /** Only report whether the engine is usable, then exit. */
  check?: boolean;
}

/**
 * Transcribe downloaded voice notes.
 *
 * Deliberately a separate command from `run`: transcription is slow and
 * fallible, and `docs/02-architecture.md` requires it to be stoppable and
 * restartable without touching ingestion. The database is in WAL mode, so both
 * processes can write.
 *
 * In polling mode the worker starts even when transcription is disabled: it
 * keeps stamping its heartbeat so the dashboard can tell "switched off" from
 * "nobody is running the worker", and it picks the setting up when it changes.
 */
export async function runTranscribe(
  options: TranscribeOptions = {},
): Promise<void> {
  const configPath = resolveConfigPath(options.configPath);
  const config = loadConfig(configPath);
  const adapter = createSttAdapter(config);

  if (options.check) {
    const health = await adapter.healthCheck();
    process.stdout.write(
      `${adapter.name}: ${health.ok ? "ok" : `unavailable — ${health.detail ?? "unknown reason"}`}\n`,
    );
    if (!health.ok) process.exitCode = 1;
    return;
  }

  if (!existsSync(config.paths.sqlite)) {
    throw new Error("Database not found. Run `whatsapp-conduit init` first.");
  }

  const log = appLogger(config);
  const db = openDb(config.paths.sqlite, { migrate: true });

  try {
    if (options.once) {
      // One-shot is an explicit request: refuse loudly rather than doing
      // nothing because a setting is off or the engine is missing.
      if (!config.stt.enabled) {
        throw new Error(
          "Transcription is disabled. Set `stt.enabled: true` in the config, or enable it from the dashboard.",
        );
      }
      const health = await adapter.healthCheck();
      if (!health.ok) {
        throw new Error(health.detail ?? `${adapter.name} is not available`);
      }
      const pass = await transcribeOnce({
        db,
        config,
        accountId: config.account.name,
        adapter,
        logger: log,
      });
      process.stdout.write(
        `done=${pass.done} failed=${pass.failed} skipped=${pass.skipped}\n`,
      );
      return;
    }

    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    log.info(
      { engine: adapter.name, enabled: config.stt.enabled },
      "transcription worker started",
    );
    try {
      await runTranscribeLoop(
        { db, configPath, accountId: config.account.name, logger: log },
        controller.signal,
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    db.close();
  }
}
