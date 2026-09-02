import { describe, expect, it, vi } from "vitest";
import { resolveConfig, DEFAULT_BAILEYS_VERSION } from "../src/config.js";
import { createLogger } from "../src/util/logging.js";
import {
  createVersionResolver,
  type VersionFetcher,
} from "../src/baileys/version.js";

const logger = createLogger({ level: "fatal" });
const LIVE: [number, number, number] = [2, 3000, 9_999_999];

function cfg(overrides: Record<string, unknown> = {}) {
  return resolveConfig({ baileys: overrides }, { dataDir: "/data" });
}

describe("createVersionResolver", () => {
  it("returns the live version and caches it", async () => {
    const fetchLatest = vi.fn<VersionFetcher>().mockResolvedValue({
      version: LIVE,
      isLatest: true,
    });
    const resolve = createVersionResolver(cfg(), logger, fetchLatest);

    expect(await resolve()).toEqual(LIVE);
    expect(await resolve()).toEqual(LIVE);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("uses the offline pin verbatim when pin_version is set (no fetch)", async () => {
    const fetchLatest = vi.fn<VersionFetcher>();
    const resolve = createVersionResolver(
      cfg({ pin_version: true, version: [2, 3000, 123] }),
      logger,
      fetchLatest,
    );

    expect(await resolve()).toEqual([2, 3000, 123]);
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("falls back to the configured pin when the fetch rejects", async () => {
    const fetchLatest = vi
      .fn<VersionFetcher>()
      .mockRejectedValue(new Error("offline"));
    const resolve = createVersionResolver(cfg(), logger, fetchLatest);

    expect(await resolve()).toEqual(DEFAULT_BAILEYS_VERSION);
  });

  it("reuses the last good version after a later fetch failure", async () => {
    const fetchLatest = vi
      .fn<VersionFetcher>()
      .mockResolvedValueOnce({ version: LIVE, isLatest: true })
      .mockRejectedValueOnce(new Error("flaky"));
    const resolve = createVersionResolver(cfg(), logger, fetchLatest);

    expect(await resolve()).toEqual(LIVE);
    expect(await resolve()).toEqual(LIVE); // cached, not the stale pin
  });

  it("accepts the bundled version when the lookup reports an error", async () => {
    const fetchLatest = vi.fn<VersionFetcher>().mockResolvedValue({
      version: [2, 3000, 555],
      isLatest: false,
      error: new Error("network"),
    });
    const resolve = createVersionResolver(cfg(), logger, fetchLatest);

    expect(await resolve()).toEqual([2, 3000, 555]);
  });

  it("times out a hanging fetch and falls back", async () => {
    const fetchLatest = vi
      .fn<VersionFetcher>()
      .mockImplementation(() => new Promise(() => {}));
    const resolve = createVersionResolver(cfg(), logger, fetchLatest, 20);

    expect(await resolve()).toEqual(DEFAULT_BAILEYS_VERSION);
  });
});
