import type { JsMsg } from 'nats';
import { validateInstagramDmEvent } from './schema';
import { DeliveryOutcome, SynapseClient } from './synapse-client';

export type ProcessOutcome = 'ack' | 'nak' | 'term';

export interface BridgeMetrics {
  received: number;
  delivered: number;
  retried: number;
  terminatedInvalid: number;
  terminatedRejected: number;
}

export function emptyMetrics(): BridgeMetrics {
  return { received: 0, delivered: 0, retried: 0, terminatedInvalid: 0, terminatedRejected: 0 };
}

/** Pure message decision point, easily testable without a NATS server. */
export async function processMessage(
  message: Pick<JsMsg, 'data' | 'ack' | 'nak' | 'term'>,
  client: Pick<SynapseClient, 'forward'>,
  retryDelayMs: number,
  metrics: BridgeMetrics
): Promise<ProcessOutcome> {
  metrics.received += 1;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(message.data).toString('utf8'));
  } catch {
    metrics.terminatedInvalid += 1;
    message.term('invalid-json');
    return 'term';
  }
  if (!validateInstagramDmEvent(decoded)) {
    metrics.terminatedInvalid += 1;
    message.term('invalid-instagram-dm');
    return 'term';
  }

  let outcome: DeliveryOutcome;
  try {
    outcome = await client.forward(message.data);
  } catch {
    // Defensive: a client implementation must never turn a transient local
    // exception into an acknowledgement.
    outcome = 'retryable';
  }
  if (outcome === 'delivered') {
    metrics.delivered += 1;
    message.ack();
    return 'ack';
  }
  if (outcome === 'retryable') {
    metrics.retried += 1;
    message.nak(retryDelayMs);
    return 'nak';
  }
  metrics.terminatedRejected += 1;
  message.term('synapse-terminal-rejection');
  return 'term';
}
