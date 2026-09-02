import { createRequire } from "node:module";

interface QrCode {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, column: number): boolean;
}
interface QrCodeConstructor {
  new (typeNumber: number, errorCorrectionLevel: number): QrCode;
}

const require = createRequire(import.meta.url);
const QrCode = require("qrcode-terminal/vendor/QRCode") as QrCodeConstructor;
const QrErrorCorrection =
  require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { M: number };

/**
 * Render a QR payload as a self-contained, dependency-free SVG. Used for the
 * dashboard pairing view (embedded, no fixed size) and for headless
 * `link --qr-out` (pass `px` so a standalone file opens at a scannable size).
 */
export function qrSvg(payload: string, opts: { px?: number } = {}): string {
  const code = new QrCode(-1, QrErrorCorrection.M);
  code.addData(payload);
  code.make();
  const count = code.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  const cells: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (code.isDark(row, column)) {
        cells.push(
          `<rect x="${column + quiet}" y="${row + quiet}" width="1" height="1"/>`,
        );
      }
    }
  }
  const dims =
    opts.px && opts.px > 0 ? ` width="${opts.px}" height="${opts.px}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg"${dims} viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code d’appairage"><rect width="100%" height="100%" fill="white"/><g fill="black" shape-rendering="crispEdges">${cells.join("")}</g></svg>`;
}
