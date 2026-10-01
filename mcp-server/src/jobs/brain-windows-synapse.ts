/**
 * brain-windows → Synapse (INFRA-364). The incremental cron publishes its
 * window documents as Synapse events instead of calling push-ingest itself;
 * Synapse's workflows ingest them with retries:
 *
 *   brain_window.<tenant>.upserted → brain.ingest (the documents of ONE window,
 *                                    parent + children, batches of 25)
 *   brain_window.<tenant>.deleted  → brain.delete_document (one doc per event)
 *
 * tenant: account `personal` → family (brain instance personal), anything else
 * → skirmshop (instance skirmshop). Workflows live in pocharlies-org/synapse
 * `workflows/{family,skirmshop}/brain/conversation-window-*.v1.yaml`.
 *
 * Publishing goes straight to the `events` topic exchange of vhost /synapse
 * with a write-only user (configure ^$, read ^$): never assert the exchange.
 */
import { createHash, randomUUID } from 'crypto';
import * as amqp from 'amqplib';
import { BrainDoc, adapterForPlatform } from './brain-ingest-lib';
import { WindowSink, wellFormedDeep } from './brain-windows-lib';

export const SYNAPSE_EVENTS_EXCHANGE = 'events';
export const UPSERT_BATCH = 25;

export function tenantForAccount(account: string): string {
  return account === 'personal' ? 'family' : 'skirmshop';
}

/** A UUID-shaped id derived from a hex digest (the engine dedups on UUID message ids). */
export function uuidFromHex(hex: string): string {
  const h = hex.slice(0, 32).padEnd(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(
    (parseInt(h[16], 16) & 0x3) |
    0x8
  ).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface SynapseEvent {
  routingKey: string;
  tenant: string;
  messageId: string;
  body: { data: Record<string, unknown> };
}

// CONTRACT: amqp.synapse.brain-window-upserted.v1 — routing key
// brain_window.{tenant}.upserted, body {data: {adapter, source_id,
// payload_hash, documents[]}} (consumer: synapse workflow
// <tenant>.brain.conversation-window-upserted).
export function upsertEvents(account: string, docs: BrainDoc[]): SynapseEvent[] {
  if (!docs.length) return [];
  const tenant = tenantForAccount(account);
  const p = docs[0]?.metadata?.platform;
  const adapter = adapterForPlatform(typeof p === 'string' ? p : 'whatsapp');
  const clean = wellFormedDeep(docs);
  const out: SynapseEvent[] = [];
  for (let i = 0; i < clean.length; i += UPSERT_BATCH) {
    const documents = clean.slice(i, i + UPSERT_BATCH);
    const payloadHash = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
    out.push({
      routingKey: `brain_window.${tenant}.upserted`,
      tenant,
      messageId: uuidFromHex(payloadHash),
      body: {
        data: { adapter, source_id: documents[0].source_id, payload_hash: payloadHash, documents },
      },
    });
  }
  return out;
}

// CONTRACT: amqp.synapse.brain-window-deleted.v1 — routing key
// brain_window.{tenant}.deleted, body {data: {adapter, source_id}}, one event
// per document: the parent and each `#c<n>` child.
export function deleteEvents(
  account: string,
  platform: string,
  sourceId: string,
  chunkCount: number
): SynapseEvent[] {
  const tenant = tenantForAccount(account);
  const adapter = adapterForPlatform(platform);
  const ids = [sourceId, ...Array.from({ length: chunkCount }, (_, i) => `${sourceId}#c${i + 1}`)];
  // Deletes are idempotent in the brain; a random id keeps a later delete of a
  // re-created source_id from being swallowed by the engine's inbox dedup.
  return ids.map(id => ({
    routingKey: `brain_window.${tenant}.deleted`,
    tenant,
    messageId: randomUUID(),
    body: { data: { adapter, source_id: id } },
  }));
}

export interface EventPublisher {
  publish(events: SynapseEvent[]): Promise<void>;
  close(): Promise<void>;
}

/** Confirm-channel publisher: resolves only once the broker acked every event. */
export async function connectPublisher(url: string): Promise<EventPublisher> {
  const conn = await amqp.connect(url);
  // An unhandled 'error' event would kill the process; a broken connection
  // instead fails the pending publish, and the caller retries next pass.
  conn.on('error', () => undefined);
  const ch = await conn.createConfirmChannel();
  ch.on('error', () => undefined);
  let returned: string | null = null;
  ch.on('return', (msg: amqp.ConsumeMessage) => {
    returned = msg.fields.routingKey;
  });
  return {
    async publish(events: SynapseEvent[]): Promise<void> {
      for (const e of events) {
        ch.publish(SYNAPSE_EVENTS_EXCHANGE, e.routingKey, Buffer.from(JSON.stringify(e.body)), {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId: e.messageId,
          headers: { tenant_id: e.tenant, event_id: e.messageId },
        });
      }
      await ch.waitForConfirms();
      if (returned) throw new Error(`synapse returned unroutable event ${returned}`);
    },
    async close(): Promise<void> {
      await ch.close().catch(() => undefined);
      await conn.close().catch(() => undefined);
    },
  };
}

export function synapseSink(publisher: EventPublisher): WindowSink {
  return {
    async push(account, docs) {
      await publisher.publish(upsertEvents(account, docs));
    },
    async remove(account, platform, sourceId, chunkCount) {
      await publisher.publish(deleteEvents(account, platform, sourceId, chunkCount));
    },
  };
}
