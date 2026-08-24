import type { Config } from "../config.js";
import { createWhisperAdapter } from "./whisper.js";
import type { SttAdapter } from "./types.js";

/**
 * Resolve the configured engine.
 *
 * This is the extension point for production engines: a Speechmatics or Gladia
 * adapter implements `SttAdapter`, gets a name in `SttEngineName`, and is added
 * to this switch. Nothing in the worker changes. Their API key will live in an
 * owner-only file, never in the config or the database (ADR-0016).
 */
export function createSttAdapter(config: Config): SttAdapter {
  switch (config.stt.engine) {
    case "whisper-local":
      return createWhisperAdapter(config.stt.whisper);
  }
}

export type { SttAdapter } from "./types.js";
