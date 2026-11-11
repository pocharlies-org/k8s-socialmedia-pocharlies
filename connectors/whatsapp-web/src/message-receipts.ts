import { jidNormalizedUser } from '@whiskeysockets/baileys';
import {
  accountKey,
  canonicalConversationId,
  connectorAccount,
  getPool,
  setMessageStatus,
  stripAccountKey,
} from './db-writer';
import { inTransaction } from './db-transaction';

export interface ReceiptIdentity {
  participantId: string;
  aliases: string[];
  name: string | null;
}
export interface CapturedReceipt extends ReceiptIdentity {
  deliveredAt: string | null;
  readAt: string | null;
  playedAt: string | null;
}
// CONTRACT: db.whatsapp-message-receipts.v1
export const RECEIPTS_DDL = `
CREATE TABLE IF NOT EXISTS whatsapp_message_receipt_state (
  account text NOT NULL, chat_id text NOT NULL, message_id text NOT NULL,
  recipients jsonb, aggregate_status text, observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS whatsapp_message_receipts (
  account text NOT NULL, chat_id text NOT NULL, message_id text NOT NULL,
  participant_id text NOT NULL, aliases text[] NOT NULL, name text,
  delivered_at timestamptz, read_at timestamptz, played_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, chat_id, message_id, participant_id)
);`;
export async function ensureMessageReceiptTables(): Promise<void> {
  await inTransaction(getPool(), async db => {
    await db.query('SELECT pg_advisory_xact_lock($1,$2)', [20261011, 38]);
    await db.query(RECEIPTS_DDL);
  });
}

export function receiptJid(value: string): string {
  return jidNormalizedUser(value.replace(/@c\.us$/, '@s.whatsapp.net'));
}
// Live rc13 receipts are seconds; history protobuf values can be Long objects.
export function receiptTime(value: unknown): string | null {
  const n =
    typeof value === 'number'
      ? value
      : value && typeof (value as any).toNumber === 'function'
        ? (value as any).toNumber()
        : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 8_640_000_000_000) return null;
  return new Date(n * 1000).toISOString();
}
const ranks: Record<string, number> = { pending: 1, sent: 2, delivered: 3, read: 4 };
export function mergeStatus(current: string | null, incoming: string | null): string | null {
  if (!incoming) return current;
  if (current === 'deleted' || current === 'failed') return current;
  if (incoming === 'failed') return ranks[current || ''] > 2 ? current : incoming;
  return (ranks[incoming] || 0) > (ranks[current || ''] || 0) ? incoming : current;
}
function earliest(a: string | null, b: string | null): string | null {
  return !a ? b : !b ? a : a < b ? a : b;
}
export function mergeReceiptRows(
  rows: CapturedReceipt[],
  identities: ReceiptIdentity[] = []
): CapturedReceipt[] {
  const parents = new Map<string, string>();
  const root = (id: string): string => {
    if (!parents.has(id)) parents.set(id, id);
    let top = id;
    while (parents.get(top) !== top) top = parents.get(top)!;
    while (id !== top) {
      const next = parents.get(id)!;
      parents.set(id, top);
      id = next;
    }
    return top;
  };
  // Build equivalence classes once; repeated scans of every group member are quadratic.
  for (const identity of [...identities, ...rows]) {
    for (const alias of identity.aliases) parents.set(root(alias), root(identity.participantId));
  }
  const known = new Map<string, ReceiptIdentity>();
  for (const identity of identities)
    if (!known.has(root(identity.participantId))) known.set(root(identity.participantId), identity);
  const grouped = new Map<string, CapturedReceipt>();
  const aliases = new Map<string, Set<string>>();
  for (const id of parents.keys()) {
    const key = root(id);
    if (!aliases.has(key)) aliases.set(key, new Set());
    aliases.get(key)!.add(id);
  }
  for (const row of rows) {
    const key = root(row.participantId);
    const previous = grouped.get(key);
    if (!previous) grouped.set(key, { ...row, aliases: [...aliases.get(key)!] });
    else {
      previous.name ||= row.name;
      previous.deliveredAt = earliest(previous.deliveredAt, row.deliveredAt);
      previous.readAt = earliest(previous.readAt, row.readAt);
      previous.playedAt = earliest(previous.playedAt, row.playedAt);
    }
  }
  for (const [key, row] of grouped) {
    const identity = known.get(key);
    if (identity) {
      row.participantId = identity.participantId;
      row.name ||= identity.name;
    }
  }
  return [...grouped.values()];
}
function fromRow(r: any): CapturedReceipt {
  return {
    participantId: r.participant_id,
    aliases: r.aliases,
    name: r.name,
    deliveredAt: r.delivered_at?.toISOString() || null,
    readAt: r.read_at?.toISOString() || null,
    playedAt: r.played_at?.toISOString() || null,
  };
}
async function scope(chatId: string, messageId: string): Promise<string[]> {
  return [
    connectorAccount(),
    await canonicalConversationId(chatId.replace(/@s\.whatsapp\.net$/, '@c.us')),
    stripAccountKey(messageId),
  ];
}
export function completeReceiptStatus(
  rows: CapturedReceipt[],
  recipients: ReceiptIdentity[] | null
): 'delivered' | 'read' | null {
  if (!recipients?.length) return null;
  const merged = mergeReceiptRows(rows, recipients);
  const byAlias = new Map<string, CapturedReceipt>();
  for (const row of merged) for (const id of row.aliases) byAlias.set(id, row);
  const matched = recipients.map(person => person.aliases.map(id => byAlias.get(id)).find(Boolean));
  if (matched.every(row => row?.readAt || row?.playedAt)) return 'read';
  if (matched.every(row => row?.deliveredAt || row?.readAt || row?.playedAt)) return 'delivered';
  return null;
}

/** No message foreign key: a provider receipt can arrive before its message row. */
export async function recordMessageReceipt(
  chatId: string,
  messageId: string,
  receipt: CapturedReceipt
): Promise<void> {
  if (![receipt.deliveredAt, receipt.readAt, receipt.playedAt].some(Boolean)) return;
  const params = await scope(chatId, messageId);
  const aggregate = await inTransaction(getPool(), async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      JSON.stringify(params),
    ]);
    const state = await db.query(
      'SELECT recipients FROM whatsapp_message_receipt_state WHERE account=$1 AND chat_id=$2 AND message_id=$3',
      params
    );
    const existing = await db.query(
      'SELECT * FROM whatsapp_message_receipts WHERE account=$1 AND chat_id=$2 AND message_id=$3',
      params
    );
    const recipients = state.rows[0]?.recipients ?? null;
    const merged = mergeReceiptRows([...existing.rows.map(fromRow), receipt], recipients || []);
    const row = merged.find(r => r.aliases.some(id => receipt.aliases.includes(id)))!;
    const removed = existing.rows
      .filter(
        r =>
          r.participant_id !== row.participantId &&
          r.aliases.some((id: string) => row.aliases.includes(id))
      )
      .map(r => r.participant_id);
    // Touch only this person's aliases, never rewrite the other members' receipts.
    if (removed.length)
      await db.query(
        'DELETE FROM whatsapp_message_receipts WHERE account=$1 AND chat_id=$2 AND message_id=$3 AND participant_id=ANY($4::text[])',
        [...params, removed]
      );
    await db.query(
      `INSERT INTO whatsapp_message_receipts
      (account,chat_id,message_id,participant_id,aliases,name,delivered_at,read_at,played_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (account,chat_id,message_id,participant_id) DO UPDATE SET
        aliases=EXCLUDED.aliases,name=COALESCE(EXCLUDED.name,whatsapp_message_receipts.name),
        delivered_at=LEAST(whatsapp_message_receipts.delivered_at,EXCLUDED.delivered_at),
        read_at=LEAST(whatsapp_message_receipts.read_at,EXCLUDED.read_at),
        played_at=LEAST(whatsapp_message_receipts.played_at,EXCLUDED.played_at),observed_at=now()`,
      [
        ...params,
        row.participantId,
        row.aliases,
        row.name,
        row.deliveredAt,
        row.readAt,
        row.playedAt,
      ]
    );
    return completeReceiptStatus(merged, recipients);
  });
  if (aggregate) await recordAggregateStatus(chatId, messageId, aggregate);
}
export async function recordRecipientSnapshot(
  chatId: string,
  messageId: string,
  recipients: ReceiptIdentity[]
): Promise<void> {
  const unique = mergeReceiptRows(
    recipients.map(r => ({ ...r, deliveredAt: null, readAt: null, playedAt: null })),
    recipients
  ).map(({ participantId, aliases, name }) => ({ participantId, aliases, name }));
  const params = await scope(chatId, messageId);
  const aggregate = await inTransaction(getPool(), async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      JSON.stringify(params),
    ]);
    const state = await db.query(
      `INSERT INTO whatsapp_message_receipt_state (account,chat_id,message_id,recipients)
    VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (account,chat_id,message_id)
    DO UPDATE SET recipients=COALESCE(whatsapp_message_receipt_state.recipients, EXCLUDED.recipients) RETURNING recipients`,
      [...params, JSON.stringify(unique)]
    );
    const rows = await db.query(
      'SELECT * FROM whatsapp_message_receipts WHERE account=$1 AND chat_id=$2 AND message_id=$3',
      params
    );
    return completeReceiptStatus(rows.rows.map(fromRow), state.rows[0]?.recipients || unique);
  });
  if (aggregate) await recordAggregateStatus(chatId, messageId, aggregate);
}
async function verifiedReceiptAliases(params: string[]): Promise<string[]> {
  // A direct PN receipt can predate discovery of its canonical LID chat. Read
  // both verified conversation aliases, without mutating any state on this route.
  const aliases = [params[1]];
  if (params[1].endsWith('@lid')) {
    const conversation = await getPool().query(
      'SELECT wa_chat_id FROM conversations WHERE id=$1 AND account=$2',
      [accountKey(params[1]), params[0]]
    );
    const storedPn = conversation.rows[0]?.wa_chat_id;
    const pn = typeof storedPn === 'string' ? stripAccountKey(storedPn) : null;
    if (typeof pn === 'string' && /^\d+@(c\.us|s\.whatsapp\.net)$/.test(pn))
      aliases.push(pn.replace(/@s\.whatsapp\.net$/, '@c.us'));
  }
  return aliases;
}

export async function receiptRecoveryTarget(chatId: string, messageId: string) {
  const params = await scope(chatId, messageId);
  return {
    account: params[0],
    chatId: params[1],
    messageId: params[2],
    aliases: await verifiedReceiptAliases(params),
  };
}

/** On-demand history is older than the cursor: use an observed successor, never the target or an invented time. */
export async function receiptRecoveryAnchor(target: {
  account: string;
  chatId: string;
  messageId: string;
  aliases: string[];
}) {
  if (target.account !== connectorAccount()) return null;
  const result = await getPool().query(
    `SELECT k.wa_message_id,k.remote_jid,k.from_me,k.participant_jid,k.message_timestamp_ms
    FROM messages m JOIN whatsapp_message_keys k ON k.wa_message_id=m.wa_message_id
    JOIN whatsapp_message_keys original ON original.wa_message_id=$3 AND original.conversation_id=m.conversation_id
    JOIN messages original_message ON original_message.wa_message_id=original.wa_message_id
    WHERE m.account=$1 AND m.platform='whatsapp' AND m.conversation_id=ANY($2::text[])
      AND original_message.account=$1 AND original_message.platform='whatsapp' AND original_message.direction='OUTBOUND'
      AND k.conversation_id=m.conversation_id AND k.message_timestamp_ms>original.message_timestamp_ms
      AND original.message_timestamp_ms>0 AND k.remote_jid IS NOT NULL
    ORDER BY k.message_timestamp_ms ASC,k.wa_message_id ASC LIMIT 1`,
    [target.account, target.aliases.map(accountKey), accountKey(target.messageId)]
  );
  const row = result.rows[0];
  if (
    !row ||
    typeof row.remote_jid !== 'string' ||
    !target.aliases.some(
      alias =>
        alias.replace(/@s\.whatsapp\.net$/, '@c.us') ===
        row.remote_jid.replace(/@s\.whatsapp\.net$/, '@c.us')
    )
  )
    return null;
  const timestampMs = Number(row.message_timestamp_ms);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  return {
    key: {
      id: stripAccountKey(row.wa_message_id),
      remoteJid: row.remote_jid,
      fromMe: !!row.from_me,
      participant: row.participant_jid || undefined,
    },
    timestampMs,
  };
}
export async function recordAggregateStatus(
  chatId: string,
  messageId: string,
  status: string
): Promise<void> {
  const params = await scope(chatId, messageId);
  const aliases = await verifiedReceiptAliases(params);
  if (aliases.length > 1) {
    const prior = await getPool().query(
      'SELECT aggregate_status FROM whatsapp_message_receipt_state WHERE account=$1 AND chat_id=ANY($2::text[]) AND message_id=$3',
      [params[0], aliases, params[2]]
    );
    status =
      prior.rows.reduce((current, row) => mergeStatus(current, row.aggregate_status), status) ||
      status;
  }
  const result = await getPool().query(
    `INSERT INTO whatsapp_message_receipt_state (account,chat_id,message_id,aggregate_status)
    VALUES ($1,$2,$3,$4) ON CONFLICT (account,chat_id,message_id) DO UPDATE
    SET aggregate_status=CASE WHEN whatsapp_message_receipt_state.aggregate_status IN ('deleted','failed') THEN whatsapp_message_receipt_state.aggregate_status
      WHEN EXCLUDED.aggregate_status='failed' AND whatsapp_message_receipt_state.aggregate_status IS DISTINCT FROM 'delivered' AND whatsapp_message_receipt_state.aggregate_status IS DISTINCT FROM 'read' THEN 'failed'
      WHEN (CASE EXCLUDED.aggregate_status WHEN 'pending' THEN 1 WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 ELSE 0 END) >
           (CASE whatsapp_message_receipt_state.aggregate_status WHEN 'pending' THEN 1 WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 ELSE 0 END)
      THEN EXCLUDED.aggregate_status ELSE whatsapp_message_receipt_state.aggregate_status END,
      observed_at=now() RETURNING aggregate_status`,
    [...params, status]
  );
  // Validate the chat too, before updating the account-namespaced message ID.
  const exists = await getPool().query(
    `SELECT 1 FROM messages WHERE wa_message_id=$1 AND account=$2 AND conversation_id=$3 AND platform='whatsapp' AND direction='OUTBOUND'`,
    [accountKey(messageId), params[0], accountKey(params[1])]
  );
  if (exists.rows.length && result.rows[0]?.aggregate_status)
    await setMessageStatus(messageId, result.rows[0].aggregate_status);
}
export class MessageInfoError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}
export async function getMessageReceiptInfo(chatId: string, messageId: string) {
  const params = await scope(chatId, messageId);
  const result = await getPool().query(
    `SELECT status,direction FROM messages WHERE account=$1 AND conversation_id=$2 AND wa_message_id=$3 AND platform='whatsapp'`,
    [params[0], accountKey(params[1]), accountKey(messageId)]
  );
  const message = result.rows[0];
  if (!message) throw new MessageInfoError('Message not found in this account and chat', 404);
  if (message.direction !== 'OUTBOUND')
    throw new MessageInfoError('Message info is available only for outbound messages', 400);
  const aliases = await verifiedReceiptAliases(params);
  const readScope = [params[0], aliases, params[2]];
  const state = await getPool().query(
    'SELECT * FROM whatsapp_message_receipt_state WHERE account=$1 AND chat_id=ANY($2::text[]) AND message_id=$3',
    readScope
  );
  const rows = await getPool().query(
    'SELECT * FROM whatsapp_message_receipts WHERE account=$1 AND chat_id=ANY($2::text[]) AND message_id=$3',
    readScope
  );
  const recipients: ReceiptIdentity[] | null =
    state.rows.find(r => r.recipients !== null)?.recipients ?? null;
  const receipts = mergeReceiptRows(rows.rows.map(fromRow), recipients || []);
  const all = mergeReceiptRows(
    [
      ...(recipients || []).map(r => ({ ...r, deliveredAt: null, readAt: null, playedAt: null })),
      ...receipts,
    ],
    recipients || []
  );
  const contacts = await getPool().query(
    `SELECT jid,COALESCE(NULLIF(name,''),NULLIF(push_name,'')) AS name FROM whatsapp_contacts WHERE account=$1 AND jid=ANY($2::text[])`,
    [
      params[0],
      [
        ...new Set(
          all.flatMap(r => r.aliases.flatMap(a => [a, a.replace(/@s\.whatsapp\.net$/, '@c.us')]))
        ),
      ],
    ]
  );
  const contactNames = new Map(
    contacts.rows.filter(c => c.name).map(c => [receiptJid(c.jid), c.name])
  );
  const times = [...rows.rows.map(r => r.observed_at), ...state.rows.map(r => r.observed_at)]
    .filter(Boolean)
    .map(v => new Date(v).toISOString())
    .sort();
  const aggregate = state.rows.reduce(
    (status, r) => mergeStatus(status, r.aggregate_status),
    message.status || 'sent'
  );
  return {
    account: params[0],
    chatId,
    messageId,
    fromMe: true,
    status: aggregate,
    recipientCount: recipients?.length ?? null,
    completeRecipients: recipients !== null,
    receipts: all.map(({ participantId, name, aliases, deliveredAt, readAt, playedAt }) => ({
      participantId,
      name: aliases.map(id => contactNames.get(id)).find(Boolean) || name || null,
      deliveredAt,
      readAt,
      playedAt,
    })),
    observedAt: times.at(-1) || null,
  };
}
