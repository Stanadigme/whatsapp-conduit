import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { join } from "node:path";

const dataDir = join(process.cwd(), "test-dashboard-data");
const originalPublicOrigin = process.env.WA_DASHBOARD_PUBLIC_ORIGIN;

afterEach(() => {
  if (originalPublicOrigin === undefined) {
    delete process.env.WA_DASHBOARD_PUBLIC_ORIGIN;
  } else {
    process.env.WA_DASHBOARD_PUBLIC_ORIGIN = originalPublicOrigin;
  }
});

describe("web dashboard configuration", () => {
  it("is disabled and loopback-only by default", () => {
    const config = resolveConfig({}, { dataDir });
    expect(config.web).toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: 8765,
      tokenFile: join(dataDir, "dashboard.token"),
      publicOrigin: null,
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

  it("accepts a canonical HTTPS public origin", () => {
    const config = resolveConfig(
      { web: { public_origin: "https://dashboard.example.test/" } },
      { dataDir },
    );
    expect(config.web.publicOrigin).toBe("https://dashboard.example.test");
  });

  it("gives the deployment environment precedence over YAML", () => {
    process.env.WA_DASHBOARD_PUBLIC_ORIGIN = "https://proxy.example.test";
    const config = resolveConfig(
      { web: { public_origin: "https://yaml.example.test" } },
      { dataDir },
    );
    expect(config.web.publicOrigin).toBe("https://proxy.example.test");
  });

  it.each([
    "http://dashboard.example.test",
    "https://dashboard.example.test/path",
    "https://dashboard.example.test/?query=value",
    "https://user:password@dashboard.example.test",
  ])("rejects an unsafe public origin: %s", (publicOrigin) => {
    expect(() =>
      resolveConfig({ web: { public_origin: publicOrigin } }, { dataDir }),
    ).toThrow("Invalid web.public_origin");
  });
});
