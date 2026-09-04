import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * QR codes are rotated by WhatsApp roughly every 20 seconds. A stale file
 * must therefore never be served as if it were an active pairing credential.
 */
export const BAILEYS_LINK_QR_MAX_AGE_MS = 45_000;

const BAILEYS_LINK_QR_FILE = "pairing-qr.svg";
const MAX_QR_SVG_BYTES = 256 * 1024;

export function baileysLinkQrPath(dataDir: string): string {
  return join(dataDir, BAILEYS_LINK_QR_FILE);
}

/**
 * Return the current QR rendered by `link --qr-out`, if any.
 *
 * The dashboard never creates this file and does not retain it after its
 * expiry. Keeping the check here makes a killed link process fail closed: a
 * browser will stop seeing its last QR after a short, bounded delay.
 */
export function readLiveBaileysLinkQr(
  dataDir: string,
  nowMs = Date.now(),
): string | null {
  const path = baileysLinkQrPath(dataDir);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || nowMs - stat.mtimeMs > BAILEYS_LINK_QR_MAX_AGE_MS) {
      return null;
    }
    if (stat.size === 0 || stat.size > MAX_QR_SVG_BYTES) return null;
    const svg = readFileSync(path, "utf8").trim();
    // `link --qr-out` creates this restricted SVG. Do not turn arbitrary
    // writable-volume content into an active SVG document in a browser.
    if (
      !svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') ||
      !svg.endsWith("</svg>") ||
      /<(?:script|foreignObject|iframe|image|use|style)\b/i.test(svg) ||
      /\son[a-z]+\s*=/i.test(svg)
    ) {
      return null;
    }
    return svg;
  } catch {
    // A QR can rotate while the dashboard reads it; absence is an expected
    // state and must not disclose filesystem details to the browser.
    return null;
  }
}
