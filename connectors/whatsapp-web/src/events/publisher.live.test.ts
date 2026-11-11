import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect, NatsConnection, JSONCodec, Subscription } from 'nats';

/**
 * INFRA-290 criterion B — LIVE evidence, against the real production NATS.
 *
 * NOT run in CI: it only executes when INFRA290_LIVE=1 is set by the operator
 * running it by hand (the exact command is in 50-entrega.md). It publishes 100
 * events at a constant rate through the REAL retention code of the whatsapp-web
 * publisher, deletes the NATS pod mid-run (the declared fault injection), and
 * prints the two counters — published vs received — that criterion B demands.
 *
 * Subject isolation (agreed with the tech-lead before running): the harness
 * publishes under `infra290.live.*`, never under `whatsapp.*` / `instagram.*`,
 * so no synthetic event can reach the production consumers (mcp-server
 * ingestion, embedding-job, synapse-bridge) or the real database. Checked
 * against every subscription in the repo —
 *   whatsapp.MessageReceived / whatsapp.MessageUpdated / whatsapp.ChatUpdated
 *   instagram.>
 * none of which matches `infra290.live.<type>`. Only `subjectFor()` is
 * overridden; the enqueue / retain / drain path under test is production code.
 *
 * Two publishers, because a single warm client cannot prove the retainer:
 *  - WARM  : connected before the outage. The nats client buffers outbound
 *            writes, so it may ride the outage without ever flipping
 *            `connected` to false — a legitimate delivery path, but one that
 *            leaves `retained` at 0 and proves nothing about retention.
 *  - COLD  : created INSIDE the outage window. Its initial connect fails, so
 *            every event must go through the bounded retainer and be
 *            republished on reconnect — the unambiguous live proof.
 */

const LIVE = process.env.INFRA290_LIVE === '1';
const LIVE_NATS_URL = process.env.INFRA290_NATS_URL ?? '';
const FAULT_CMD = process.env.INFRA290_FAULT_CMD ?? '';

// Reconnect pacing for this run (production defaults are 2000/30000).
process.env.NATS_RECONNECT_BASE_MS = process.env.NATS_RECONNECT_BASE_MS ?? '1000';
process.env.NATS_RECONNECT_MAX_MS = process.env.NATS_RECONNECT_MAX_MS ?? '3000';

import { EventPublisher } from './publisher';
import { EventType, MessageReceivedEvent } from '@mcp-socialmedia/shared';

const TOTAL = 100;
const RATE_MS = 100; // 10 events/second
const FAULT_AT = 30; // delete the NATS pod after this many warm probes
const COLD_TOTAL = 20; // probes published while NATS is confirmed down
const LIVE_SUBJECT_PREFIX = 'infra290.live';
const jsonCodec = JSONCodec<MessageReceivedEvent>();

/** The real publisher, with only the subject redirected to the test branch. */
class LiveHarnessPublisher extends EventPublisher {
  protected subjectFor(event: MessageReceivedEvent): string {
    return `${LIVE_SUBJECT_PREFIX}.${event.eventType}`;
  }
}

function probeEvent(index: number, tag: string): MessageReceivedEvent {
  return {
    eventType: EventType.MESSAGE_RECEIVED,
    conversationId: 'infra290-live-probe@s.whatsapp.net',
    waMessageId: `INFRA290-LIVE-${tag}-${String(index).padStart(4, '0')}`,
    waTimestamp: new Date().toISOString(),
    senderWaId: 'infra290-live-probe@s.whatsapp.net',
    content: `INFRA-290 retention probe ${tag} ${index}`,
    messageType: 'text',
    isForwarded: false,
    account: 'personal',
  };
}

const utc = () => new Date().toISOString();

interface Received {
  ids: Set<string>;
  duplicates: number;
  count: number;
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test(
  'LIVE: 100 warm + 20 cold events across a real NATS pod deletion — published vs received',
  async t => {
    if (!LIVE) {
      t.skip('set INFRA290_LIVE=1 (plus INFRA290_NATS_URL and INFRA290_FAULT_CMD) to run against prod NATS');
      return;
    }
    assert.ok(LIVE_NATS_URL, 'INFRA290_NATS_URL is required (e.g. nats://127.0.0.1:14222)');
    assert.ok(FAULT_CMD, 'INFRA290_FAULT_CMD is required (the declared fault injection)');

    const received: Received = { ids: new Set(), duplicates: 0, count: 0 };
    const warm = new LiveHarnessPublisher(LIVE_NATS_URL);
    let cold: LiveHarnessPublisher | null = null;
    let coldConnectedAtStart: boolean | null = null;

    let sub: Subscription | null = null;
    let subNc: NatsConnection | null = null;
    let subConnected = false;
    let faultAt = '';
    let pubDown = '';
    let coldStart = '';
    let coldBack = '';
    let backAt = '';

    // The consumer is re-armed after the outage, so "received" is a real live
    // count and is never understated by a harness-side race.
    const ensureSubscriber = async (): Promise<void> => {
      if (subConnected) return;
      try {
        const nc: NatsConnection = await connect({ servers: LIVE_NATS_URL, timeout: 1500 });
        const next = nc.subscribe(`${LIVE_SUBJECT_PREFIX}.>`, {
          maxPending: 100_000,
          callback: (_err, msg) => {
            try {
              const event = jsonCodec.decode(msg.data);
              received.count += 1;
              if (received.ids.has(event.waMessageId)) received.duplicates += 1;
              else received.ids.add(event.waMessageId);
            } catch (error) {
              console.log(`${utc()} subscriber decode error: ${String(error)}`);
            }
          },
        });
        await nc.flush();
        sub = next;
        subNc = nc;
        subConnected = true;
        void nc
          .closed()
          .then(() => {
            subConnected = false;
            sub = null;
            subNc = null;
          })
          .catch(() => {
            subConnected = false;
          });
      } catch {
        subConnected = false;
      }
    };

    try {
      await ensureSubscriber();
      assert.ok(subConnected, 'harness subscriber must be live on prod NATS before publishing');
      await warm.connect();
      assert.ok(warm.isConnected(), 'warm publisher must be connected to prod NATS before the fault');

      // Canary (required by the tech-lead before the fault injection): one
      // event proving the loop is wired end to end. Its own id keeps it out of
      // the measured counters.
      warm.publishMessageReceived(probeEvent(0, 'CANARY'));
      await waitUntil(
        () => received.ids.has('INFRA290-LIVE-CANARY-0000'),
        10_000,
        'the canary event'
      );
      console.log(`${utc()} canary OK: 1 published, 1 received on ${LIVE_SUBJECT_PREFIX}.>`);

      // Baselines AFTER the canary: the counters below describe only the
      // measured probes.
      const warmBaseline = warm.retentionStats();
      const receivedBaseline = received.count;

      // ---- Publish at a constant rate; inject the fault partway through ----
      for (let i = 0; i < TOTAL; i++) {
        if (i === FAULT_AT) {
          faultAt = utc();
          console.log(`${faultAt} fault injection: ${FAULT_CMD}`);
          process.stdout.write(
            String(execFileSync('bash', ['-c', FAULT_CMD], { encoding: 'utf8' })).trim() + '\n'
          );

          // Cold publisher, created inside the outage window: its initial
          // connect() must fail, which forces every event through the retainer.
          coldStart = utc();
          cold = new LiveHarnessPublisher(LIVE_NATS_URL);
          await cold.connect();
          coldConnectedAtStart = cold.isConnected();
          for (let c = 0; c < COLD_TOTAL; c++) {
            cold!.publishMessageReceived(probeEvent(c, 'COLD'));
            await new Promise(resolve => setTimeout(resolve, RATE_MS));
          }
          console.log(
            `${utc()} cold publisher: published ${COLD_TOTAL} with connectedAtStart=${coldConnectedAtStart}, pending=${cold!.pendingRetention()}`
          );
        }

        warm.publishMessageReceived(probeEvent(i, 'WARM'));
        await new Promise(resolve => setTimeout(resolve, RATE_MS));

        // Outage clock = the code under test. `watchStatus` flips
        // `isConnected()` on the client's Disconnect/Reconnect events, so this
        // measures how long the publisher itself considered NATS dead. (The
        // subscriber's own socket is useless for this: with the client's
        // internal reconnect loop its `closed()` never fires during a short
        // outage, so `subConnected` stayed true throughout.)
        if (faultAt && !pubDown && !warm.isConnected()) pubDown = utc();
        if (pubDown && !backAt && warm.isConnected()) backAt = utc();
        if (!subConnected) await ensureSubscriber();
      }

      // ---- Wait for both retainers to drain ----
      await waitUntil(
        () => (cold === null || cold.pendingRetention() === 0) && warm.pendingRetention() === 0,
        180_000,
        'both retainers to drain'
      );
      if (cold && coldStart) coldBack = utc();

      const expectedIds: string[] = [];
      for (let i = 0; i < TOTAL; i++) expectedIds.push(`INFRA290-LIVE-WARM-${String(i).padStart(4, '0')}`);
      for (let i = 0; i < COLD_TOTAL; i++) expectedIds.push(`INFRA290-LIVE-COLD-${String(i).padStart(4, '0')}`);
      const expectedTotal = expectedIds.length;

      await waitUntil(
        () => expectedIds.every(id => received.ids.has(id)),
        180_000,
        `all ${expectedTotal} probes at the consumer (have ${received.ids.size})`
      );

      const warmStats = warm.retentionStats();
      const coldStats = cold ? cold.retentionStats() : null;
      const warmPublished = warmStats.published - warmBaseline.published;
      const warmRepublished = warmStats.republished - warmBaseline.republished;
      const warmRetained = warmStats.retained - warmBaseline.retained;
      const receivedInRun = received.count - receivedBaseline;
      const outageSeconds =
        pubDown && backAt ? (new Date(backAt).getTime() - new Date(pubDown).getTime()) / 1000 : 0;

      // ---- CRITERION B EVIDENCE: paste this block verbatim ----------------
      console.log('');
      console.log('===== INFRA-290 criterion B · LIVE evidence =====');
      console.log(`nats_url            : ${LIVE_NATS_URL}`);
      console.log(`subject prefix      : ${LIVE_SUBJECT_PREFIX}.> (never whatsapp.* / instagram.*)`);
      console.log(`fault command       : ${FAULT_CMD}`);
      console.log(`fault injected at   : ${faultAt} (warm probe #${FAULT_AT})`);
      console.log(`publisher saw down  : ${pubDown}`);
      console.log(`publisher back      : ${backAt || 'n/a'}`);
      console.log(`observed outage     : ${outageSeconds.toFixed(1)} s`);
      console.log(`cold publisher      : started ${coldStart}, connectedAtStart=${coldConnectedAtStart}, drained ${coldBack || 'n/a'}`);
      console.log(`retention window    : ${process.env.NATS_RETENTION_WINDOW_HOURS ?? '6'} h`);
      console.log(`retention max events: ${process.env.NATS_RETENTION_MAX_EVENTS ?? '500'}`);
      console.log('--- COUNTERS (canary excluded) ---');
      console.log(`PUBLISHED warm      : accepted=${TOTAL} published=${warmPublished} republished=${warmRepublished} retained=${warmRetained}`);
      if (coldStats) {
        console.log(`PUBLISHED cold      : accepted=${COLD_TOTAL} published=${coldStats.published} republished=${coldStats.republished} retained=${coldStats.retained}`);
      }
      console.log(`RECEIVED  (consumer): messages=${receivedInRun} unique_ids=${received.ids.size - 1} duplicates=${received.duplicates}`);
      console.log(`dropped             : overflow=${warmStats.overflowDropped} expired=${warmStats.expiredDropped} dup_skipped=${warmStats.duplicateSkipped}`);
      console.log('=====================================================');
      console.log('');

      // Criterion C: republishing never duplicates an event id.
      assert.equal(received.duplicates, 0, 'no duplicated event id at the consumer');
      assert.equal(warmStats.duplicateSkipped, 0);
      assert.equal(coldStats ? coldStats.duplicateSkipped : 0, 0);
      assert.equal(warmStats.overflowDropped, 0, 'the 500-entry cap must not bite at N=100');
      assert.equal(warmStats.expiredDropped, 0, 'the 6 h window must not bite');

      // Criterion A: zero loss across a real NATS pod deletion.
      assert.equal(warmPublished + warmRepublished, TOTAL, 'every warm probe left exactly once');
      if (coldStats) {
        assert.equal(coldStats.published + coldStats.republished, COLD_TOTAL);
        if (coldConnectedAtStart === false) {
          assert.ok(
            coldStats.retained >= COLD_TOTAL,
            'the cold phase must have exercised the retainer'
          );
        } else {
          // NATS was already reachable when the cold publisher started (the pod
          // came back faster than the harness could create it). Nothing to
          // assert about retention — the evidence line says so explicitly.
          console.log(
            'NOTE: cold publisher connected at start, so the cold retention window was not exercised in this run.'
          );
        }
      }
      const missing = expectedIds.filter(id => !received.ids.has(id));
      assert.equal(missing.length, 0, `zero events lost across the live outage (missing: ${missing.join(', ')})`);
    } finally {
      try {
        sub?.drain();
      } catch {
        /* already dead */
      }
      try {
        await subNc?.close();
      } catch {
        /* already dead */
      }
      await warm.disconnect();
      if (cold) await cold.disconnect();
    }
  },
  { concurrency: false }
);
