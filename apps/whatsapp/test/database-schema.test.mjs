import assert from 'node:assert/strict';
import test from 'node:test';
import {getDatabaseSchema, useDatabaseSchema, validDatabaseId} from '../lib/database-schema.mjs';

const rows = type => [
  {table_name:'messages',column_name:'id',data_type:type},
  {table_name:'attachments',column_name:'id',data_type:'uuid'},
  {table_name:'attachments',column_name:'duration_seconds',data_type:'integer'},
];

test('schema discovery shares one visible-relation read and preserves mixed identity types', async () => {
  let calls = 0;
  const query = async sql => {calls++; assert.match(sql, /to_regclass\('messages'\)/); return rows('bigint');};
  const [first, second] = await Promise.all([getDatabaseSchema(query),getDatabaseSchema(query)]);
  assert.equal(calls,1);
  assert.equal(first,second);
  assert.deepEqual(first,{messageIdType:'bigint',attachmentIdType:'uuid',attachmentDurationColumns:['duration_seconds']});
});

test('failed or unsupported discovery is retryable and never invents a UUID schema', async () => {
  let calls = 0;
  const query = async () => ++calls === 1 ? [] : rows('uuid');
  await assert.rejects(getDatabaseSchema(query),error => error.status===503);
  assert.equal((await getDatabaseSchema(query)).messageIdType,'uuid');
  assert.equal(calls,2);
  assert.throws(()=>useDatabaseSchema(query,{messageIdType:'text;DROP TABLE messages',attachmentIdType:'uuid',attachmentDurationColumns:[]}),/Unsupported/);
});

test('native ID validation preserves bigint precision and rejects overflow or injected values', () => {
  for(const id of ['9007199254740993','9223372036854775807','-9223372036854775808','0']) assert(validDatabaseId(id,'bigint'));
  for(const id of ['9223372036854775808','-9223372036854775809','01','1.0','1e2','1 OR true','']) assert(!validDatabaseId(id,'bigint'));
  assert(validDatabaseId('00000000-0000-4000-8000-000000000001','uuid'));
  assert(!validDatabaseId('1','uuid'));
});
