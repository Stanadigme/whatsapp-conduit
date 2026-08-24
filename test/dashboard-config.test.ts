import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { join } from "node:path";

const dataDir = join(process.cwd(), "test-dashboard-data");

describe("web dashboard configuration", () => {
  it("is disabled and loopback-only by default", () => {
    const config = resolveConfig({}, { dataDir });
    expect(config.web).toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: 8765,
      tokenFile: join(dataDir, "dashboard.token"),
    });
  });

  it("accepts a loopback host and port zero", () => {
    const config = resolveConfig(
      { web: { enabled: true, host: "::1", port: 0 } },
      { dataDir },
    );
    expect(config.web).toMatchObject({ enabled: true, host: "::1", port: 0 });
  });

  it("rejects a non-loopback host", () => {
    expect(() =>
      resolveConfig({ web: { host: "0.0.0.0" } }, { dataDir }),
    ).toThrow("only 127.0.0.1 and ::1 are allowed");
  });
});
