import {fail} from './security.mjs';

const schemas = new WeakMap();
const ID_TYPES = new Set(['uuid', 'bigint']);

export function useDatabaseSchema(query, schema) {
  if (!ID_TYPES.has(schema.messageIdType) || !ID_TYPES.has(schema.attachmentIdType)
      || !Array.isArray(schema.attachmentDurationColumns)
      || schema.attachmentDurationColumns.some(column => !['duration_seconds', 'duration'].includes(column)))
    throw fail(503, 'Unsupported message storage schema');
  schemas.set(query, Promise.resolve(Object.freeze({...schema})));
}

/** Inspect the visible relations once per app/database connection scope. */
export async function getDatabaseSchema(query) {
  if (schemas.has(query)) return schemas.get(query);
  const pending = (async () => {
    const rows = await query(`SELECT c.relname AS table_name, a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS data_type
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE a.attrelid IN (to_regclass('messages'), to_regclass('attachments'))
        AND a.attnum>0 AND NOT a.attisdropped
        AND a.attname IN ('id','duration_seconds','duration')`);
    const type = table => rows.find(row => row.table_name === table && row.column_name === 'id')?.data_type;
    const messageIdType = type('messages'), attachmentIdType = type('attachments');
    if (!ID_TYPES.has(messageIdType) || !ID_TYPES.has(attachmentIdType))
      throw fail(503, 'Unsupported or unavailable message storage schema');
    return Object.freeze({messageIdType, attachmentIdType,
      attachmentDurationColumns: Object.freeze(['duration_seconds','duration'].filter(column =>
        rows.some(row => row.table_name === 'attachments' && row.column_name === column)))});
  })();
  schemas.set(query, pending);
  try { return await pending; }
  catch (error) { schemas.delete(query); throw error; }
}

export function validDatabaseId(value, type) {
  const text = String(value ?? '');
  if (type === 'uuid') return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text);
  if (type !== 'bigint' || !/^(?:0|-?[1-9]\d{0,18})$/.test(text)) return false;
  const id = BigInt(text);
  return id >= -9223372036854775808n && id <= 9223372036854775807n;
}
