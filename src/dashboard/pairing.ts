import { createRequire } from "node:module";
import type { Config } from "../config.js";
import { WhatsmeowTransport } from "../whatsmeow/transport.js";
import type { DashboardPairing } from "./api.js";

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

/** Render the live pairing payload as a self-contained SVG. */
export function pairingQrSvg(payload: string): string {
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code d’appairage"><rect width="100%" height="100%" fill="white"/><g fill="black" shape-rendering="crispEdges">${cells.join("")}</g></svg>`;
}

export interface PairingController {
  state: DashboardPairing;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createPairingController(config: Config): PairingController {
  const state: DashboardPairing = {
    status: "idle",
    qr: null,
    error: null,
  };
  let transport: WhatsmeowTransport | null = null;
  let running: Promise<void> | null = null;

  return {
    state,
    async start(): Promise<void> {
      if (running) throw new Error("pairing is already active");
      if (state.status === "connected")
        throw new Error("device is already paired");
      state.status = "waiting_qr";
      state.error = null;
      state.qr = null;
      transport = new WhatsmeowTransport({
        store: config.paths.whatsmeowStore,
        config: config.whatsmeow,
      });
      transport.on("connected", () => {
        state.status = "connected";
        state.qr = null;
      });
      transport.on("error", (error) => {
        state.status = "error";
        state.error = "pairing failed";
        void error;
      });
      running = transport
        .startPairing((code) => {
          state.status = "waiting_qr";
          state.qr = pairingQrSvg(code);
        })
        .catch((error: unknown) => {
          state.status = "error";
          state.qr = null;
          state.error =
            error instanceof Error ? error.message : "pairing failed";
        })
        .finally(() => {
          running = null;
        });
      // The HTTP action starts the operation but does not wait for the user to scan.
      await Promise.resolve();
    },
    async stop(): Promise<void> {
      const current = transport;
      transport = null;
      running = null;
      if (current) await current.stop();
      state.status = "idle";
      state.qr = null;
      state.error = null;
    },
  };
}
