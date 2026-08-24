import { access, constants } from "node:fs/promises";
import { basename } from "node:path";
import type { WhisperConfig } from "../config.js";
import { execCapture } from "../util/exec.js";
import type {
  SttAdapter,
  TranscriptionRequest,
  TranscriptionResult,
} from "./types.js";

/**
 * ponytail: fixed ceiling instead of a config knob. Local transcription runs at
 * several times real time even on CPU, so 15 minutes only ever fires on a hung
 * process. Make it configurable if a machine ever legitimately needs longer.
 */
const WHISPER_TIMEOUT_MS = 900_000;

/** "…/ggml-large-v3-turbo.bin" -> "large-v3-turbo". */
function modelName(modelPath: string): string {
  return basename(modelPath)
    .replace(/^ggml-/, "")
    .replace(/\.bin$/, "");
}

/**
 * whisper.cpp adapter, used for local development.
 *
 * No business vocabulary: whisper.cpp only offers a weak `--prompt` bias, so
 * `maxLexiconTerms` is 0 and the worker knows nothing will correct "au doux"
 * into "Odoo" here. That correction belongs to a provider adapter, or to the
 * post-correction layer (ADR-0006, Jalon 6).
 *
 * Input must already be 16 kHz mono WAV: whisper.cpp does not decode Opus. The
 * worker converts before calling (rule 5 of `specs/stt-adapter.md`).
 */
export function createWhisperAdapter(config: WhisperConfig): SttAdapter {
  return {
    name: "whisper-local",
    capabilities: {
      soundsLike: false,
      maxLexiconTerms: 0,
      maxDurationS: 3600,
      languages: ["fr", "en"],
      diarization: false,
    },

    async transcribe(
      request: TranscriptionRequest,
    ): Promise<TranscriptionResult> {
      const language = request.language ?? "fr";
      const args = [
        "-m",
        config.modelPath,
        "-f",
        request.audioPath,
        "-l",
        language,
        "-np",
        "-nt",
      ];
      const result = await execCapture(config.binaryPath, args, {
        timeoutMs: WHISPER_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        // stderr is deliberately not propagated: it is an untrusted stream that
        // must never carry transcript fragments into an error message or a log
        // (invariant 6). `healthCheck` covers the failures worth naming.
        throw new Error(`whisper-cli exited with code ${String(result.code)}`);
      }
      return {
        textRaw: result.stdout.trim(),
        language,
        engine: "whisper-local",
        engineModel: modelName(config.modelPath),
        // Nothing else to keep: stdout is the whole response and re-running a
        // local engine costs nothing.
        raw: { model: config.modelPath, args },
      };
    },

    async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
      try {
        await access(config.modelPath, constants.R_OK);
      } catch {
        return {
          ok: false,
          detail: `whisper model not readable at ${config.modelPath}`,
        };
      }
      try {
        await execCapture(config.binaryPath, ["-h"], { timeoutMs: 10_000 });
      } catch {
        return {
          ok: false,
          detail: `whisper binary not runnable: ${config.binaryPath}`,
        };
      }
      return { ok: true };
    },
  };
}
