import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApp } from '../server.mjs';

const connectionString = process.env.WHATSAPP_TEST_DATABASE_URL;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;
const jpeg = Buffer.from([255, 216, 255, 217]);

for (const type of ['uuid', 'bigint']) {
  test(`real app PostgreSQL ${type}: native IDs, precise cursors, media and metadata deletion`, {skip: !connectionString}, async t => {
    assert.match(new URL(connectionString).pathname, /^\/(whatsapp_qa[^/]*|socialmedia_shared_qa)$/);
    const client = new pg.Client({connectionString});
    await client.connect();
    const namespace = `server_native_${randomUUID().replaceAll('-', '')}`;
    const dir = await mkdtemp(join(tmpdir(), 'wa-native-ids-'));
    let app;
    t.after(async () => {
      if (app) await app.close();
      await client.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await client.end();
      await rm(dir, {recursive: true, force: true});
    });
    await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET search_path TO ${namespace}`);
    await client.query(`SET TIME ZONE 'UTC'`);
    // No deleted_at column and only duration_seconds match the NAS lineage.
    await client.query(`CREATE TABLE conversations (id text PRIMARY KEY, account text, name text,
        wa_chat_id text, is_group boolean DEFAULT true, archived boolean DEFAULT false,
        unread_count integer DEFAULT 0, avatar_url text);
      CREATE TABLE participants (id text, account text, name text, push_name text);
      CREATE TABLE messages (id ${type} PRIMARY KEY, account text, conversation_id text, platform text DEFAULT 'whatsapp',
        wa_message_id text, content text, direction text DEFAULT 'INBOUND', message_type text,
        metadata jsonb DEFAULT '{}', reply_to_message_id text, is_edited boolean DEFAULT false,
        is_deleted boolean DEFAULT false, is_forwarded boolean DEFAULT false, status text DEFAULT 'sent',
        sender_wa_id text, wa_timestamp timestamptz, updated_at timestamptz DEFAULT now());
      CREATE INDEX messages_scope_time ON messages(account, conversation_id, wa_timestamp DESC, id DESC);
      CREATE INDEX messages_provider ON messages(account, wa_message_id);
      CREATE TABLE attachments (id ${type === 'bigint' ? 'uuid' : 'bigint'} PRIMARY KEY, message_id ${type} REFERENCES messages(id),
        mime_type text, file_name text, file_type text, file_size bigint, file_url text, storage_key text,
        caption text, duration_seconds integer);
      CREATE INDEX attachments_message ON attachments(message_id);
      CREATE TABLE whatsapp_message_payloads (account text, wa_message_id text, message_payload jsonb,
        PRIMARY KEY(account, wa_message_id));
      CREATE TABLE whatsapp_message_reactions (account text, target_wa_message_id text, reactor_jid text, emoji text, removed boolean);
      INSERT INTO conversations(id, account, name, wa_chat_id) VALUES
        ('chat@g.us', 'personal', 'Group', 'chat@g.us'), ('other@g.us', 'other', 'Other', 'other@g.us');`);
    const ids = type === 'bigint' ? ['2', '10', '9007199254740992', '9007199254740993'] : [2,10,11,12].map(uuid);
    const attachments = type === 'bigint' ? [uuid(500), uuid(501), uuid(502)] : ['2','10','9007199254741093'];
    const idExpr = type === 'bigint' ? '(100000+i)::bigint' : "('10000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid";
    await client.query(`INSERT INTO messages(id, account, conversation_id, wa_message_id, content, message_type, wa_timestamp)
      SELECT ${idExpr}, 'personal', 'chat@g.us', 'history-' || i, 'old', 'TEXT', '2026-01-01'::timestamptz + i*interval '1 second'
      FROM generate_series(1,80000) i`);
    for (let n = 0; n < ids.length; n++) {
      await client.query(`INSERT INTO messages(id, account, conversation_id, wa_message_id, content, message_type, wa_timestamp)
        VALUES($1,'personal','chat@g.us',$2,$3,$4,'2026-10-20 12:00:00.123456+00')`,
      [ids[n], `wa-${n}`, n === 2 ? 'https://example.com/target' : 'target', ['IMAGE','IMAGE','TEXT','VIDEO'][n]]);
      await client.query('INSERT INTO whatsapp_message_payloads VALUES($1,$2,$3)', ['personal', `wa-${n}`, {
        imageMessage: {jpegThumbnail: jpeg.toString('base64')},
        extendedTextMessage: {matchedText:'https://example.com/target', title:'Target', jpegThumbnail: jpeg.toString('base64')},
      }]);
    }
    for (const [n, messageId] of [[0,ids[0]],[1,ids[3]],[2,ids[3]]]) {
      await client.query(`INSERT INTO attachments(id,message_id,mime_type,file_name,file_type,file_url,duration_seconds)
        VALUES($1,$2,'video/mp4','clip.mp4','VIDEO','https://media.example/clip',40)`, [attachments[n], messageId]);
    }
    await client.query('ANALYZE');
    const statements = [];
    const db = {query: async (sql,args) => {
      statements.push({sql,args});
      return client.query(sql,args);
    }};
    app = await createApp({db, env: {DATA_DIR:dir, APP_REALTIME_ENABLED:'false', HERMES_RUNS_ENABLED:'false',
      UI_AUTH_USERNAME:'operator', UI_AUTH_PASSWORD:'password', APP_PUBLIC_URL:'https://wa.example',
      APP_ENABLE_SENDING:'true', PERSONAL_SECRET:'fixture-only', MEDIA_ALLOWED_ORIGINS:'https://media.example'},
    registry:[{channel:'whatsapp', accountId:'personal', connectorUrl:'http://connector', secretEnv:'PERSONAL_SECRET'}],
    fetchImpl: async url => String(url).startsWith('https://media.example/') ? new Response('stored-media') : Response.json({ok:true})});
    await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const get = path => fetch(base+path, {headers:{authorization:auth}});
    const post = body => fetch(base+'/api/messages/delete',{method:'POST',headers:{authorization:auth,
      origin:'https://wa.example','content-type':'application/json'},body:JSON.stringify(body)});
    const suffix = 'account=personal&chat=chat%40g.us';
    const first = await get(`/api/messages?${suffix}&limit=4`);
    assert.equal(first.status,200, await first.clone().text());
    const data = await first.json();
    assert.deepEqual(data.messages.map(row=>row.id),ids);
    assert(data.messages.every(row=>typeof row.id==='string' && !('cursor_timestamp' in row)));
    const decoded = JSON.parse(Buffer.from(data.nextCursor,'base64url').toString());
    assert.match(decoded.timestamp,/\.123456/);
    const enrichment = statements.filter(({sql})=>/m\.id=ANY/.test(sql));
    assert.equal(enrichment.length,3);
    for (const statement of enrichment) {
      assert(!statement.sql.includes('m.id::text'));
      const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.args)).rows[0]['QUERY PLAN'][0];
      const walk = node => [node,...(node.Plans || []).flatMap(walk)];
      const nodes = walk(plan.Plan).filter(node=>node['Relation Name']==='messages');
      assert(nodes.some(node=>node['Index Name']==='messages_pkey'),JSON.stringify(plan));
      assert(!nodes.some(node=>node['Node Type']==='Seq Scan'),JSON.stringify(plan));
      t.diagnostic(`${type} enrichment ${statement.sql.includes('FROM attachments')?'attachments':statement.sql.includes('preview_payload')?'link preview':'thumbnail'}: ${plan['Execution Time']}ms, messages_pkey`);
    }
    const next = await (await get(`/api/messages?${suffix}&limit=4&before=${data.nextCursor}`)).json();
    assert(next.messages.every(row=>!ids.includes(row.id)));
    const around = await get(`/api/messages/around?${suffix}&messageId=${ids[2]}`);
    assert.equal(around.status,200, await around.clone().text());
    assert.deepEqual((await around.json()).messages.filter(row=>ids.includes(row.id)).map(row=>row.id),ids);
    let messageCursor;
    const messagePages = [];
    for (let n=0;n<ids.length;n++) {
      const response = await get(`/api/messages?${suffix}&limit=1${messageCursor?'&before='+messageCursor:''}`);
      assert.equal(response.status,200,await response.clone().text());
      const page = await response.json();
      messagePages.push(page.messages[0].id);
      messageCursor=page.nextCursor;
    }
    assert.deepEqual(messagePages,ids.toReversed());
    assert.equal((await get(`/api/messages/around?${suffix}&messageId=invalid-id`)).status,404);
    const forged = Buffer.from(JSON.stringify({...decoded,id:type==='bigint'?uuid(5):'99'})).toString('base64url');
    assert.equal((await get(`/api/messages?${suffix}&before=${forged}`)).status,400);
    const library = await (await get(`/api/media-library?account=personal&limit=1`)).json();
    assert.equal(library.error,undefined,JSON.stringify(library));
    let cursor;
    const collected = [];
    for (let page=0;page<10;page++) {
      const response = await get(`/api/chats/media?${suffix}&kind=gallery&limit=1${cursor?'&cursor='+cursor:''}`);
      assert.equal(response.status,200,await response.clone().text());
      const pageData = await response.json();
      collected.push(...pageData.items);
      cursor=pageData.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(collected.map(row=>row.id),[attachments[2],attachments[1],ids[1],attachments[0]]);
    const searchFirst = await (await get(`/api/search?${suffix}&q=target&limit=1`)).json();
    assert.equal(searchFirst.results[0].messageId,'wa-3');
    const searchNext = await get(`/api/search?${suffix}&q=target&limit=1&cursor=${searchFirst.nextCursor}`);
    assert.equal(searchNext.status,200,await searchNext.clone().text());
    assert.equal((await searchNext.json()).results[0].messageId,'wa-2');
    for (const [path, expected] of [[`/api/media/${attachments[0]}`, 'stored-media'],
      [`/api/media/thumb/${ids[1]}`,jpeg], [`/api/media/link-thumb/${ids[2]}`,jpeg]]) {
      const response = await get(`${path}?${suffix}`);
      assert.equal(response.status,200,await response.clone().text());
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(expected));
      assert.equal((await get(`${path}?account=personal&chat=other%40g.us`)).status,404);
    }
    for (const path of ['/api/media/not-an-id','/api/media/thumb/not-an-id','/api/media/link-thumb/not-an-id'])
      assert.equal((await get(`${path}?${suffix}`)).status,404);
    const deletion = {account:'personal',chat:'chat@g.us',messageId:ids[0],scope:'everyone'};
    assert.equal((await post({...deletion,messageId:ids[1],scope:'me'})).status,200);
    const localFirst = (await client.query('SELECT metadata,is_deleted,status FROM messages WHERE id=$1',[ids[1]])).rows[0];
    assert.equal(localFirst.metadata.deleted_for_me,true);
    assert.equal(localFirst.metadata.deleted_at,undefined);
    assert.equal(localFirst.is_deleted,false);
    assert.equal(localFirst.status,'sent');
    const afterLocalSearch = await (await get(`/api/search?${suffix}&q=target`)).json();
    assert(!afterLocalSearch.results.some(row=>row.messageId==='wa-1'));
    const afterLocalGallery = await (await get(`/api/chats/media?${suffix}&kind=gallery`)).json();
    assert(!afterLocalGallery.items.some(row=>row.messageId==='wa-1'));
    const afterLocalMessages = await (await get(`/api/messages?${suffix}&limit=10`)).json();
    assert(!afterLocalMessages.messages.some(row=>row.id===ids[1]));
    // A later provider revocation can still claim the row with NOT is_deleted.
    const revoked = await client.query(`UPDATE messages SET is_deleted=true,
      metadata=metadata || jsonb_build_object('deleted_at','2026-10-20T13:00:00Z')
      WHERE id=$1 AND NOT is_deleted RETURNING metadata`,[ids[1]]);
    assert.equal(revoked.rowCount,1);
    assert.equal(revoked.rows[0].metadata.deleted_for_me,true);
    if (type==='uuid') {
      await client.query('ALTER TABLE messages ADD COLUMN deleted_at timestamptz');
      await client.query("UPDATE messages SET deleted_at='2026-10-19T09:20:00Z' WHERE id=$1",[ids[0]]);
    }
    assert.equal((await post(deletion)).status,200);
    const metadata = (await client.query('SELECT metadata FROM messages WHERE id=$1',[ids[0]])).rows[0].metadata;
    assert(Number.isFinite(Date.parse(metadata.deleted_at)));
    if (type==='uuid') assert.equal(new Date(metadata.deleted_at).toISOString(),'2026-10-19T09:20:00.000Z');
    await client.query('UPDATE messages SET is_deleted=false WHERE id=$1',[ids[0]]);
    assert.equal((await post(deletion)).status,200);
    assert.equal((await client.query('SELECT metadata FROM messages WHERE id=$1',[ids[0]])).rows[0].metadata.deleted_at,metadata.deleted_at);
    assert.equal((await post({...deletion,scope:'me'})).status,200);
    const local = (await client.query('SELECT metadata FROM messages WHERE id=$1',[ids[0]])).rows[0].metadata;
    assert.equal(local.deleted_at,metadata.deleted_at);
    assert.equal(local.deleted_for_me,true);
    assert.equal((await get(`/api/media/${attachments[0]}?${suffix}`)).status,404);
  });
}
