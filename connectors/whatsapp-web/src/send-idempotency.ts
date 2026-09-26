import { createHash } from 'node:crypto';
import { connectorAccount, getPool } from './db-writer';

let tableReady: Promise<void> | undefined;

function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = getPool()
      .query(
        `
      CREATE TABLE IF NOT EXISTS whatsapp_send_attempts (
        account TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'pending', 'sent')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        sent_at TIMESTAMPTZ,
        PRIMARY KEY (account, token_hash)
      )
    `
      )
      .then(() => undefined)
      .catch(error => {
        tableReady = undefined;
        throw error;
      });
  }
  return tableReady;
}

export interface SendReservation {
  state: 'claimed' | 'prepared' | 'pending' | 'sent' | 'conflict';
  messageId: string;
  sentAt?: string;
}

export async function reserveTextSend(input: {
  token: string;
  conversationId: string;
  content: string;
  replyToMessageId?: string;
}): Promise<SendReservation> {
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify(['text', input.conversationId, input.content, input.replyToMessageId || null])
    )
    .digest('hex');
  return reserveSend(input.token, requestHash);
}

export async function reserveMediaSend(input: {
  token: string;
  conversationId: string;
  fileUrl: string;
  fileName?: string;
  caption?: string;
  asSticker: boolean;
  asGif: boolean;
  replyToMessageId?: string;
  sourceDigest?: string;
  sourceMimeType?: string;
}): Promise<SendReservation> {
  if (input.sourceDigest && !/^[a-f0-9]{64}$/i.test(input.sourceDigest))
    throw new Error('Invalid sourceDigest');
  if (
    input.sourceMimeType !== undefined &&
    (typeof input.sourceMimeType !== 'string' || !input.sourceMimeType.trim())
  )
    throw new Error('Invalid sourceMimeType');
  if (input.sourceDigest && !input.sourceMimeType)
    throw new Error('sourceMimeType is required with sourceDigest');
  const dataHeader = input.fileUrl.match(/^data:([^,]*),/i)?.[1];
  const outputMimeType =
    dataHeader
      ?.replace(/;base64$/i, '')
      .trim()
      .toLowerCase() || null;
  const sourceMimeType = input.sourceMimeType?.trim().toLowerCase() || outputMimeType;
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify([
        'media',
        input.conversationId,
        input.fileName || null,
        input.caption || null,
        input.asSticker,
        input.asGif,
        input.replyToMessageId || null,
        outputMimeType,
        sourceMimeType,
      ])
    )
    .update('\0')
    .update(input.sourceDigest || input.fileUrl)
    .digest('hex');
  return reserveSend(input.token, requestHash);
}

export async function reserveVoiceSend(input: {
  token: string;
  conversationId: string;
  audioBase64: string;
  mimeType: string;
  sourceDigest?: string;
  sourceMimeType?: string;
}): Promise<SendReservation> {
  if (input.sourceDigest && !/^[a-f0-9]{64}$/i.test(input.sourceDigest))
    throw new Error('Invalid sourceDigest');
  if (
    input.sourceMimeType !== undefined &&
    (typeof input.sourceMimeType !== 'string' || !input.sourceMimeType.trim())
  )
    throw new Error('Invalid sourceMimeType');
  if (input.sourceDigest && !input.sourceMimeType)
    throw new Error('sourceMimeType is required with sourceDigest');
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify([
        'voice',
        input.conversationId,
        input.mimeType.toLowerCase(),
        input.sourceMimeType?.trim().toLowerCase() || input.mimeType.toLowerCase(),
      ])
    )
    .update('\0')
    .update(input.sourceDigest || input.audioBase64)
    .digest('hex');
  return reserveSend(input.token, requestHash);
}

async function reserveSend(sendToken: string, requestHash: string): Promise<SendReservation> {
  const token = sendToken.trim();
  if (!token || token.length > 200) throw new Error('Invalid sendToken');
  const account = connectorAccount();
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  const tokenHash = digest(token);
  // Baileys accepts a caller-supplied ID; this stable ID also identifies a timed-out attempt.
  const messageId = `3EB0${digest(JSON.stringify([account, token]))
    .slice(0, 18)
    .toUpperCase()}`;
  await ensureTable();
  const inserted = await getPool().query(
    `INSERT INTO whatsapp_send_attempts (account, token_hash, request_hash, message_id, status)
     VALUES ($1, $2, $3, $4, 'prepared') ON CONFLICT DO NOTHING RETURNING message_id`,
    [account, tokenHash, requestHash, messageId]
  );
  if (inserted.rowCount) return { state: 'claimed', messageId };
  const existing = await getPool().query(
    `SELECT request_hash, message_id, status, sent_at FROM whatsapp_send_attempts
     WHERE account = $1 AND token_hash = $2`,
    [account, tokenHash]
  );
  const row = existing.rows[0];
  if (!row) throw new Error('Send reservation disappeared');
  if (row.request_hash !== requestHash) return { state: 'conflict', messageId: row.message_id };
  return {
    state: row.status === 'sent' ? 'sent' : row.status === 'prepared' ? 'prepared' : 'pending',
    messageId: row.message_id,
    sentAt: row.sent_at?.toISOString(),
  };
}

export class SendAlreadyClaimedError extends Error {
  constructor() {
    super('Send attempt already claimed or completed');
  }
}

export async function claimSendAttempt(token: string, messageId: string): Promise<void> {
  const result = await getPool().query(
    `UPDATE whatsapp_send_attempts SET status = 'pending'
     WHERE account = $1 AND token_hash = $2 AND message_id = $3 AND status = 'prepared'
     RETURNING message_id`,
    [connectorAccount(), createHash('sha256').update(token.trim()).digest('hex'), messageId]
  );
  if (!result.rowCount) throw new SendAlreadyClaimedError();
}

export async function confirmTextSend(token: string, messageId: string): Promise<string> {
  const result = await getPool().query(
    `UPDATE whatsapp_send_attempts SET status = 'sent', sent_at = now()
     WHERE account = $1 AND token_hash = $2 AND message_id = $3 AND status = 'pending'
     RETURNING sent_at`,
    [connectorAccount(), createHash('sha256').update(token.trim()).digest('hex'), messageId]
  );
  if (!result.rowCount) throw new Error('Send reservation disappeared before confirmation');
  return result.rows[0].sent_at.toISOString();
}
