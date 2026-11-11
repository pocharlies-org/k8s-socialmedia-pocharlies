import assert from 'node:assert/strict';

/** Every bound PostgreSQL argument must be referenced so its type can be inferred. */
export function assertDenseParameters(sql: string, params: unknown[]) {
  const used = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
  assert.equal(
    Math.max(...used),
    params.length,
    'highest parameter must be the last bound argument'
  );
  for (let index = 1; index <= params.length; index++)
    assert.ok(used.includes(index), `parameter $${index} is bound but never referenced`);
}
