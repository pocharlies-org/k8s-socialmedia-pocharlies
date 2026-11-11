import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {eventDraft} from '../public/event-draft.mjs';

test('event draft keeps description and location separate and normalizes explicit offsets', () => {
  assert.deepEqual(eventDraft({title: ' Picnic ', description: ' Comida ', location: ' Parc ',
    dateTime: '2026-09-30T18:00+02:00', endDateTime: '2026-09-30T20:00+02:00'}), {
    title: 'Picnic', description: 'Comida', location: 'Parc', dateTime: '2026-09-30T16:00:00.000Z', endDateTime: '2026-09-30T18:00:00.000Z',
  });
});

test('event draft rejects missing timezone, impossible dates and reversed end time', () => {
  const draft = {title: 'Picnic', dateTime: '2026-09-30T16:00:00Z'};
  for (const patch of [{dateTime: '2026-09-30T18:00'}, {dateTime: '2026-02-30T18:00Z'},
    {dateTime: '2026-09-30T24:00Z'}, {title: ' '}, {description: 'x'.repeat(2049)},
    {location: 'x'.repeat(2001)}, {endDateTime: '2026-09-30T15:59Z'}]) {
    assert.throws(() => eventDraft({...draft, ...patch}));
  }
});

test('local event times use the browser timezone and reject the daylight-saving gap', () => {
  const module = new URL('../public/event-draft.mjs', import.meta.url).href;
  const script = `import {localEventTime} from ${JSON.stringify(module)};
    const result=[localEventTime('2026-09-30T18:00'),localEventTime('2026-12-30T18:00')];
    try {localEventTime('2026-03-29T02:30');result.push('accepted');}catch{result.push('rejected');}
    console.log(JSON.stringify(result));`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, TZ: 'Europe/Madrid'}, encoding: 'utf8'});
  assert.deepEqual(JSON.parse(result), ['2026-09-30T16:00:00.000Z', '2026-12-30T17:00:00.000Z', 'rejected']);
});
