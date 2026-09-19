import { describe, expect, it } from "vitest";
import { DEFAULT_BAILEYS_VERSION, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("applies observe-only-safe defaults for an empty config", () => {
    const cfg = resolveConfig({}, { dataDir: "/data" });

    expect(cfg.privacy.observeOnly).toBe(true);
    expect(cfg.privacy.sendEnabled).toBe(false);
    expect(cfg.privacy.markRead).toBe(false);
    expect(cfg.privacy.storeMedia).toBe(false);
    expect(cfg.privacy.includeGroups).toBe(false);
    expect(cfg.privacy.includeStatus).toBe(false);

    expect(cfg.transport).toBe("baileys");
    expect(cfg.baileys.markOnlineOnConnect).toBe(false);
    expect(cfg.baileys.syncFullHistory).toBe(false);
    expect(cfg.baileys.version).toEqual(DEFAULT_BAILEYS_VERSION);
    expect(cfg.baileys.pinVersion).toBe(false);
    expect(cfg.baileys.resyncDirectoryOnConnect).toBe(true);

    expect(cfg.logging.level).toBe("info");
    expect(cfg.logging.baileysLevel).toBe("warn");
    expect(cfg.logging.baileysLogMessageText).toBe(false);
    expect(cfg.logging.logMessageText).toBe(false);
  });

  it("derives paths from the data directory", () => {
    const cfg = resolveConfig({}, { dataDir: "/srv/wac" });
    expect(cfg.paths.dataDir).toBe("/srv/wac");
    expect(cfg.paths.sqlite).toBe("/srv/wac/whatsapp-conduit.db");
    expect(cfg.paths.authDir).toBe("/srv/wac/auth");
    expect(cfg.paths.mediaDir).toBe("/srv/wac/media");
  });

  it("resolves a relative data_dir to an absolute path", () => {
    const cfg = resolveConfig({ paths: { data_dir: "state" } });
    expect(cfg.paths.dataDir.startsWith("/")).toBe(true);
    expect(cfg.paths.dataDir.endsWith("/state")).toBe(true);
    expect(cfg.paths.sqlite.startsWith("/")).toBe(true);
  });

  it("resolves relative path overrides against the data dir", () => {
    const cfg = resolveConfig(
      { paths: { data_dir: "/srv/wac", sqlite: "db/main.db" } },
      {},
    );
    expect(cfg.paths.sqlite).toBe("/srv/wac/db/main.db");
  });

  it("honors an explicit data-dir override over the file value", () => {
    const cfg = resolveConfig(
      { paths: { data_dir: "/from/file" } },
      { dataDir: "/from/flag" },
    );
    expect(cfg.paths.dataDir).toBe("/from/flag");
  });

  // Beta-profile replay queue: opt-in only, nothing drains the table today.
  it("keeps the outbox queue disabled unless it is asked for", () => {
    expect(resolveConfig({}, { dataDir: "/data" }).persistence.outbox).toEqual({
      enabled: false,
    });
    expect(
      resolveConfig(
        { persistence: { outbox: { enabled: true } } },
        { dataDir: "/data" },
      ).persistence.outbox.enabled,
    ).toBe(true);
  });

  it("refuses the whatsmeow transport, removed by ADR-0042", () => {
    expect(() => resolveConfig({ transport: { name: "whatsmeow" } })).toThrow(
      /ADR-0042/,
    );
  });

  // Invariant n°3 of CLAUDE.md: no phantom online presence on the client
  // account. A hand-edited YAML must not be able to flip it.
  it("refuses baileys.mark_online_on_connect: true", () => {
    expect(() =>
      resolveConfig({ baileys: { mark_online_on_connect: true } }),
    ).toThrow(/invariant n°3/);
    expect(
      resolveConfig({ baileys: { mark_online_on_connect: false } }).baileys
        .markOnlineOnConnect,
    ).toBe(false);
  });

  it("still loads a config carrying the retired sender filter keys", () => {
    const cfg = resolveConfig({
      filters: {
        allowed_chats: ["a@s.whatsapp.net"],
        allowed_senders: ["c@s.whatsapp.net"],
        blocked_senders: ["d@s.whatsapp.net"],
      },
    });
    expect(cfg.filters).toEqual({
      allowedChats: ["a@s.whatsapp.net"],
      blockedChats: [],
    });
  });

  it("reads filters and logging overrides", () => {
    const cfg = resolveConfig({
      filters: {
        allowed_chats: ["a@s.whatsapp.net"],
        blocked_chats: ["b@g.us"],
      },
      logging: {
        level: "debug",
        baileys_level: "trace",
        baileys_log_message_text: true,
        log_message_text: true,
      },
    });
    expect(cfg.filters.allowedChats).toEqual(["a@s.whatsapp.net"]);
    expect(cfg.filters.blockedChats).toEqual(["b@g.us"]);
    expect(cfg.logging.level).toBe("debug");
    expect(cfg.logging.baileysLevel).toBe("trace");
    expect(cfg.logging.baileysLogMessageText).toBe(true);
    expect(cfg.logging.logMessageText).toBe(true);
  });

  it("accepts an explicit Baileys protocol version", () => {
    const cfg = resolveConfig({
      baileys: { version: [2, 3000, 123] },
    });

    expect(cfg.baileys.version).toEqual([2, 3000, 123]);
  });

  it("falls back to the pinned version for malformed overrides", () => {
    const cfg = resolveConfig({
      baileys: { version: [2, 3000] },
    });

    expect(cfg.baileys.version).toEqual(DEFAULT_BAILEYS_VERSION);
  });

  it("rejects an invalid log level by falling back to info", () => {
    const cfg = resolveConfig({ logging: { level: "verbose" } });
    expect(cfg.logging.level).toBe("info");
  });

  it("throws when observe_only and send_enabled conflict", () => {
    expect(() =>
      resolveConfig({ privacy: { observe_only: true, send_enabled: true } }),
    ).toThrow(/mutually|cannot both/i);
  });

  it("requires an HTTPS OAuth issuer when MCP OAuth is enabled", () => {
    expect(() =>
      resolveConfig({ mcp: { http: { oauth: { enabled: true } } } }),
    ).toThrow(/mcp\.http\.oauth\.issuer/i);
    expect(() =>
      resolveConfig({
        mcp: { http: { oauth: { enabled: true, issuer: "http://example.test" } } },
      }),
    ).toThrow(/HTTPS origin/i);
    expect(() =>
      resolveConfig({
        mcp: {
          http: {
            oauth: { enabled: true, issuer: "https://example.test/not-an-origin" },
          },
        },
      }),
    ).toThrow(/HTTPS origin/i);
    expect(
      resolveConfig({
        mcp: {
          http: {
            oauth: { enabled: true, issuer: "https://whatsapp.example.test" },
          },
        },
      }).mcp.http.oauth,
    ).toEqual({ enabled: true, issuer: "https://whatsapp.example.test" });
  });
});
