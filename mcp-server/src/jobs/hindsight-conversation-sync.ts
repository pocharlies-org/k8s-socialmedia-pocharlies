import { PoolClient } from 'pg';
import { SocialAccount } from '../domain/account-registry';
import { advanceSyncEntry, saveSyncEntry, SyncClient, SyncEntry, SyncOptions, SyncPassResult } from './hindsight-sync-lib';
import { advanceConversationEntry, buildConversationSnapshot, ConversationEntry, ConversationNames,
  ConversationScope, conversationSelectionHash, NamedMessage, newConversationEntry, planConversationUpdate } from './hindsight-conversation-sync-lib';

export async function saveConversationEntry(db: PoolClient, entry: ConversationEntry, delay: number): Promise<void> {
  await db.query(`INSERT INTO hindsight_conversation_documents
    (destination,document_id,scope_key,platform,namespace,provider_account,conversation_id,topic_id,
      source_revision,selection_hash,message_ids,confirmed,pending,status,retry_at,last_operation_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[],$12::jsonb,$13::jsonb,$14,
      now()+($15::double precision * interval '1 millisecond'),$16::uuid)
    ON CONFLICT(destination,document_id) DO UPDATE SET source_revision=EXCLUDED.source_revision,
      selection_hash=EXCLUDED.selection_hash,message_ids=EXCLUDED.message_ids,confirmed=EXCLUDED.confirmed,
      pending=EXCLUDED.pending,status=EXCLUDED.status,retry_at=EXCLUDED.retry_at,
      last_operation_id=EXCLUDED.last_operation_id,updated_at=now()`,
  [entry.destination,entry.documentId,entry.scopeKey,entry.scope.platform,entry.scope.namespace,
    entry.scope.provider_account,entry.scope.conversation_id,entry.scope.topic_id,entry.sourceRevision,
    entry.selectionHash,entry.confirmed?.messageIds || [],entry.confirmed ? JSON.stringify(entry.confirmed) : null,
    entry.pending ? JSON.stringify(entry.pending) : null,entry.status,delay,entry.lastOperationId || null]);
}

export async function seedConversationHistory(db: PoolClient, destination: string, batch: number): Promise<void> {
  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO hindsight_conversation_destinations(destination) VALUES($1) ON CONFLICT DO NOTHING',[destination]);
    const {rows:[state]} = await db.query('SELECT * FROM hindsight_conversation_destinations WHERE destination=$1 FOR UPDATE',[destination]);
    if (!state.seeded) {
      const {rows} = await db.query(`SELECT id FROM messages WHERE ($1::uuid IS NULL OR id>$1::uuid)
        AND hindsight_platform_enabled(platform) ORDER BY id LIMIT $2`,[state.seed_last_id,batch]);
      if (rows.length) {
        // This is a separate cursor from legacy 033; queue changes are global, cursors per destination.
        await db.query(`SELECT hindsight_conversation_enqueue(s) FROM
          (SELECT DISTINCT hindsight_conversation_scope(to_jsonb(m)) AS s FROM messages m WHERE id=ANY($1::uuid[])) scopes`,[rows.map(r=>r.id)]);
      }
      await db.query(`UPDATE hindsight_conversation_destinations SET seed_last_id=COALESCE($2::uuid,seed_last_id),seeded=$3 WHERE destination=$1`,
        [destination,rows.at(-1)?.id || null,rows.length<batch]);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

/** No new legacy snapshots: finish only operations already persisted by 033. */
export async function drainLegacyPending(db: PoolClient, client: SyncClient, destination: string,
  options: SyncOptions): Promise<{remaining:boolean;result:SyncPassResult}> {
  const {rows} = await db.query(`SELECT * FROM hindsight_sync_ledger WHERE destination=$1 AND status<>'completed'
    AND hindsight_platform_enabled(payload->'scope'->>'platform')
    AND retry_at<=now() ORDER BY retry_at LIMIT $2`,[destination,options.batch]);
  const result: SyncPassResult = {selected:rows.length,accepted:0,completed:0,failed:0};
  for (const row of rows) {
    const entry: SyncEntry = {destination:row.destination,messageId:row.message_id,
      sourceRevision:String(row.source_revision),versionHash:row.version_hash,selectionHash:row.selection_hash,
      operationId:row.operation_id,payload:row.payload,isDeleted:row.is_deleted,status:row.status,attempts:row.attempts};
    let persistenceFailed = false;
    try {
      const status = await advanceSyncEntry(entry,client,async (e,delay)=>{
        try { await saveSyncEntry(db,e,delay); } catch(error) { persistenceFailed=true; throw error; }
      },options.retryMs);
      if (status==='completed') result.completed++; else result.accepted++;
    } catch(error) { if(persistenceFailed) throw error; result.failed++; }
  }
  const {rows:[state]} = await db.query(`SELECT EXISTS(SELECT 1 FROM hindsight_sync_ledger
    WHERE destination=$1 AND status<>'completed'
      AND hindsight_platform_enabled(payload->'scope'->>'platform')) AS remaining`,[destination]);
  return {remaining:state.remaining,result};
}

function usefulName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name && !/@(?:c\.us|s\.whatsapp\.net|lid|g\.us)$/.test(name) ? name : undefined;
}
function unscopedId(id: string, namespace: string): string {
  return namespace !== 'personal' && id.startsWith(namespace+':') ? id.slice(namespace.length+1) : id;
}

export async function loadConversationSnapshot(db: PoolClient, scope: ConversationScope,
  accounts: SocialAccount[], options: SyncOptions): Promise<ReturnType<typeof buildConversationSnapshot>> {
  const {rows} = await db.query(`SELECT m.*,p.name AS participant_name,p.push_name AS participant_push_name,
    sa.label AS account_label FROM messages m
    LEFT JOIN participants p ON p.id=m.sender_wa_id AND p.account=m.account
      AND (p.account_id IS NULL OR p.account_id=$5)
    LEFT JOIN social_accounts sa ON sa.id=$5
    WHERE m.platform=$1 AND m.account=$2 AND m.conversation_id=$3
      AND CASE WHEN m.platform='instagram' THEN COALESCE(m.metadata->>'instagram_account','') ELSE m.account END=$4
      AND CASE WHEN m.platform='telegram' THEN COALESCE(NULLIF(m.metadata->>'topic_id',''),NULLIF(m.metadata->>'thread_id',''),
        NULLIF(m.metadata->>'telegram_topic_id',''),'') ELSE '' END=$6
    ORDER BY m.wa_timestamp,m.id`,[scope.platform,scope.namespace,scope.conversation_id,scope.provider_account,
      `${scope.platform}:${scope.provider_account}`,scope.topic_id]);
  const {rows:[chat]} = await db.query('SELECT name,metadata FROM conversations WHERE id=$1 AND account=$2',
    [scope.conversation_id,scope.namespace]);
  const {rows:members} = await db.query(`SELECT p.id,p.name,p.push_name FROM conversation_participants cp
    JOIN participants p ON p.id=cp.participant_id AND p.account=$2 AND (p.account_id IS NULL OR p.account_id=$3)
    WHERE cp.conversation_id=$1`,[scope.conversation_id,scope.namespace,`${scope.platform}:${scope.provider_account}`]);
  let contacts: Array<{jid:string;name:string|null;push_name:string|null}> = [];
  let aliases: Array<{alias_external_id:string;canonical_external_id:string}> = [];
  if(scope.platform==='whatsapp') {
    const {rows:[exists]} = await db.query("SELECT to_regclass('whatsapp_contacts') IS NOT NULL AS available");
    if(exists.available) contacts=(await db.query('SELECT jid,name,push_name FROM whatsapp_contacts WHERE account=$1',[scope.namespace])).rows;
    aliases=(await db.query(`SELECT alias_external_id,canonical_external_id FROM social_contact_aliases
      WHERE account_id=$1 AND evidence<>'blocked'`,[`whatsapp:${scope.provider_account}`])).rows;
  }
  const contactName = (id: string) => {
    const raw=unscopedId(id,scope.namespace);
    const ids=new Set([raw,raw.replace(/@c\.us$/,'@s.whatsapp.net'),raw.replace(/@s\.whatsapp\.net$/,'@c.us')]);
    const mapped=aliases.filter(a=>ids.has(a.alias_external_id)||ids.has(a.canonical_external_id))
      .flatMap(a=>[a.alias_external_id,a.canonical_external_id]);
    // A LID is not a phone number. Resolve only explicit account-scoped, unambiguous PN evidence.
    const pns=[...new Set(mapped.filter(v=>/@(?:c\.us|s\.whatsapp\.net)$/.test(v)).map(v=>v.replace(/@c\.us$/,'@s.whatsapp.net')))];
    if(pns.length<=1) mapped.forEach(v=>ids.add(v));
    const matched=contacts.filter(c=>ids.has(unscopedId(c.jid,scope.namespace)));
    return matched.map(c=>usefulName(c.name)).find(Boolean) || matched.map(c=>usefulName(c.push_name)).find(Boolean);
  };
  const account=accounts.find(a=>a.channel===scope.platform && a.namespace===scope.namespace && a.accountId===scope.provider_account);
  const accountName=usefulName(rows[0]?.account_label) || account?.label || scope.provider_account;
  const messages: NamedMessage[]=rows.map(row=>({...row,sender_name:scope.platform==='whatsapp'
    ? contactName(row.sender_wa_id || '') || usefulName(row.participant_name) || usefulName(row.participant_push_name) || usefulName(row.metadata?.sender_name)
    : usefulName(row.participant_name) || usefulName(row.participant_push_name) || usefulName(row.metadata?.sender_name)}));
  const names:ConversationNames={accountName,
    title:contactName(scope.conversation_id) || usefulName(chat?.name) || 'Conversation',
    topicName:scope.topic_id ? usefulName(chat?.metadata?.topics?.[scope.topic_id]?.title) ||
      usefulName(rows.find(r=>r.metadata?.topic_name || r.metadata?.topic_title)?.metadata?.topic_name) ||
      usefulName(rows.find(r=>r.metadata?.topic_title)?.metadata?.topic_title) : undefined,
    participants:[...members.map(m=>contactName(m.id)||usefulName(m.name)||usefulName(m.push_name)||''),
      ...messages.map(m=>m.direction==='OUTBOUND'?accountName:m.sender_name || '')]};
  return buildConversationSnapshot(scope,messages,names,accounts,options);
}

export async function runConversationSyncPass(db: PoolClient, client: SyncClient, destination: string,
  accounts: SocialAccount[], options: SyncOptions): Promise<SyncPassResult> {
  // The connector may create its phonebook after migrations on a fresh install.
  await db.query(`DO $$ BEGIN
    IF to_regclass('whatsapp_contacts') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_trigger
      WHERE tgrelid=to_regclass('whatsapp_contacts') AND tgname='trg_hindsight_contact_name') THEN
      CREATE TRIGGER trg_hindsight_contact_name AFTER INSERT OR DELETE OR UPDATE OF name,push_name,phone ON whatsapp_contacts
        FOR EACH ROW EXECUTE FUNCTION hindsight_conversation_name_change();
    END IF;
  END $$`);
  const legacy=await drainLegacyPending(db,client,destination,options);
  if(legacy.remaining) return legacy.result;
  await seedConversationHistory(db,destination,options.batch);
  const hash=conversationSelectionHash(accounts,options);
  const scopes=accounts.filter(a=>a.enabled).map(a=>({platform:a.channel,namespace:a.namespace,provider_account:a.accountId}));
  const {rows:candidates}=await db.query(`SELECT c.scope_key,c.scope,c.revision::text,
    CASE WHEN d.document_id IS NULL THEN NULL ELSE to_jsonb(d) END AS document
    FROM hindsight_conversation_changes c
    LEFT JOIN hindsight_conversation_documents d ON d.destination=$1 AND d.scope_key=c.scope_key
    WHERE (d.document_id IS NULL OR d.pending IS NOT NULL OR d.source_revision<>c.revision OR d.selection_hash<>$2)
      AND hindsight_platform_enabled(c.scope->>'platform')
      AND (d.pending IS NULL OR d.retry_at<=now())
      AND (d.document_id IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb)
        s(platform text,namespace text,provider_account text) WHERE c.scope->>'platform'=s.platform
          AND c.scope->>'namespace'=s.namespace AND c.scope->>'provider_account'=s.provider_account)
        AND (cardinality($5::text[])=0 OR c.scope->>'conversation_id'=ANY($5::text[])))
    ORDER BY (d.pending IS NOT NULL) DESC,c.revision LIMIT $4`,[destination,hash,JSON.stringify(scopes),options.batch,options.chatIds]);
  const result:SyncPassResult={selected:candidates.length,accepted:0,completed:0,failed:0};
  for(const c of candidates) {
    const d=c.document;
    let entry:ConversationEntry=d ? {destination,documentId:d.document_id,scopeKey:c.scope_key,scope:c.scope,
      sourceRevision:String(d.source_revision),selectionHash:d.selection_hash,confirmed:d.confirmed,
      pending:d.pending,status:d.status,lastOperationId:d.last_operation_id || undefined} : newConversationEntry(destination,c.scope_key,c.scope);
    if(!entry.pending) {
      const snapshot=await loadConversationSnapshot(db,c.scope,accounts,options);
      entry=planConversationUpdate(entry,snapshot,c.revision,hash);
      await saveConversationEntry(db,entry,0);
    }
    let persistenceFailed=false;
    try {
      const status=await advanceConversationEntry(entry,client,async(e,delay)=>{
        try {await saveConversationEntry(db,e,delay);} catch(error){persistenceFailed=true;throw error;}
      },options.retryMs);
      if(status==='completed') result.completed++; else result.accepted++;
    } catch(error){if(persistenceFailed)throw error;result.failed++;}
  }
  return result;
}
