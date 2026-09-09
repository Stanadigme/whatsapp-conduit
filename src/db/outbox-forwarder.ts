import type { Database } from "./index.js";
import {
  acknowledgeOutbox,
  leaseOutbox,
  retryOutbox,
  type LeaseOutboxOptions,
} from "./outbox.js";

export interface ForwardedOutboxOperation {
  operation: string;
  payload: unknown;
  attempts: number;
}

export type FlushOutboxOptions = LeaseOutboxOptions;

export interface FlushOutboxResult {
  leased: number;
  acknowledged: number;
  retryPending: number;
}

/**
 * Forward one ordered batch. The callback is the only transport seam: the
 * future PostgreSQL/GCS adapter will supply it, while this module owns the
 * durable lease/ack/retry protocol.
 */
export async function flushOutbox(
  db: Database,
  key: Buffer,
  forward: (operation: ForwardedOutboxOperation) => Promise<void>,
  options: FlushOutboxOptions = {},
): Promise<FlushOutboxResult> {
  const leased = leaseOutbox(db, key, options);
  let acknowledged = 0;
  let retryPending = 0;

  for (const [index, operation] of leased.entries()) {
    try {
      await forward({
        operation: operation.operation,
        payload: operation.payload,
        attempts: operation.attempts,
      });
    } catch {
      for (const pending of leased.slice(index)) {
        retryOutbox(db, pending.id, pending.leaseToken);
      }
      retryPending = leased.length - index;
      break;
    }

    if (!acknowledgeOutbox(db, operation.id, operation.leaseToken)) {
      throw new Error("outbox acknowledgement lease lost");
    }
    acknowledged += 1;
  }

  return { leased: leased.length, acknowledged, retryPending };
}
