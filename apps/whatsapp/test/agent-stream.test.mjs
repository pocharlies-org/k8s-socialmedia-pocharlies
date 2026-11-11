import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readAgentStream} from '../public/agent-stream.mjs';

function response(text, split = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({start(controller) {
    for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
    controller.close();
  }}));
}

test('agent stream handles split UTF-8, CRLF, heartbeat and live events', async () => {
  const events = [];
  const result = await readAgentStream(response(': heartbeat\r\n\r\nevent: activity\r\ndata: {"phase":"tool","label":"Consultar chat"}\r\n\r\nevent: delta\ndata: {"text":"Sí"}\n\nevent: result\ndata: {"text":"Sí","sessionId":"same-chat"}\n\n'), (...event) => events.push(event));
  assert.deepEqual(result, {text: 'Sí', sessionId: 'same-chat'});
  assert.deepEqual(events.map(([name]) => name), ['activity', 'delta', 'result']);
  assert.equal(events[1][1].text, 'Sí');
});

test('agent stream does not treat partial output as a successful turn', async () => {
  await assert.rejects(readAgentStream(response('event: delta\ndata: {"text":"partial"}\n\n')), /interrumpió/);
  await assert.rejects(readAgentStream(response('event: error\ndata: {"error":"Hermes no disponible"}\n\n')), /Hermes no disponible/);
});

test('agent stream releases an open connection as soon as the result arrives', async () => {
  let cancelled = false;
  const stream = new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode('event: result\ndata: {"text":"complete"}\n\n'));
  }, cancel() { cancelled = true; }});
  assert.equal((await readAgentStream(new Response(stream))).text, 'complete');
  assert.equal(cancelled, true);
});

test('result is terminal even when more events share its transport chunk', async () => {
  const events = [];
  const result = await readAgentStream(response('event: result\ndata: {"text":"complete"}\n\nevent: error\ndata: {"error":"late error"}\n\n', 1000), event => events.push(event));
  assert.equal(result.text, 'complete');
  assert.deepEqual(events, ['result']);
});
