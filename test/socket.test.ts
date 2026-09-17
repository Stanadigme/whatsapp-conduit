import { describe, expect, it } from "vitest";
import { Browsers, proto } from "baileys";
import { resolveConfig, type Config } from "../src/config.js";
import type { AuthState } from "../src/baileys/auth.js";
import { buildSocketConfig } from "../src/baileys/socket.js";
import { createLogger } from "../src/util/logging.js";

function fakeAuthState(): AuthState {
  return {
    state: {
      creds: {},
      keys: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    saveCreds: async () => {},
  } as unknown as AuthState;
}

function build(config: Config) {
  return buildSocketConfig({
    config,
    authState: fakeAuthState(),
    version: [2, 3000, 0],
    logger: createLogger({ level: "error" }),
  });
}

describe("buildSocketConfig observe-only invariants", () => {
  it("never marks online or requests full history by default", () => {
    const cfg = build(resolveConfig({}, { dataDir: "/data" }));
    expect(cfg.markOnlineOnConnect).toBe(false);
    expect(cfg.syncFullHistory).toBe(false);
  });

  it.each([
    ["FULL", proto.HistorySync.HistorySyncType.FULL],
    ["RECENT", proto.HistorySync.HistorySyncType.RECENT],
    ["INITIAL_BOOTSTRAP", proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP],
    ["ON_DEMAND", proto.HistorySync.HistorySyncType.ON_DEMAND],
    ["PUSH_NAME", proto.HistorySync.HistorySyncType.PUSH_NAME],
    ["NON_BLOCKING_DATA", proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA],
    ["INITIAL_STATUS_V3", proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3],
  ])(
    "accepts %s history notifications even though syncFullHistory is off (receiving isn't requesting)",
    (_label, syncType) => {
      const cfg = build(resolveConfig({}, { dataDir: "/data" }));
      expect(cfg.shouldSyncHistoryMessage?.({ syncType })).toBe(true);
    },
  );

  it("still accepts FULL notifications when syncFullHistory is explicitly on", () => {
    const cfg = build(
      resolveConfig(
        { baileys: { sync_full_history: true } },
        { dataDir: "/data" },
      ),
    );
    expect(
      cfg.shouldSyncHistoryMessage?.({
        syncType: proto.HistorySync.HistorySyncType.FULL,
      }),
    ).toBe(true);
  });

  it("uses the pinned protocol version by default", () => {
    const cfg = buildSocketConfig({
      config: resolveConfig({}, { dataDir: "/data" }),
      authState: fakeAuthState(),
      logger: createLogger({ level: "error" }),
    });
    expect(cfg.version).toEqual([2, 3000, 1033893291]);
  });

  it("getMessage is a no-op (no resend support)", async () => {
    const cfg = build(resolveConfig({}, { dataDir: "/data" }));
    const result = await cfg.getMessage?.({} as never);
    expect(result).toBeUndefined();
  });

  it("requests full history only when explicitly enabled", () => {
    const cfg = build(
      resolveConfig(
        { baileys: { sync_full_history: true } },
        { dataDir: "/data" },
      ),
    );
    expect(cfg.syncFullHistory).toBe(true);
  });

  it("keeps the configured browser profile when full history is off", () => {
    const cfg = build(
      resolveConfig(
        { baileys: { browser_name: "custom" } },
        { dataDir: "/data" },
      ),
    );
    expect(cfg.browser).toEqual(Browsers.appropriate("custom"));
  });

  it("switches to Browsers.macOS('Desktop') when full history is explicitly enabled", () => {
    const cfg = build(
      resolveConfig(
        { baileys: { sync_full_history: true } },
        { dataDir: "/data" },
      ),
    );
    expect(cfg.browser).toEqual(Browsers.macOS("Desktop"));
  });
});
