import { basename, dirname, join } from "node:path";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { loadConfig, resolveConfig } from "../config.js";
import { defaultConfigPath } from "../paths.js";

/**
 * Local configuration surface for whatsapp-conduit: a read/edit CLI over the
 * YAML config. Deliberately not a web server — this is an observe-only bridge
 * and a background HTTP surface is attack surface we do not need.
 *
 * `show` prints the resolved effective config with secrets masked. `set`
 * edits a single key in place, preserving comments, and refuses any change
 * that would break the observe-only posture.
 */

// Mask any leaf whose key names a credential. Broad by design: better to
// over-mask a harmless field than leak a token into a terminal or a log.
const SECRET_KEY = /(?:secret|token|password|passphrase|api[_-]?key)/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        isSecretKey(k) && v !== null && v !== undefined && v !== ""
          ? "***"
          : maskSecrets(v);
    }
    return out;
  }
  return value;
}

/** Flatten to dotted `section.key = value` lines matching the `set` syntax. */
function flatten(value: unknown, prefix: string, out: string[]): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  const rendered = Array.isArray(value) ? JSON.stringify(value) : String(value);
  out.push(`${prefix} = ${rendered}`);
}

export interface ConfigShowOptions {
  configPath?: string;
  json?: boolean;
}

/** Print the resolved effective config (defaults applied), secrets masked. */
export function runConfigShow(options: ConfigShowOptions = {}): void {
  const configPath = options.configPath ?? defaultConfigPath();
  const config = loadConfig(configPath);
  const masked = maskSecrets(config);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(masked, null, 2)}\n`);
    return;
  }
  const lines: string[] = [];
  flatten(masked, "", lines);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** Coerce a CLI string into the scalar type the YAML expects. */
function coerce(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Explicit allowlist of dotted keys `config set` may edit. Anything absent is
 * refused: a new config field is never silently editable until someone decides
 * it is safe. List/section keys are intentionally excluded (see REFUSED_KEYS and
 * the chat-filter note below).
 */
const EDITABLE_KEYS = new Set<string>([
  "transport.name",
  "account.name",
  "account.description",
  "whatsmeow.binary_path",
  "whatsmeow.command_timeout_ms",
  "baileys.print_qr_in_terminal",
  "baileys.browser_name",
  "privacy.store_message_text",
  "privacy.store_raw_json",
  "privacy.store_media",
  "privacy.include_groups",
  "privacy.include_status",
  "media.max_audio_duration_s",
  "media.max_audio_bytes",
  "media.max_attempts",
  "mcp.max_result_chars",
  // Transcription settings the local dashboard may write (ADR-0017). Engine
  // paths stay out: they are install-time facts, not user settings.
  "stt.enabled",
  "stt.language",
  "stt.whisper.model_path",
  "web.enabled",
  "web.port",
  "exports.redact_phone_numbers",
  "exports.include_raw_json",
  "logging.level",
  "logging.baileys_level",
  "logging.baileys_log_message_text",
  "logging.log_message_text",
]);

/**
 * Keys that would weaken the observe-only posture. Refused *by name*, before any
 * mutation — never silently editable, and never "written then rolled back". The
 * value is the reason surfaced to the user.
 */
const REFUSED_KEYS = new Map<string, string>([
  ["privacy.observe_only", "observe-only must stay enabled"],
  ["privacy.send_enabled", "sending must stay disabled"],
  ["privacy.mark_read", "messages must never be marked read"],
  [
    "baileys.mark_online_on_connect",
    "the linked device must never announce presence",
  ],
  [
    "baileys.sync_full_history",
    "full-history sync is a deliberate choice, edit the config file directly",
  ],
]);

/** Write via a temp file + rename so a crash never leaves a half-written config. */
function atomicWrite(path: string, contents: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permission semantics.
  }
}

export interface ConfigSetOptions {
  configPath?: string;
}

/**
 * Set one dotted config key (e.g. `logging.level`). Only keys on the explicit
 * {@link EDITABLE_KEYS} allowlist may be written; posture-weakening keys are
 * refused by name (see {@link REFUSED_KEYS}) before anything touches disk.
 * Chat filters are lists managed via `chats allow`/`chats block`, not here.
 *
 * This is the single write path for the config file: every caller goes through
 * it, the dashboard included, so the allowlist and the refusals cannot be
 * sidestepped by a second writer.
 */
export function setConfigValue(
  key: string,
  rawValue: string,
  configPath: string,
): void {
  const refusal = REFUSED_KEYS.get(key);
  if (refusal) {
    throw new Error(
      `Refusing to set "${key}": ${refusal}. This observe-only invariant ` +
        "cannot be changed via `config set`.",
    );
  }
  if (!EDITABLE_KEYS.has(key)) {
    throw new Error(
      `"${key}" is not editable via \`config set\`. ` +
        "Run `whatsapp-conduit config show` to list keys; chat filters are " +
        "managed with `chats allow`/`chats block`.",
    );
  }

  const doc = parseDocument(readFileSync(configPath, "utf8"));
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    throw new Error(
      `Config at ${configPath} is not valid YAML: ${first?.message ?? "parse error"}`,
    );
  }

  const path = key.split(".");
  doc.setIn(path, coerce(rawValue));

  // Defense in depth: resolveConfig throws on conflicting safety settings
  // (e.g. observe_only + send_enabled) before the edit reaches disk.
  resolveConfig(doc.toJS());

  // String(doc) re-serializes with the original comments preserved.
  atomicWrite(configPath, String(doc));
}

/** CLI wrapper: write the value, then report it with secrets masked. */
export function runConfigSet(
  key: string,
  rawValue: string,
  options: ConfigSetOptions = {},
): void {
  const configPath = options.configPath ?? defaultConfigPath();
  setConfigValue(key, rawValue, configPath);
  const path = key.split(".");
  const shown = isSecretKey(path[path.length - 1] ?? "")
    ? "***"
    : String(coerce(rawValue));
  process.stdout.write(`Set ${key} = ${shown}\n`);
}
