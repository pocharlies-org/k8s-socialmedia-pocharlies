/** Synthetic data only in a disposable, fully migrated database. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { defaultRegistry } from '../domain/account-registry';
import { configureHindsightPlatformPolicy } from './hindsight-platform-policy';
import { runConversationSyncPass } from './hindsight-conversation-sync';
import { syncOptionsFromEnv } from './hindsight-sync-lib';

const url = process.env.HINDSIGHT_TEST_DATABASE_URL;
const integration = url ? it : it.skip;

integration('pauses Telegram capture and queued operations without deleting them; WhatsApp continues', async () => {
  if (!new URL(url!).pathname.startsWith('/hindsight_qa')) throw new Error('Disposable QA database required');
  const pool = new Pool({connectionString:url}); const db = await pool.connect();
  const telegram = `telegram:personal:qa-${randomUUID()}`;
  const whatsapp = `qa-${randomUUID()}@c.us`;
  const destination = `policy-qa-${randomUUID()}`;
  const legacyOperation = randomUUID();
  const insert = async (chat:string, platform:string) => {
    const id = randomUUID();
    await db.query(`INSERT INTO messages(id,conversation_id,wa_message_id,wa_timestamp,direction,
      sender_wa_id,content,content_hash,message_type,platform,account,metadata)
      VALUES($1::uuid,$2,$1::text,now(),'INBOUND','synthetic','Synthetic message','qa','TEXT',$3,'personal',$4)`,
    [id,chat,platform,JSON.stringify(platform==='telegram'?{topic_id:125}:{})]);
    return id;
  };
  try {
    await configureHindsightPlatformPolicy(db, {});
    for (const [chat, accountId] of [[telegram,'telegram:personal'],[whatsapp,'whatsapp:personal']]) {
      await db.query(`INSERT INTO conversations(id,wa_chat_id,type,account,account_id,name)
        VALUES($1::text,$1::text,'GROUP','personal',$2,'Synthetic title')`, [chat,accountId]);
    }
    const tgId = await insert(telegram,'telegram');
    const {rows:[scope]} = await db.query(`SELECT * FROM hindsight_conversation_changes WHERE scope->>'conversation_id'=$1`,[telegram]);
    // Deliberately opaque pending state: a paused entry must never be inspected or submitted.
    await db.query(`INSERT INTO hindsight_conversation_documents(destination,document_id,scope_key,platform,namespace,
      provider_account,conversation_id,topic_id,source_revision,selection_hash,pending,status)
      VALUES($1,'paused-document',$2,'telegram','personal','personal',$3,'125',$4,'old','{}','pending')`,
    [destination,scope.scope_key,telegram,scope.revision]);
    await db.query(`INSERT INTO hindsight_sync_ledger(destination,message_id,source_revision,version_hash,
      selection_hash,operation_id,payload,is_deleted,status)
      VALUES($1,$2,1,'old','old',$3,'{"scope":{"platform":"telegram"}}',false,'pending')`,
    [destination,tgId,legacyOperation]);
    await configureHindsightPlatformPolicy(db, {HINDSIGHT_SYNC_EXCLUDED_PLATFORMS:'telegram'});
    const pausedId = await insert(telegram,'telegram');
    await db.query("UPDATE messages SET content='Changed during pause' WHERE id=$1",[tgId]);
    await db.query("UPDATE conversations SET name='Renamed during pause' WHERE id=$1",[telegram]);
    expect((await db.query('SELECT revision FROM hindsight_conversation_changes WHERE scope_key=$1',[scope.scope_key])).rows[0].revision).toBe(scope.revision);
    expect((await db.query('SELECT 1 FROM hindsight_sync_changes WHERE message_id=$1',[pausedId])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM messages WHERE id=$1',[pausedId])).rows).toHaveLength(1);

    await insert(whatsapp,'whatsapp');
    const revision = async () => (await db.query(`SELECT revision FROM hindsight_conversation_changes
      WHERE scope->>'conversation_id'=$1`,[whatsapp])).rows[0].revision;
    const unchanged = await revision();
    await db.query('UPDATE conversations SET name=name,updated_at=now() WHERE id=$1',[whatsapp]);
    expect(await revision()).toBe(unchanged);
    await db.query("UPDATE conversations SET name='Real rename' WHERE id=$1",[whatsapp]);
    expect(await revision()).not.toBe(unchanged);

    const submissions:Array<string> = [];
    const client = {
      getOperation:async (id:string) => {
        expect(typeof id).toBe('string'); expect(id).not.toBe(legacyOperation);
        return {operationId:id,status:'not_found' as const};
      },
      retryOperation:async () => { throw new Error('Paused operation must not be retried'); },
      deleteDocument:async () => { throw new Error('Pause must not delete documents'); },
      retainDocument:async (input:{documentId:string;operationId:string;content:string}) => {
        submissions.push(input.content); return {operationId:input.operationId};
      },
    };
    const options = syncOptionsFromEnv({HINDSIGHT_SYNC_CHAT_IDS:`${telegram},${whatsapp}`});
    await runConversationSyncPass(db,client,destination,defaultRegistry(),options);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toContain('"platform":"whatsapp"');
    expect((await db.query(`SELECT pending FROM hindsight_conversation_documents WHERE destination=$1
      AND platform='telegram'`,[destination])).rows[0].pending).toEqual({});
    expect((await db.query(`SELECT status FROM hindsight_sync_ledger WHERE destination=$1`,[destination])).rows[0].status).toBe('pending');

    await configureHindsightPlatformPolicy(db, {});
    await insert(telegram,'telegram');
    expect((await db.query('SELECT revision FROM hindsight_conversation_changes WHERE scope_key=$1',[scope.scope_key])).rows[0].revision).not.toBe(scope.revision);
  } finally { db.release(); await pool.end(); }
},30000);
