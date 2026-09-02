import type { Config } from "../config.js";
import { WhatsmeowTransport } from "../whatsmeow/transport.js";
import { qrSvg } from "../util/qr-svg.js";
import type { DashboardPairing } from "./api.js";

/** Render the live pairing payload as a self-contained SVG. */
export const pairingQrSvg = qrSvg;

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
