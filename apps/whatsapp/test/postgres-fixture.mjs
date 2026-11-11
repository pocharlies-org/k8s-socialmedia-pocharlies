import assert from 'node:assert/strict';
import pg from 'pg';

export function disposableDatabaseUrl(value) {
  assert.match(new URL(value).pathname, /^\/(whatsapp_qa[^/]*|socialmedia_shared_qa)$/);
}

export async function connectDisposableDatabase(value) {
  disposableDatabaseUrl(value);
  const db = new pg.Client({connectionString: value});
  await db.connect();
  return db;
}
