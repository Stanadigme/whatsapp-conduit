import makeWASocket, {
  Browsers,
  makeCacheableSignalKeyStore,
  type WASocket,
} from "baileys";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { AuthState } from "./auth.js";

/** The exact argument type accepted by `makeWASocket`. */
export type SocketConfig = Parameters<typeof makeWASocket>[0];

/** WhatsApp Web protocol version tuple, e.g. `[2, 3000, 0]`. */
export type WAVersion = [number, number, number];

export interface BuildSocketConfigArgs {
  config: Config;
  authState: AuthState;
  /**
   * WA Web protocol version. Normally the value resolved live at connect by
   * `createVersionResolver` (`src/baileys/version.ts`). When omitted,
   * `config.baileys.version` (the offline fallback pin) is used.
   */
  version?: WAVersion;
  logger: Logger;
}

/**
 * Build the `makeWASocket` configuration with observe-only defaults baked in.
 *
 * Safety-critical invariants enforced here (and asserted by tests):
 *  - `markOnlineOnConnect` follows config (default false) — never advertise the
 *    linked device as online by default.
 *  - `syncFullHistory` follows config (default false), so we never *request*
 *    full device history unless explicitly enabled. We deliberately do NOT
 *    override `shouldSyncHistoryMessage`: forcing it to always-false makes
 *    Baileys skip the initial on-connect sync that carries LID mappings, which
 *    upstream flags as causing session instability. Letting it default keeps
 *    only the limited recent on-connect history, which an inbox sync wants.
 *  - `getMessage` is a no-op returning undefined: it exists only to support
 *    message *re-sending*, which this observe-only bridge never does.
 *  - `version` is the WA Web protocol version resolved live at connect
 *    (`src/baileys/version.ts`), falling back to `config.baileys.version` when
 *    the lookup fails or `baileys.pin_version` is set.
 */
export function buildSocketConfig(args: BuildSocketConfigArgs): SocketConfig {
  const { config, authState, version, logger } = args;
  const effectiveVersion = version ?? config.baileys.version;

  const socketConfig: SocketConfig = {
    logger,
    auth: {
      creds: authState.state.creds,
      keys: makeCacheableSignalKeyStore(authState.state.keys, logger),
    },
    browser: Browsers.appropriate(config.baileys.browserName),
    markOnlineOnConnect: config.baileys.markOnlineOnConnect,
    syncFullHistory: config.baileys.syncFullHistory,
    generateHighQualityLinkPreview: false,
    // Observe-only: we never resend messages, so no real message lookup.
    getMessage: async () => undefined,
  };
  socketConfig.version = effectiveVersion;
  return socketConfig;
}

/** Create a live WhatsApp socket from a built config. */
export function createSocket(socketConfig: SocketConfig): WASocket {
  return makeWASocket(socketConfig);
}

export type { WASocket };
