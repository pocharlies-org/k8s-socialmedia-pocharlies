import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {localDayRange, validateDayRange} from '../public/message-date.mjs';

test('local day boundaries respect browser timezone and daylight saving', () => {
  const moduleUrl = new URL('../public/message-date.mjs', import.meta.url).href;
  for (const [date, start, end] of [
    ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
    ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
    ['2026-09-28', '2026-09-27T22:00:00.000Z', '2026-09-28T22:00:00.000Z'],
  ]) {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {localDayRange} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(localDayRange(${JSON.stringify(date)})))`], {env: {...process.env, TZ: 'Europe/Madrid'}, encoding: 'utf8'}));
    assert.deepEqual(result, {start, end});
    assert.deepEqual(validateDayRange(start, end), result);
  }
});

test('invalid calendar dates and unbounded or ambiguous API ranges are rejected', () => {
  for (const date of ['', '2026-02-30', '2026-13-01', '2026-09-28T00:00Z', null]) assert.throws(() => localDayRange(date));
  const start = '2026-09-28T00:00:00.000Z';
  for (const end of [start, '2026-09-27T00:00:00.000Z', '2026-09-30T00:00:00.000Z', '2026-09-29T00:00:00', '2026-02-30T00:00:00.000Z']) assert.throws(() => validateDayRange(start, end));
});
