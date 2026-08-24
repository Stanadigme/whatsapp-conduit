import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  maskSecrets,
  runConfigSet,
  runConfigShow,
} from "../src/commands/config.js";
import { defaultConfigYaml } from "../src/config.js";

let dir: string;
let configPath: string;
let out: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wac-config-"));
  configPath = join(dir, "config.yaml");
  writeFileSync(configPath, defaultConfigYaml(join(dir, "data")), {
    mode: 0o600,
  });
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("config show", () => {
  it("prints resolved keys as dotted lines", () => {
    runConfigShow({ configPath });
    const text = out.join("");
    expect(text).toContain("privacy.observeOnly = true");
    expect(text).toContain("logging.level = info");
  });

  it("emits JSON with --json", () => {
    runConfigShow({ configPath, json: true });
    const parsed = JSON.parse(out.join(""));
    expect(parsed.privacy.observeOnly).toBe(true);
  });

  it("masks secret-named keys (schema has none yet, so test the masker)", () => {
    const masked = maskSecrets({
      account: { name: "personal" },
      stt: { api_key: "sk-live-123", model: "whisper" },
      auth_token: "super-secret",
    }) as Record<string, Record<string, unknown>>;
    expect(masked.stt!.api_key).toBe("***");
    expect(masked.stt!.model).toBe("whisper");
    expect((masked as Record<string, unknown>).auth_token).toBe("***");
    expect(masked.account!.name).toBe("personal");
  });
});

describe("config set", () => {
  it("edits a scalar and preserves comments", () => {
    runConfigSet("logging.level", "debug", { configPath });
    const body = readFileSync(configPath, "utf8");
    expect(body).toContain("level: debug");
    // A comment from the default template must survive the rewrite.
    expect(body).toContain("# whatsapp-conduit configuration");
  });

  it("coerces booleans and integers", () => {
    runConfigSet("baileys.print_qr_in_terminal", "false", { configPath });
    runConfigSet("mcp.max_result_chars", "5000", { configPath });
    const body = readFileSync(configPath, "utf8");
    expect(body).toContain("print_qr_in_terminal: false");
    expect(body).toContain("max_result_chars: 5000");
  });

  it("rejects unknown keys", () => {
    expect(() => runConfigSet("privacy.nope", "true", { configPath })).toThrow(
      /not editable/,
    );
  });

  it("rejects a known-but-non-editable key (not on the allowlist)", () => {
    // A real key, but deliberately absent from the editable allowlist.
    expect(() =>
      runConfigSet("paths.data_dir", "/tmp/elsewhere", { configPath }),
    ).toThrow(/not editable/);
  });

  it("rejects setting a section", () => {
    expect(() => runConfigSet("privacy", "x", { configPath })).toThrow(
      /not editable/,
    );
  });

  it("refuses list keys, pointing to the chats commands", () => {
    expect(() =>
      runConfigSet("filters.allowed_chats", "[]", { configPath }),
    ).toThrow(/chats allow/);
  });

  // The observe-only posture keys must be refused BY NAME, before any write —
  // not written and then rolled back. Each throws and leaves the file untouched.
  const REFUSED: Array<[string, string]> = [
    ["privacy.observe_only", "false"],
    ["privacy.send_enabled", "true"],
    ["privacy.mark_read", "true"],
    ["baileys.mark_online_on_connect", "true"],
    ["baileys.sync_full_history", "true"],
  ];

  for (const [key, value] of REFUSED) {
    it(`refuses to set ${key} and does not touch the file`, () => {
      const before = readFileSync(configPath, "utf8");
      expect(() => runConfigSet(key, value, { configPath })).toThrow(
        /Refusing to set/,
      );
      expect(readFileSync(configPath, "utf8")).toBe(before);
    });
  }

  it("keeps the config file owner-only after an edit", () => {
    runConfigSet("logging.level", "warn", { configPath });
    if (process.platform !== "win32") {
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });
});

describe("config set — transcription keys", () => {
  it("writes the keys the dashboard owns", () => {
    runConfigSet("stt.enabled", "true", { configPath });
    runConfigSet("stt.language", "auto", { configPath });
    runConfigSet("stt.whisper.model_path", "/models/ggml-base.bin", {
      configPath,
    });

    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("enabled: true");
    expect(text).toContain("language: auto");
    expect(text).toContain("model_path: /models/ggml-base.bin");
    expect(text).toContain("# Voice-note transcription.");
  });

  it("creates the stt section in a config written before it existed", () => {
    const legacy = defaultConfigYaml(join(dir, "data")).replace(
      /\nstt:\n(?: {2}.*\n|\n)*?(?=web:)/,
      "\n",
    );
    expect(legacy).not.toContain("stt:");
    writeFileSync(configPath, legacy, { mode: 0o600 });

    runConfigSet("stt.enabled", "true", { configPath });

    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("stt:");
    expect(text).toContain("enabled: true");
    // The rest of the file survives the insertion.
    expect(text).toContain("observe_only: true");
  });

  it("still refuses posture keys and engine paths", () => {
    expect(() =>
      runConfigSet("privacy.observe_only", "false", { configPath }),
    ).toThrow(/Refusing to set/);
    expect(() =>
      runConfigSet("stt.whisper.binary_path", "/tmp/evil", { configPath }),
    ).toThrow(/not editable/);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("observe_only: true");
    expect(text).toContain("binary_path: whisper-cli");
  });
});
