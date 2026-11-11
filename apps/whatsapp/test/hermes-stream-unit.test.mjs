import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CapabilityRedactor, HermesStreamAccumulator, SseDecoder} from '../lib/hermes-stream.mjs';

const header = name => name === 'x-hermes-session-id' ? 'current-session' : null;
const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({choices: [{delta, finish_reason}]})}\n\n`;

test('Hermes SSE preserves named events and UTF-8 at every transport boundary', () => {
  const text = ': keepalive\r\n\r\nevent: hermes.tool.progress\r\ndata: {"tool":"read_file","label":"S\u00ed"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  for (let size = 1; size <= bytes.length; size++) {
    const decoder = new SseDecoder();
    const frames = [];
    for (let pos = 0; pos < bytes.length; pos += size) frames.push(...decoder.push(bytes.slice(pos, pos + size)));
    frames.push(...decoder.end());
    assert.deepEqual(frames, [
      {event: 'hermes.tool.progress', data: '{"tool":"read_file","label":"S\u00ed"}'},
      {event: 'done', data: '[DONE]'},
    ], `chunk size ${size}`);
  }
});

test('Hermes SSE retains multiline data and does not duplicate an EOF tail', () => {
  const decoder = new SseDecoder();
  const frames = [
    ...decoder.push('event: detail\n'),
    ...decoder.push('data: first\ndata: second'),
    ...decoder.end(),
  ];
  assert.deepEqual(frames, [{event: 'detail', data: 'first\nsecond'}]);
  assert.deepEqual(decoder.end(), []);
});

test('Hermes SSE handles CR-only separators split across chunks', () => {
  const decoder = new SseDecoder();
  const frames = [...'data: first\rdata: second\r\r'].flatMap(char => decoder.push(char));
  frames.push(...decoder.end());
  assert.deepEqual(frames, [{event: 'message', data: 'first\nsecond'}]);
});

test('capability redaction survives every split and releases ordinary text immediately', () => {
  const capability = 'eyJ-capability.signature';
  const text = `Before ${capability} between ${capability} after`;
  for (let size = 1; size <= text.length; size++) {
    const redactor = new CapabilityRedactor(capability);
    let output = '';
    for (let pos = 0; pos < text.length; pos += size) output += redactor.push(text.slice(pos, pos + size));
    output += redactor.flush();
    assert.equal(output, 'Before [redacted capability] between [redacted capability] after');
  }
  const redactor = new CapabilityRedactor(capability);
  assert.equal(redactor.push('An immediate answer.'), 'An immediate answer.');
  assert.equal(redactor.flush(), '');
});

test('Hermes progress shows tool activity without arguments or internal reasoning', () => {
  const activities = [], deltas = [];
  const accumulator = new HermesStreamAccumulator({onActivity: value => activities.push(value), onDelta: text => deltas.push(text)});
  accumulator.push(chunk({reasoning_content: 'PRIVATE REASONING'}));
  const tool = {tool: 'read_file', label: 'PRIVATE FILE AND ARGUMENT', arguments: 'PRIVATE ARGUMENT', toolCallId: 'one', status: 'running'};
  accumulator.push(`event: hermes.tool.progress\ndata: ${JSON.stringify(tool)}\n\n`);
  accumulator.push(`event: hermes.tool.progress\ndata: ${JSON.stringify(tool)}\n\n`);
  accumulator.push(chunk({content: 'Visible reply'}, 'stop') + 'data: [DONE]\n\n');
  accumulator.end();
  assert.equal(activities.filter(item => item.phase === 'tool').length, 1);
  assert.equal(activities.find(item => item.phase === 'tool').label, 'Leyendo un archivo');
  assert(activities.some(item => item.phase === 'thinking'));
  assert.equal(deltas.join(''), 'Visible reply');
  assert.doesNotMatch(JSON.stringify({activities, deltas}), /PRIVATE/);
  assert.equal(accumulator.outcome(header).completed, true);
});

test('Hermes does not confirm partial, failed, handle-less or truncated output', () => {
  for (const [source, getHeader] of [
    [chunk({content: 'partial'}), header],
    [chunk({content: 'partial'}, 'length') + 'data: [DONE]\n\n', header],
    [chunk({content: 'answer'}, 'stop') + 'data: [DONE]\n\n', () => null],
    [chunk({content: 'answer'}, 'stop') + 'data: [DONE]\n\n', name => name === 'x-hermes-completed' ? 'false' : header(name)],
    [chunk({content: 'partial'}) + 'data: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n', header],
    [chunk({content: 'partial'}) + 'event: error\ndata: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n', header],
  ]) {
    const accumulator = new HermesStreamAccumulator();
    accumulator.push(source);
    accumulator.end();
    assert.equal(accumulator.outcome(getHeader).completed, false, source);
  }
});

test('redacted deltas and final answer remain consistent', () => {
  const deltas = [];
  const accumulator = new HermesStreamAccumulator({capability: 'private-capability', onDelta: text => deltas.push(text)});
  for (const content of ['Hello ', 'private-', 'capabi', 'lity', ', done.']) accumulator.push(chunk({content}));
  accumulator.push(chunk({}, 'stop') + 'data: [DONE]\n\n');
  accumulator.end();
  const outcome = accumulator.outcome(header);
  assert.equal(outcome.completed, true);
  assert.equal(outcome.answer, 'Hello [redacted capability], done.');
  assert.equal(outcome.answer, deltas.join(''));
});
