/**
 * Real-Postgres check of state.ts SQL + the advisory lock. Skipped unless
 * TEST_DATABASE_URL points at a SCRATCH database (it creates and drops tables
 * named messages/conversations/participants/brain_window_*).
 *   docker run -d --rm -e POSTGRES_PASSWORD=t -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres pnpm --filter @mcp-socialmedia/server test brain-windows/state.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import type { BrainDoc } from '../brain-ingest-lib';
import { runAccount, type Deps } from './brain-windows';
import { LlmPool } from './llm-pool';
import * as st from './state';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;
const MIG = join(__dirname, '..', '..', 'infrastructure', 'database', 'migrations');
const good = JSON.stringify({ summary: 'Acuerdan el pedido.', topics: ['pedido'], entities: [{ type: 'Person', name: 'Luis' }], patterns: [], skip: null });

d('state.ts against Postgres', () => {
  let pool: Pool;
  let conv: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    await pool.query(`DROP TABLE IF EXISTS brain_window_state, brain_window_cursor, brain_window_dirty, messages, participants, conversations CASCADE`);
    await pool.query(`
      CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, type text);
      CREATE TABLE participants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, name text);
      CREATE TABLE messages (
        id bigserial PRIMARY KEY, conversation_id uuid, account text, platform text, wa_message_id text,
        wa_timestamp timestamp, sender_id uuid, sender_wa_id text, content text, message_type text,
        is_deleted boolean DEFAULT false, reply_to_message_id bigint, created_at timestamp DEFAULT now());`);
    await pool.query(readFileSync(join(MIG, '016_brain_window_state.sql'), 'utf8'));
    await pool.query(`CREATE TABLE IF NOT EXISTS brain_window_dirty (account text NOT NULL, conversation_id text NOT NULL, touched_at timestamptz NOT NULL DEFAULT now(), reason text, PRIMARY KEY (account, conversation_id, touched_at))`);
    conv = (await pool.query(`INSERT INTO conversations (name, type) VALUES ('Grupo familia', 'GROUP') RETURNING id`)).rows[0].id;
    const p = (await pool.query(`INSERT INTO participants (conversation_id, name) VALUES ($1, 'Luis') RETURNING id`, [conv])).rows[0].id;
    const ins = (ts: string, content: string | null, extra: { type?: string; sender?: string | null; deleted?: boolean; reply?: number | null; platform?: string } = {}) =>
      pool.query(
        `INSERT INTO messages (conversation_id, account, platform, wa_message_id, wa_timestamp, sender_id, sender_wa_id, content, message_type, is_deleted, reply_to_message_id)
         VALUES ($1,'personal',$2,gen_random_uuid()::text,$3,$4,'34600',$5,$6,$7,$8)`,
        [conv, extra.platform ?? 'whatsapp', ts, extra.sender ?? null, content, extra.type ?? 'TEXT', extra.deleted ?? false, extra.reply ?? null]
      );
    await ins('2026-09-28 09:00:00', 'hablamos del pedido');
    await ins('2026-09-28 09:10:00', 'te paso el pedido mañana', { type: 'AUDIO', sender: p });
    await ins('2026-09-28 09:20:00', 'vale', { reply: 2 });
    await ins('2026-09-28 09:25:00', '   '); // blank: not counted
    await ins('2026-09-28 09:26:00', 'borrado', { deleted: true }); // deleted: not counted
    await ins('2026-09-28 09:27:00', 'instagram no entra', { platform: 'instagram' });
    await ins('2026-09-28 11:00:00', 'segunda ventana, gap de 100 min');
    await ins('2026-09-28 11:05:00', 'sigue la segunda ventana del pedido');
    await ins('2026-09-28 11:06:00', 'y una más para llegar a tres mensajes');
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS brain_window_state, brain_window_cursor, brain_window_dirty, messages, participants, conversations CASCADE`);
    await pool?.end();
  });

  it('snapshot / changedChats / allChats count exactly the counted messages (rule 4, no instagram)', async () => {
    const snap = await st.snapshotCursor(pool, 'personal');
    expect(snap).not.toBeNull();
    const ch = await st.changedChats(pool, 'personal', null, snap!);
    expect(ch).toHaveLength(1);
    expect(ch[0].conversationId).toBe(conv);
    expect(await st.allChats(pool, 'personal')).toEqual([conv]);
    expect(await st.changedChats(pool, 'personal', snap, snap!)).toEqual([]);
  });

  it('conversationMeta + keyset paging give ordered, deduplicated pages with voice and reply', async () => {
    const meta = await st.conversationMeta(pool, 'personal', conv, {});
    expect(meta).toMatchObject({ platform: 'whatsapp', conversationName: 'Grupo familia', isGroup: true, kind: 'chat' });
    const all: string[] = [];
    for await (const m of st.streamChat(pool, 'personal', conv, null, null, 2)) all.push(m.id);
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
    const first = await st.fetchChatPage(pool, 'personal', conv, { fromTs: null, after: null, limit: 10 });
    expect(first[1]).toMatchObject({ sender: 'Luis', isVoice: true });
    expect(first[0].sender).toBe('34600'); // no participant: falls back to sender_wa_id
    expect(first[2].replyToId).toBe('2');
    const ranged = await st.fetchChatPage(pool, 'personal', conv, { fromTs: first[3].ts, toTs: first[4].ts, after: null, limit: 10 });
    expect(ranged.map((m) => m.id)).toEqual([first[3].id, first[4].id]);
  });

  it('runAccount end to end on real SQL: windows, state rows, cursor, idempotent rerun, late message', async () => {
    const pushes: Array<{ adapter: string; docs: BrainDoc[] }> = [];
    const deps: Deps = {
      db: pool, store: st, kinds: {}, maxLlmPerRun: null, pool: new LlmPool(2), log: { info() {}, warn() {}, error: (m) => console.log('ERR', m) }, sleep: async () => {},
      brain: { push: async (_i, adapter, docs) => (pushes.push({ adapter, docs }), docs.length), deleteWindow: async () => {} },
      chat: async () => good,
    };
    const s1 = await runAccount(deps, 'personal');
    expect(s1).toMatchObject({ chats: 1, windowsPushed: 2, failures: 0 });
    const rows = (await pool.query(`SELECT msg_count, llm_status, pushed_hash = window_hash AS pushed FROM brain_window_state ORDER BY start_ts`)).rows;
    expect(rows.map((r) => r.msg_count)).toEqual([3, 3]); // Σ = 6 counted messages
    expect(rows.every((r) => r.pushed)).toBe(true);
    expect(await st.getCursor(pool, 'personal')).not.toBeNull();

    const n = pushes.length;
    const s2 = await runAccount(deps, 'personal');
    expect(s2.chats).toBe(0);
    expect(pushes).toHaveLength(n);

    // late message (old wa_timestamp, new created_at) inside the first window
    await pool.query(`INSERT INTO messages (conversation_id, account, platform, wa_message_id, wa_timestamp, sender_wa_id, content, message_type)
                      VALUES ($1,'personal','whatsapp','late','2026-09-28 09:15:00','34600','mensaje tardío','TEXT')`, [conv]);
    const s3 = await runAccount(deps, 'personal');
    expect(s3.windowsPushed).toBe(1);
    expect(s3.windowsUnchanged).toBe(1);
    expect((await pool.query(`SELECT msg_count FROM brain_window_state ORDER BY start_ts`)).rows.map((r) => r.msg_count)).toEqual([4, 3]);

    // dirty mailbox: read, processed, cleared
    await pool.query(`INSERT INTO brain_window_dirty (account, conversation_id, reason) VALUES ('personal', $1, 'test')`, [conv]);
    const s4 = await runAccount(deps, 'personal');
    expect(s4.chats).toBe(1);
    expect(s4.windowsPushed).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM brain_window_dirty`)).rows[0].n).toBe(0);
  });

  it('pg_try_advisory_lock: the second session does not get it; it does after release', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      expect(await st.tryLock(a)).toBe(true);
      expect(await st.tryLock(b)).toBe(false);
      await st.unlock(a);
      expect(await st.tryLock(b)).toBe(true);
      await st.unlock(b);
    } finally {
      a.release();
      b.release();
    }
  });
});
