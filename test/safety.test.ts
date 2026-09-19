import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true })
    .map((e) => (typeof e === "string" ? e : String(e)))
    .filter((f) => f.endsWith(".ts"));
}

/**
 * The observe-only posture is a hard invariant: ingestion/connection code must
 * never call WhatsApp mutation APIs. This guards against accidentally wiring up
 * a send/read/presence path in any future change.
 */
const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: "sendMessage", re: /\.sendMessage\s*\(/ },
  { label: "readMessages", re: /\.readMessages\s*\(/ },
  { label: "sendReadReceipt", re: /\.sendReadReceipt\s*\(/ },
  { label: "sendReceipts", re: /\.sendReceipts\s*\(/ },
  { label: "chatModify", re: /\.chatModify\s*\(/ },
  { label: "sendPresenceUpdate", re: /\.sendPresenceUpdate\s*\(/ },
  { label: "sendPeerMessage", re: /\.sendPeerMessage\s*\(/ },
];

/**
 * Hosts allowed to appear as a literal in `src/`. Invariant n°7 forbids any
 * hosted dependency at runtime beyond WhatsApp and the configured STT
 * provider; ADR-0023 lists the install-time fetches exhaustively.
 *
 *  - `huggingface.co` — `MODEL_HOST` (`src/stt/models.ts`), the whisper model
 *    download, verified by SHA-256. Install-time category of ADR-0023.
 *  - `www.w3.org` — the SVG XML namespace of the pairing QR. A string written
 *    into a document, never a network destination.
 *  - RFC 2606 reserved names (`*.example`, `example.com`, ...) — placeholders
 *    in comments and in the YAML template; they resolve to nothing.
 *
 * Not listed, deliberately: `raw.githubusercontent.com`, the WA Web version
 * lookup authorised at runtime by ADR-0043. It never appears in `src/` because
 * the request is made by `fetchLatestBaileysVersion()` inside the `baileys`
 * dependency (`src/baileys/version.ts` only calls it). Adding any other host
 * here requires a new ADR extending the list.
 */
const ALLOWED_HOSTS = [
  "huggingface.co",
  "www.w3.org",
  "127.0.0.1",
  "localhost",
  "0.0.0.0",
  "::1",
];

/** RFC 2606 / RFC 6761 reserved names: documentation placeholders. */
const RESERVED_SUFFIXES = [
  ".example",
  ".invalid",
  ".test",
  ".localhost",
  "example.com",
  "example.net",
  "example.org",
];

function isAllowedHost(host: string): boolean {
  // Template literals such as `http://${config.web.host}` carry no host.
  if (host === "" || host.includes("${")) return true;
  if (ALLOWED_HOSTS.includes(host)) return true;
  return RESERVED_SUFFIXES.some((s) => host === s || host.endsWith(s));
}

describe("observe-only safety invariants", () => {
  it("source never calls WhatsApp send/read/presence APIs", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const content = readFileSync(`${SRC_DIR}/${file}`, "utf8");
      for (const { label, re } of FORBIDDEN) {
        if (re.test(content)) offenders.push(`${file}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * `sock.updateMediaMessage` is the one outbound emission the project allows
   * (ADR-0039): a media-retry node between the two devices of the same
   * account, for a media this account already received. It is not a message
   * (invariant n°1) — but it must stay confined to the single media path, so
   * no future change can turn it into a generic emission route.
   */
  it("confines updateMediaMessage to the media download path (ADR-0039)", () => {
    const callers = sourceFiles().filter((file) =>
      /\.updateMediaMessage\s*\(/.test(
        readFileSync(`${SRC_DIR}/${file}`, "utf8"),
      ),
    );
    expect(callers).toEqual(["baileys/media.ts"]);
  });

  /**
   * Invariant n°7: no hosted dependency at runtime. Freezes the set of hosts
   * written in the source, so a new outbound destination cannot slip in
   * without an ADR (see ALLOWED_HOSTS above, and ADR-0023 / ADR-0043).
   */
  it("hardcodes no outbound host outside the allow-list (ADR-0043)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const content = readFileSync(`${SRC_DIR}/${file}`, "utf8");
      for (const match of content.matchAll(/https?:\/\/([^/\s"'`)\\]*)/g)) {
        const host = match[1] ?? "";
        if (!isAllowedHost(host)) offenders.push(`${file}: ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
