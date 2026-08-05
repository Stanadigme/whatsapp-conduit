import type { Logger } from "pino";
import type { Config } from "./config.js";
import { defaultConfigPath } from "./paths.js";
import { createLogger } from "./util/logging.js";

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
 * sometimes requires Baileys' info/debug records. Message-content fields stay
 * redacted by the logger; operators must still treat debug output as sensitive
 * because Baileys can include authentication and protocol details.
 */
export function baileysLogger(config: Config): Logger {
  return createLogger({
    level: config.logging.baileysLevel,
    logMessageText: false,
  });
}
