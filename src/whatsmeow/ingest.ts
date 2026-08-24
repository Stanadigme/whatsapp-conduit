import type { IngestDeps } from "../baileys/ingest.js";
import { ingestNormalizedResult, rawJsonOfValue } from "../baileys/ingest.js";
import type {
  ObserveTransport,
  TransportMessageEvent,
} from "../transport/types.js";
import type { IngestionEventClassification } from "../baileys/ingest.js";
import { downloadAudioIfEnabled } from "./media.js";
import { normalizeWhatsmeowMessage } from "./normalize.js";
import { WhatsmeowTransport } from "./transport.js";

/** Wire whatsmeow inbound events into the existing SQLite ingestion contract. */
export function registerWhatsmeowIngestion(
  transport: ObserveTransport,
  deps: IngestDeps,
  options: {
    onEvent?: () => void;
    classify?: (event: TransportMessageEvent) => IngestionEventClassification;
    onStored?: (
      event: TransportMessageEvent,
      stored: boolean,
      classification: IngestionEventClassification,
    ) => void;
  } = {},
): void {
  transport.on("message", (event) => {
    options.onEvent?.();
    try {
      const classification = options.classify?.(event) ?? {
        source: "live",
        store: true,
      };
      if (!classification.store) return;
      const result = normalizeWhatsmeowMessage(event);
      if (result.action === "skip") {
        deps.logger.debug(
          { reason: result.reason },
          "skipped Whatsmeow message",
        );
        return;
      }
      const stored = ingestNormalizedResult(
        deps,
        result,
        rawJsonOfValue(deps.config, event),
        classification.source,
      );
      options.onStored?.(event, stored, classification);
      if (
        stored &&
        result.action === "store" &&
        (classification.source === "live" ||
          classification.source === "history") &&
        transport instanceof WhatsmeowTransport
      ) {
        void downloadAudioIfEnabled(
          transport,
          event,
          result.message,
          deps,
        ).catch((error: unknown) => {
          deps.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            "failed to schedule audio download",
          );
        });
      }
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to ingest whatsmeow message",
      );
    }
  });
}
