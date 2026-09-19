import type { Logger } from "pino";
import type { Config } from "./config.js";
import { defaultConfigPath } from "./paths.js";
import { contentSafeLevel, createLogger } from "./util/logging.js";

/** Resolve the effective config path from a CLI `--config` override. */
export function resolveConfigPath(configPath?: string): string {
  return configPath ?? defaultConfigPath();
}

/** Application logger honoring the configured level and redaction policy. */
export function appLogger(config: Config): Logger {
  return createLogger({
    level: config.logging.level,
    logMessageText: config.logging.logMessageText,
  });
}

/**
 * Logger handed to Baileys. Its level is explicit because protocol diagnosis
 * sometimes requires Baileys' info/debug records, but Baileys emits message
 * content and pairing key material below `warn`: the configured level is
 * clamped by `contentSafeLevel` unless `baileys_log_message_text` is on
 * (invariant n°6). Full payload logging stays an explicit separate switch.
 */
export function baileysLogger(config: Config): Logger {
  return createLogger({
    level: contentSafeLevel(
      config.logging.baileysLevel,
      config.logging.baileysLogMessageText,
    ),
    logMessageText: config.logging.baileysLogMessageText,
  });
}
