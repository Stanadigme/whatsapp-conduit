import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultDataDir } from "./paths.js";
import { LOG_LEVELS, type LogLevel } from "./util/logging.js";

export type ExportFormat = "jsonl";
export type BaileysVersion = [number, number, number];
export type TransportName = "whatsmeow" | "baileys";

export const DEFAULT_BAILEYS_VERSION: BaileysVersion = [2, 3000, 1033893291];

export interface AccountConfig {
  name: string;
  description?: string;
}

export interface PathsConfig {
  dataDir: string;
  sqlite: string;
  authDir: string;
  mediaDir: string;
  whatsmeowStore: string;
  runtimeStatus: string;
  controlSocket: string;
}

export interface WhatsmeowConfig {
  binaryPath?: string;
  commandTimeoutMs: number;
}

export interface MediaConfig {
  maxAudioDurationS: number;
  maxAudioBytes: number;
  maxAttempts: number;
}

export interface McpConfig {
  maxResultChars: number;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
  tokenFile: string;
}

export interface BaileysConfig {
  version: BaileysVersion;
  printQrInTerminal: boolean;
  syncFullHistory: boolean;
  markOnlineOnConnect: boolean;
  browserName: string;
}

export interface PrivacyConfig {
  observeOnly: boolean;
  sendEnabled: boolean;
  markRead: boolean;
  storeMessageText: boolean;
  storeRawJson: boolean;
  storeMedia: boolean;
  includeGroups: boolean;
  includeStatus: boolean;
}

export interface FiltersConfig {
  allowedChats: string[];
  blockedChats: string[];
  allowedSenders: string[];
  blockedSenders: string[];
}

export interface ExportsConfig {
  defaultFormat: ExportFormat;
  redactPhoneNumbers: boolean;
  includeRawJson: boolean;
}

export interface LoggingConfig {
  level: LogLevel;
  /**
   * Baileys logger level. Kept independently configurable because debug-level
   * Baileys output can contain protocol and authentication diagnostics.
   */
  baileysLevel: LogLevel;
  /** Allow the Baileys logger to emit message and protocol payload fields. */
  baileysLogMessageText: boolean;
  logMessageText: boolean;
}

export interface Config {
  transport: TransportName;
  account: AccountConfig;
  paths: PathsConfig;
  whatsmeow: WhatsmeowConfig;
  baileys: BaileysConfig;
  privacy: PrivacyConfig;
  media: MediaConfig;
  mcp: McpConfig;
  web: WebConfig;
  filters: FiltersConfig;
  exports: ExportsConfig;
  logging: LoggingConfig;
}

/** Options that influence how a raw config is resolved into a full {@link Config}. */
export interface ResolveOptions {
  /** Override the data directory (e.g. from `init --data-dir`). */
  dataDir?: string;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const candidate =
    typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : value;
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate > 0
    ? candidate
    : fallback;
}

function asPort(value: unknown, fallback: number): number {
  const candidate =
    typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : value;
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 0 &&
    candidate <= 65_535
    ? candidate
    : fallback;
}

function asLoopbackHost(value: unknown, fallback = "127.0.0.1"): string {
  if (value === "127.0.0.1" || value === "::1") return value;
  if (value === undefined || value === null || value === "") return fallback;
  throw new Error("Invalid web.host: only 127.0.0.1 and ::1 are allowed.");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asLogLevel(value: unknown, fallback: LogLevel): LogLevel {
  return LOG_LEVELS.includes(value as LogLevel)
    ? (value as LogLevel)
    : fallback;
}

function asTransport(value: unknown): TransportName {
  return value === "baileys" ? "baileys" : "whatsmeow";
}

function asBaileysVersion(
  value: unknown,
  fallback: BaileysVersion,
): BaileysVersion {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (part) => typeof part === "number" && Number.isInteger(part) && part >= 0,
    )
  ) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  return [...fallback];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function section(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = raw[key];
  return isRecord(value) ? value : {};
}

function resolvePath(base: string, value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) {
    return isAbsolute(value) ? value : resolve(base, value);
  }
  return fallback;
}

/**
 * Resolve a parsed YAML config object into a fully-populated {@link Config}
 * with absolute paths and observe-only-safe defaults applied.
 *
 * Throws on conflicting safety settings rather than silently picking one.
 */
export function resolveConfig(
  rawInput: unknown,
  options: ResolveOptions = {},
): Config {
  const raw = isRecord(rawInput) ? rawInput : {};

  const transportRaw = section(raw, "transport");
  const accountRaw = section(raw, "account");
  const pathsRaw = section(raw, "paths");
  const whatsmeowRaw = section(raw, "whatsmeow");
  const baileysRaw = section(raw, "baileys");
  const privacyRaw = section(raw, "privacy");
  const mediaRaw = section(raw, "media");
  const mcpRaw = section(raw, "mcp");
  const webRaw = section(raw, "web");
  const filtersRaw = section(raw, "filters");
  const exportsRaw = section(raw, "exports");
  const loggingRaw = section(raw, "logging");

  // Resolve to an absolute path so paths derived from it are stable regardless
  // of the cwd a later command (e.g. a systemd service) runs from.
  const dataDir = resolve(
    options.dataDir ?? asString(pathsRaw.data_dir, defaultDataDir()),
  );

  const paths: PathsConfig = {
    dataDir,
    sqlite: resolvePath(
      dataDir,
      pathsRaw.sqlite,
      join(dataDir, "whatsapp-conduit.db"),
    ),
    authDir: resolvePath(dataDir, pathsRaw.auth_dir, join(dataDir, "auth")),
    mediaDir: resolvePath(dataDir, pathsRaw.media_dir, join(dataDir, "media")),
    whatsmeowStore: resolvePath(
      dataDir,
      pathsRaw.whatsmeow_store,
      join(dataDir, "whatsmeow.db"),
    ),
    runtimeStatus: resolvePath(
      dataDir,
      pathsRaw.runtime_status,
      join(dataDir, "runtime-status.json"),
    ),
    controlSocket: resolvePath(
      dataDir,
      pathsRaw.control_socket,
      join(
        dataDir,
        process.platform === "win32" ? "control.pipe" : "control.sock",
      ),
    ),
  };

  const privacy: PrivacyConfig = {
    observeOnly: asBool(privacyRaw.observe_only, true),
    sendEnabled: asBool(privacyRaw.send_enabled, false),
    markRead: asBool(privacyRaw.mark_read, false),
    storeMessageText: asBool(privacyRaw.store_message_text, true),
    storeRawJson: asBool(privacyRaw.store_raw_json, true),
    storeMedia: asBool(privacyRaw.store_media, false),
    includeGroups: asBool(privacyRaw.include_groups, false),
    includeStatus: asBool(privacyRaw.include_status, false),
  };

  // Safety invariant: observe-only and sending are mutually exclusive.
  if (privacy.observeOnly && privacy.sendEnabled) {
    throw new Error(
      "Invalid config: privacy.observe_only and privacy.send_enabled cannot both be true.",
    );
  }

  const whatsmeow: WhatsmeowConfig = {
    commandTimeoutMs: asPositiveInt(whatsmeowRaw.command_timeout_ms, 60_000),
  };
  if (
    typeof whatsmeowRaw.binary_path === "string" &&
    whatsmeowRaw.binary_path.length > 0
  ) {
    whatsmeow.binaryPath = whatsmeowRaw.binary_path;
  }

  const account: AccountConfig = {
    name: asString(accountRaw.name, "personal"),
  };
  const description = accountRaw.description;
  if (typeof description === "string" && description.length > 0) {
    account.description = description;
  }

  const web: WebConfig = {
    enabled: asBool(webRaw.enabled, false),
    host: asLoopbackHost(webRaw.host),
    port: asPort(webRaw.port, 8765),
    tokenFile: resolvePath(
      dataDir,
      webRaw.token_file,
      join(dataDir, "dashboard.token"),
    ),
  };

  return {
    transport: asTransport(transportRaw.name),
    account,
    paths,
    whatsmeow,
    baileys: {
      version: asBaileysVersion(baileysRaw.version, DEFAULT_BAILEYS_VERSION),
      printQrInTerminal: asBool(baileysRaw.print_qr_in_terminal, true),
      syncFullHistory: asBool(baileysRaw.sync_full_history, false),
      markOnlineOnConnect: asBool(baileysRaw.mark_online_on_connect, false),
      browserName: asString(baileysRaw.browser_name, "whatsapp-conduit"),
    },
    privacy,
    media: {
      maxAudioDurationS: asPositiveInt(mediaRaw.max_audio_duration_s, 600),
      maxAudioBytes: asPositiveInt(mediaRaw.max_audio_bytes, 50 * 1024 * 1024),
      maxAttempts: asPositiveInt(mediaRaw.max_attempts, 3),
    },
    mcp: {
      maxResultChars: asPositiveInt(
        process.env.WA_MCP_MAX_RESULT_CHARS ?? mcpRaw.max_result_chars,
        12_000,
      ),
    },
    web,
    filters: {
      allowedChats: asStringArray(filtersRaw.allowed_chats),
      blockedChats: asStringArray(filtersRaw.blocked_chats),
      allowedSenders: asStringArray(filtersRaw.allowed_senders),
      blockedSenders: asStringArray(filtersRaw.blocked_senders),
    },
    exports: {
      defaultFormat: "jsonl",
      redactPhoneNumbers: asBool(exportsRaw.redact_phone_numbers, false),
      includeRawJson: asBool(exportsRaw.include_raw_json, false),
    },
    logging: {
      level: asLogLevel(loggingRaw.level, "info"),
      baileysLevel: asLogLevel(loggingRaw.baileys_level, "warn"),
      baileysLogMessageText: asBool(loggingRaw.baileys_log_message_text, false),
      logMessageText: asBool(loggingRaw.log_message_text, false),
    },
  };
}

/** Load and resolve a config file from disk. */
export function loadConfig(
  configPath: string,
  options: ResolveOptions = {},
): Config {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(configPath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config at ${configPath}: ${message}`);
  }
  return resolveConfig(raw, options);
}

/**
 * Render a default config file body for `whatsapp-conduit init`. Keeps the
 * observe-only defaults explicit and commented so the file is self-documenting.
 */
export function defaultConfigYaml(dataDir: string): string {
  return `# whatsapp-conduit configuration
# Observe-only personal WhatsApp linked-device sync. Defaults are privacy-safe.

transport:
  name: whatsmeow

account:
  name: personal
  description: "Personal WhatsApp linked-device sync"

paths:
  data_dir: ${dataDir}
  sqlite: ${join(dataDir, "whatsapp-conduit.db")}
  auth_dir: ${join(dataDir, "auth")}
  media_dir: ${join(dataDir, "media")}
  whatsmeow_store: ${join(dataDir, "whatsmeow.db")}
  runtime_status: ${join(dataDir, "runtime-status.json")}
  control_socket: ${join(dataDir, process.platform === "win32" ? "control.pipe" : "control.sock")}

whatsmeow:
  # binary_path: /usr/local/bin/whatsmeow-node
  command_timeout_ms: 60000

baileys:
  version: [${DEFAULT_BAILEYS_VERSION.join(", ")}]
  print_qr_in_terminal: true
  sync_full_history: false
  mark_online_on_connect: false
  browser_name: whatsapp-conduit

privacy:
  observe_only: true
  send_enabled: false
  mark_read: false
  store_message_text: true
  store_raw_json: true
  store_media: false
  include_groups: false
  include_status: false

media:
  max_audio_duration_s: 600
  max_audio_bytes: 52428800
  max_attempts: 3

mcp:
  max_result_chars: 12000

web:
  # The dashboard is local-only and disabled unless explicitly enabled.
  enabled: false
  host: 127.0.0.1
  port: 8765
  token_file: ${join(dataDir, "dashboard.token")}

filters:
  # Empty allowlist: discover chats, but do not expose all chats to exports.
  allowed_chats: []
  blocked_chats: []
  allowed_senders: []
  blocked_senders: []

exports:
  default_format: jsonl
  redact_phone_numbers: false
  include_raw_json: false

logging:
  level: info
  # Keep Baileys at warn by default; raise this temporarily for protocol
  # diagnostics (debug output may contain authentication details).
  baileys_level: warn
  baileys_log_message_text: false
  log_message_text: false
`;
}
