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
    await pool.query(`DROP TABLE IF EXISTS brain_window_state, brain_window_cursor, brain_window_dirty, attachments, conversation_participants, messages, participants, conversations CASCADE`);
    // Production shape, reconstructed from the statements that run there (INFRA-370, audited column by column):
    //  - repository.ts INSERT INTO conversations / participants / conversation_participants / messages,
    //    connectors/whatsapp-web/src/db-writer.ts (messages INSERT: no sender_id; metadata.sender_name),
    //  - telegram-sync db.py INSERT INTO messages / attachments
    //  - brain-ingest-lib.ts fetchBatch (messages JOIN conversations), bigint cursor on messages.id
    // Migration 001 (uuid ids, messages.sender_id -> participants) is NOT what production has.
    await pool.query(`
      CREATE TABLE conversations (
        id text PRIMARY KEY, wa_chat_id text, type text, name text, is_group boolean, avatar_url text,
        created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), metadata jsonb,
        account text NOT NULL DEFAULT 'personal');
      CREATE TABLE participants (
        id text PRIMARY KEY, name text, phone text, first_seen timestamp DEFAULT now(),
        last_seen timestamp DEFAULT now(), account text NOT NULL DEFAULT 'personal');
      CREATE TABLE conversation_participants (
        conversation_id text NOT NULL, participant_id text NOT NULL, joined_at timestamp DEFAULT now(),
        PRIMARY KEY (conversation_id, participant_id));
      CREATE TABLE messages (
        id bigserial PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id),
        wa_message_id text NOT NULL UNIQUE, sender_wa_id text NOT NULL, wa_timestamp timestamp NOT NULL,
        direction text NOT NULL DEFAULT 'INBOUND', content text, message_type text NOT NULL DEFAULT 'TEXT',
        is_forwarded boolean DEFAULT false, is_edited boolean DEFAULT false, is_deleted boolean DEFAULT false,
        reply_to_message_id text, platform text NOT NULL, metadata jsonb,
        account text NOT NULL DEFAULT 'personal', created_at timestamp DEFAULT now());
      CREATE TABLE attachments (
        id bigserial PRIMARY KEY, message_id bigint NOT NULL REFERENCES messages(id), file_type text,
        mime_type text, file_name text, file_size bigint, file_url text, duration_seconds int,
        width int, height int, caption text);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS brain_window_dirty (account text NOT NULL, conversation_id text NOT NULL, touched_at timestamptz NOT NULL DEFAULT now(), reason text, PRIMARY KEY (account, conversation_id, touched_at))`);
    await pool.query(readFileSync(join(MIG, '016_brain_window_state.sql'), 'utf8'));
    conv = 'professional:34600111222@s.whatsapp.net'; // real WhatsApp ids carry colons
    await pool.query(`INSERT INTO conversations (id, wa_chat_id, type, name, is_group, account) VALUES ($1, $1, NULL, 'Grupo familia', true, 'personal')`, [conv]); // type NULL + is_group, as in prod
    let n = 0;
    const ins = (ts: string, content: string | null, extra: { type?: string; sender?: string; name?: string; deleted?: boolean; reply?: string | null; platform?: string } = {}) =>
      pool.query(
        `INSERT INTO messages (conversation_id, account, platform, wa_message_id, wa_timestamp, sender_wa_id, content, message_type, is_deleted, reply_to_message_id, metadata, created_at)
         VALUES ($1,'personal',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now() - interval '1 hour')`,
        [conv, extra.platform ?? 'whatsapp', `personal:3EB0${++n}@s.whatsapp.net`, ts, extra.sender ?? '34600', content, extra.type ?? 'TEXT', extra.deleted ?? false, extra.reply ?? null, JSON.stringify(extra.name ? { sender_name: extra.name } : {})]
      );
    await ins('2026-09-28 09:00:00', 'hablamos del pedido');
    await ins('2026-09-28 09:10:00', 'te paso el pedido mañana', { type: 'AUDIO', sender: '34601', name: 'Luis' });
    await ins('2026-09-28 09:20:00', 'vale', { reply: 'personal:3EB02@s.whatsapp.net' }); // reply_to_message_id holds the namespaced wa_message_id
    await ins('2026-09-28 09:25:00', '   '); // blank: not counted
    await ins('2026-09-28 09:26:00', 'borrado', { deleted: true }); // deleted: not counted
    await ins('2026-09-28 09:27:00', 'instagram no entra', { platform: 'instagram' });
    await ins('2026-09-28 11:00:00', 'segunda ventana, gap de 100 min');
    await ins('2026-09-28 11:05:00', 'sigue la segunda ventana del pedido');
    await ins('2026-09-28 11:06:00', 'y una más para llegar a tres mensajes');
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS brain_window_state, brain_window_cursor, brain_window_dirty, attachments, conversation_participants, messages, participants, conversations CASCADE`);
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
    expect(meta).toMatchObject({ platform: 'whatsapp', conversationName: 'Grupo familia', isGroup: true, kind: 'chat' }); // type NULL, is_group true
    const all: string[] = [];
    for await (const m of st.streamChat(pool, 'personal', conv, null, null, 2)) all.push(m.id);
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
    const first = await st.fetchChatPage(pool, 'personal', conv, { fromTs: null, after: null, limit: 10 });
    expect(first[1]).toMatchObject({ sender: 'Luis', isVoice: true });
    expect(first[0].sender).toBe('34600'); // no metadata.sender_name: falls back to sender_wa_id
    expect(first[1].waId).toBe('personal:3EB02@s.whatsapp.net');
    expect(first[2].replyToId).toBe('personal:3EB02@s.whatsapp.net');
    const ranged = await st.fetchChatPage(pool, 'personal', conv, { fromTs: first[3].ts, toTs: first[4].ts, after: null, limit: 10 });
    expect(ranged.map((m) => m.id)).toEqual([first[3].id, first[4].id]);
  });

  it('runAccount end to end on real SQL: windows, state rows, cursor, idempotent rerun, late message', async () => {
    const pushes: Array<{ adapter: string; docs: BrainDoc[] }> = [];
    const keep = (x: { adapter: string; docs: BrainDoc[] }) => pushes.push(x);
    const deps: Deps = {
      db: pool, store: st, kinds: {}, maxLlmPerRun: null, pool: new LlmPool(2), log: { info() {}, warn() {}, error: (m) => console.log('ERR', m) }, sleep: async () => {},
      brain: { push: async (_i, adapter, docs) => (keep({ adapter, docs }), docs.length), deleteWindow: async () => {} },
      chat: async () => good,
    };
    const s1 = await runAccount(deps, 'personal');
    expect(s1).toMatchObject({ chats: 1, windowsPushed: 2, failures: 0 });
    const text = String(pushes[0].docs[0].metadata.window_text);
    expect(text).toContain('Luis: 🎙 te paso el pedido mañana'); // metadata->>'sender_name'
    expect(text).toContain('09:20 34600: vale (resp. a Luis)'); // reply resolved through wa_message_id
    expect(pushes[0].docs[0].metadata.conversation_id).toBe(conv);
    const rows = (await pool.query(`SELECT msg_count, llm_status, pushed_hash = window_hash AS pushed FROM brain_window_state ORDER BY start_ts`)).rows;
    expect(rows.map((r) => r.msg_count)).toEqual([3, 3]); // Σ = 6 counted messages
    expect(rows.every((r) => r.pushed)).toBe(true);
    expect(await st.getCursor(pool, 'personal')).not.toBeNull();

    const n = pushes.length;
    const s2 = await runAccount(deps, 'personal');
    expect(s2.chats).toBe(0);
    expect(pushes).toHaveLength(n);

    // late message (old wa_timestamp, new created_at) inside the first window
    await pool.query(`INSERT INTO messages (conversation_id, account, platform, wa_message_id, wa_timestamp, sender_wa_id, content, message_type, created_at)
                      VALUES ($1,'personal','whatsapp','late','2026-09-28 09:15:00','34600','mensaje tardío','TEXT', now() - interval '30 minutes')`, [conv]);
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

  it('snapshot lags 15 minutes: a message inserted just now is not in the snapshot nor in changedChats', async () => {
    const before = await st.snapshotCursor(pool, 'personal');
    await pool.query(`INSERT INTO messages (conversation_id, account, platform, wa_message_id, wa_timestamp, sender_wa_id, content, message_type)
                      VALUES ($1,'personal','whatsapp','young','2026-09-29 10:00:00','34600','transacción larga, aún no visible','TEXT')`, [conv]);
    const after = await st.snapshotCursor(pool, 'personal');
    expect(after).toEqual(before);
    const ch = await st.changedChats(pool, 'personal', before, after!);
    expect(ch).toEqual([]);
    await pool.query(`UPDATE messages SET created_at = now() - interval '20 minutes' WHERE wa_message_id = 'young'`);
    const aged = await st.snapshotCursor(pool, 'personal');
    expect(aged).not.toEqual(before);
    expect((await st.changedChats(pool, 'personal', before, aged!)).map((c) => c.conversationId)).toEqual([conv]);
  });

  it('pendingLlm on real SQL: null = all, 0 = none, n = LIMIT', async () => {
    await pool.query(`UPDATE brain_window_state SET llm_status = 'pending', pushed_hash = window_hash, push_error = NULL`);
    const n = (await pool.query(`SELECT count(*)::int AS n FROM brain_window_state`)).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await st.pendingLlm(pool, 'personal', null)).toHaveLength(n);
    expect(await st.pendingLlm(pool, 'personal', 0)).toHaveLength(0);
    expect(await st.pendingLlm(pool, 'personal', 1)).toHaveLength(1);
  });

  it('dirty table absent (migration 017 of #148 not applied): listDirty and clearDirty are fail-soft', async () => {
    await pool.query(`DROP TABLE brain_window_dirty`);
    await expect(st.listDirty(pool, 'personal')).resolves.toEqual([]);
    await expect(st.clearDirty(pool, 'personal', { conversationId: conv, seenUpTo: '2026-09-28 09:00:00+00' })).resolves.toBeUndefined();
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
