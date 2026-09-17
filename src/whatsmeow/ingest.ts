import type { IngestDeps } from "../baileys/ingest.js";
import {
  exposedForSideEffects,
  ingestNormalizedResult,
  rawJsonOfValue,
} from "../baileys/ingest.js";
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
    onError?: () => void;
  } = {},
): void {
  transport.on("message", (event) => {
    options.onEvent?.();
    let classification: IngestionEventClassification | undefined;
    try {
      classification = options.classify?.(event) ?? {
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
      // ponytail: garde local, à remplacer par chatExposureAllowed (S3b,
      // src/db/directory.ts) — un message hors périmètre n'est jamais
      // téléchargé (ADR-0037 §2).
      if (
        stored &&
        result.action === "store" &&
        classification.source === "live" &&
        transport instanceof WhatsmeowTransport &&
        exposedForSideEffects(deps, {
          jid: result.message.chatJid,
          isGroup: result.message.isGroup,
          isStatus: result.message.isStatus,
        })
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
      if (classification?.source === "history") options.onError?.();
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to ingest whatsmeow message",
      );
    }
  });
}
