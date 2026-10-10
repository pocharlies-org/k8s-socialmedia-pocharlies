/** Synthetic fanout regression in a disposable PostgreSQL database. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const url=process.env.HINDSIGHT_TEST_DATABASE_URL;
const integration=url?it:it.skip;

integration('a real rename invalidates each of 1158 topics once; no-op and paused updates do no work',async()=>{
  if(!new URL(url!).pathname.startsWith('/hindsight_qa'))throw new Error('Disposable QA database required');
  const pool=new Pool({connectionString:url});const db=await pool.connect();
  const chat=`telegram:personal:qa-${randomUUID()}`;
  try{
    await db.query('BEGIN');
    await db.query(`INSERT INTO hindsight_sync_platform_policy(platform,enabled) VALUES('telegram',true)
      ON CONFLICT(platform) DO UPDATE SET enabled=true`);
    await db.query(`INSERT INTO conversations(id,wa_chat_id,type,account,account_id,name)
      VALUES($1::text,$1::text,'GROUP','personal','telegram:personal','Original')`,[chat]);
    await db.query(`INSERT INTO messages(id,conversation_id,wa_message_id,wa_timestamp,direction,sender_wa_id,
      content,content_hash,message_type,platform,account,metadata)
      SELECT gen_random_uuid(),$1,'qa-topic-'||i,now(),'INBOUND','synthetic','Synthetic turn','qa','TEXT',
      'telegram','personal',jsonb_build_object('topic_id',i) FROM generate_series(1,1158) i`,[chat]);
    await db.query(`CREATE TEMP TABLE qa_hindsight_updates(scope_key text);
      CREATE FUNCTION pg_temp.capture_hindsight_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO pg_temp.qa_hindsight_updates VALUES(NEW.scope_key); RETURN NEW; END $$;
      CREATE TRIGGER qa_hindsight_update_count BEFORE UPDATE ON hindsight_conversation_changes
        FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_hindsight_update()`);
    const counter=async()=>BigInt((await db.query('SELECT last_value FROM hindsight_conversation_revision_seq')).rows[0].last_value);
    const before=await counter();
    await db.query('UPDATE conversations SET name=name,updated_at=now() WHERE id=$1',[chat]);
    expect(await counter()).toBe(before);
    await db.query("UPDATE conversations SET name='Renamed' WHERE id=$1",[chat]);
    const {rows:[writes]}=await db.query('SELECT count(*)::int AS n FROM qa_hindsight_updates');
    expect(writes.n).toBe(1158);
    const {rows:[total]}=await db.query(`SELECT count(*)::int AS n FROM hindsight_conversation_changes
      WHERE scope->>'conversation_id'=$1`,[chat]);
    expect(total.n).toBe(1158);
    await db.query(`INSERT INTO hindsight_sync_platform_policy(platform,enabled) VALUES('telegram',false)
      ON CONFLICT(platform) DO UPDATE SET enabled=false`);
    const paused=await counter();
    await db.query("UPDATE conversations SET name='Paused rename' WHERE id=$1",[chat]);
    expect(await counter()).toBe(paused);
  }finally{await db.query('ROLLBACK');db.release();await pool.end();}
},30000);
