/**
 * brain-windows → Synapse (INFRA-364). The incremental worker publishes its
 * window documents as Synapse events; since SC-5827 the only consumer is
 * synapse-adapter-hindsight, which retains them in Hindsight (the synapse
 * workflows that pushed them to the Brain were retired with it):
 *
 *   brain_window.<tenant>.upserted → retain (the documents of ONE window,
 *                                    parent + children, batches of 25)
 *   brain_window.<tenant>.deleted  → tombstone (one doc per event)
 *
 * tenant: follows the account's brain instance in the account registry —
 * instance `personal` → family, instance `leila` → leila (INFRA-554), instance
 * `skirmshop` → skirmshop; any other instance is a registry error (INFRA-1587).
 *
 * Publishing goes straight to the `events` topic exchange of vhost /synapse
 * with a write-only user (configure ^$, read ^$): never assert the exchange.
 */
import { createHash, randomUUID } from 'crypto';
import * as amqp from 'amqplib';
import {
  adapterForPlatform,
  BrainDoc,
  instanceForNamespace,
  wellFormedDeep,
  WindowSink,
} from './brain-windows-lib';

export const SYNAPSE_EVENTS_EXCHANGE = 'events';
export const UPSERT_BATCH = 25;

/** Synapse tenant of an account: its brain instance decides (registry), not its name. */
export function tenantForAccount(account: string): string {
  const instance = instanceForNamespace(account);
  if (instance === 'personal') return 'family';
  // INFRA-554: Leila's own vault. Additive on amqp.synapse.brain-window-upserted.v1
  // (routing key brain_window.{tenant}.*): the leila workflows in synapse bind
  // this key with instance `leila`. Never fall through to skirmshop.
  if (instance === 'leila') return 'leila';
  if (instance === 'skirmshop') return 'skirmshop';
  // INFRA-1587: an instance with no tenant is a registry error. Falling through to
  // skirmshop is how the professional Telegram bot's windows reached `tienda`.
  throw new Error(`brain instance '${instance}' (account '${account}') has no tenant`);
}

export interface SynapseEvent {
  routingKey: string;
  tenant: string;
  messageId: string;
  body: { data: Record<string, unknown> };
}

// CONTRACT: amqp.synapse.brain-window-upserted.v1 — routing key
// brain_window.{tenant}.upserted, body {data: {adapter, source_id,
// payload_hash, documents[]}} (consumer since SC-5827: synapse-adapter-hindsight,
// which retains parent and children in Hindsight with document_id = source_id).
// message_id is random: the engine inbox keeps ids for days, and a deliberate
// re-publish of the same documents (recovery, ADR 0002 §7.1) must not be
// swallowed — the downstream retain is an idempotent upsert by document_id.
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
      messageId: randomUUID(),
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
  // Random ids, as for upserts: deletes are idempotent in the brain.
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
