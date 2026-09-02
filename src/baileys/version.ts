import { fetchLatestBaileysVersion } from "baileys";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { WAVersion } from "./socket.js";

/**
 * Result shape of `fetchLatestBaileysVersion` — `version` is always present;
 * `error` is set when the remote lookup failed and `version` is Baileys' own
 * bundled fallback.
 */
export type VersionFetchResult = {
  version: WAVersion;
  isLatest: boolean;
  error?: unknown;
};

export type VersionFetcher = (options?: {
  signal?: AbortSignal;
}) => Promise<VersionFetchResult>;

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Build a WA Web protocol version resolver.
 *
 * A hardcoded version tuple rots: WhatsApp rejects an outdated one at login with
 * `<failure reason='405'>` (see ADR-0020). So the version is resolved live at
 * each connect from `fetchLatestBaileysVersion()`, mirroring the working Hermes
 * bridge. The configured `baileys.version` is used only as an offline fallback,
 * or verbatim when `baileys.pin_version: true` (reproducible / air-gapped runs).
 *
 * The last good value is cached so a later transient fetch failure keeps the
 * connection on a known-good version rather than dropping back to the stale pin.
 */
export function createVersionResolver(
  config: Config,
  logger: Logger,
  fetchLatest: VersionFetcher = fetchLatestBaileysVersion,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): () => Promise<WAVersion> {
  let cached: WAVersion | null = null;

  return async function resolveBaileysVersion(): Promise<WAVersion> {
    if (config.baileys.pinVersion) return config.baileys.version;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`version fetch timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([
        fetchLatest({ signal: controller.signal }),
        deadline,
      ]);
      if (result.error !== undefined) {
        logger.warn(
          { err: describe(result.error) },
          "WA Web version lookup returned an error; using the Baileys bundled version",
        );
        return cached ?? result.version;
      }
      cached = result.version;
      return result.version;
    } catch (error) {
      logger.warn(
        { err: describe(error) },
        cached
          ? "WA Web version fetch failed; reusing the last resolved version"
          : "WA Web version fetch failed; using the offline fallback (baileys.version)",
      );
      return cached ?? config.baileys.version;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
