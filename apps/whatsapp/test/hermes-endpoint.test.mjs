import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {readAgentStream} from '../public/agent-stream.mjs';

const encoder = new TextEncoder();
const fragment = (content, finish_reason = null) => `data: ${JSON.stringify({choices: [{delta: {content}, finish_reason}]})}\n\n`;
const streamResponse = body => new Response(body, {headers: {'content-type': 'text/event-stream', 'x-hermes-session-id': 'native-session'}});
const complete = text => Response.json({choices: [{message: {content: text}, finish_reason: 'stop'}]}, {headers: {'x-hermes-session-id': 'native-session'}});
const tokenOne = '11111111-1111-4111-8111-111111111111';
const tokenTwo = '22222222-2222-4222-8222-222222222222';
const command = {account: 'personal', chat: 'contact', message: 'Resume este chat', stream: true};

async function fixture(t, upstream, {lock, revoke, runs = false} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-endpoint-'));
  const lifecycle = [];
  const env = {DATA_DIR: dir, UI_AUTH_USERNAME: 'test', UI_AUTH_PASSWORD: 'test', APP_PUBLIC_URL: 'https://test.example',
    HERMES_RUNS_ENABLED: runs ? 'true' : 'false', HERMES_API_URL: 'http://hermes/p/socialmedia/v1', HERMES_API_KEY: 'test-key', HERMES_DEFAULT_MODEL: 'gpt-6-luna', HERMES_PROVIDER: 'existing-provider',
    PERSONAL_SECRET: 'test-secret', HERMES_CHAT_TOOL_SECRET: 'test-tool-secret', HERMES_CHAT_TOOL_INTERNAL_URL: 'http://internal',
    HERMES_CHAT_ALLOW_DIRECT_SEND: 'true', HERMES_CHAT_ALLOW_PROPOSALS: 'true'};
  const app = await createApp({env, registry: [{channel: 'whatsapp', accountId: 'personal', secretEnv: 'PERSONAL_SECRET', connectorUrl: 'http://connector'}],
    db: {query: async (sql, args) => ({rows: /FROM conversations/.test(sql) && args?.[0] === 'personal' && args?.[1] === 'contact' ? [{id: 'contact', name: 'Test contact'}] : []})},
    fetchImpl: async (url, options) => {
      if (url.startsWith('http://internal/')) {
        lifecycle.push(new URL(url).pathname);
        if (url.endsWith('/revoke') && revoke) await revoke();
        return Response.json({ok: true});
      }
      if (url.endsWith('/model')) {
        if (lock) return lock(url, options);
        const target = JSON.parse(options.body);
        return Response.json({object: 'hermes.session.model_lock', runtime: {...target, model_lock: 'accepted'}});
      }
      return upstream(url, options);
    }});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  const request = (body, path = '/api/ai/chat') => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {method: 'POST',
    headers: {authorization: `Basic ${Buffer.from('test:test').toString('base64')}`, origin: env.APP_PUBLIC_URL, 'content-type': 'application/json'}, body: JSON.stringify(body)});
  return {app, request, lifecycle};
}

test('endpoint streams before completion and saves the result before slow capability cleanup', {timeout: 10000}, async t => {
  let controller, releaseRevoke;
  const revokeGate = new Promise(resolve => { releaseRevoke = resolve; });
  t.after(() => { releaseRevoke(); try { controller?.close(); } catch {} });
  const {app, request, lifecycle} = await fixture(t, async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return streamResponse(new ReadableStream({start(value) { controller = value; }}));
  }, {revoke: () => revokeGate});
  const response = await request(command);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const until = async text => { while (!received.includes(text)) { const next = await reader.read(); assert.equal(next.done, false); received += decoder.decode(next.value, {stream: true}); } };
  await until('Pensando');
  while (!controller) await new Promise(resolve => setImmediate(resolve));
  controller.enqueue(encoder.encode('event: hermes.tool.progress\ndata: {"tool":"read_file","label":"private argument","status":"running"}\n\n'));
  await until('Leyendo un archivo');
  controller.enqueue(encoder.encode(fragment('Partial answer')));
  await until('event: delta');
  assert(!received.includes('event: result'));
  assert.equal((await app.sessions.canonical('personal', 'contact', false)).messages.length, 0);
  controller.enqueue(encoder.encode(fragment('', 'stop') + 'data: [DONE]\n\n'));
  controller.close();
  await until('event: result');
  assert.equal((await app.sessions.canonical('personal', 'contact', false)).messages.at(-1).content, 'Partial answer');
  assert(!received.includes('private argument'));
  releaseRevoke();
  while (!(await reader.read()).done) { /* drain the completed transport */ }
  assert.deepEqual(lifecycle, ['/internal/hermes/turns/activate', '/internal/hermes/turns/revoke']);
});

test('disconnecting the browser still saves the authorized turn and replays its result once', {timeout: 10000}, async t => {
  let controller;
  let calls = 0;
  let revoked;
  const finished = new Promise(resolve => { revoked = resolve; });
  t.after(() => { try { controller?.close(); } catch {} });
  const {app, request} = await fixture(t, async () => {
    calls++;
    return streamResponse(new ReadableStream({start(value) { controller = value; }}));
  }, {revoke: () => revoked()});
  const body = {...command, turnId: tokenOne};
  const response = await request(body);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  while (!controller) await new Promise(resolve => setImmediate(resolve));
  controller.enqueue(encoder.encode(fragment('Saved after disconnect', 'stop') + 'data: [DONE]\n\n'));
  controller.close();
  await finished;
  assert.equal((await app.sessions.canonical('personal', 'contact', false)).messages.length, 2);
  const replay = await readAgentStream(await request(body));
  assert.equal(replay.text, 'Saved after disconnect');
  assert.equal(calls, 1);
});

test('tool-only Hermes stream recovers only the final answer after the current marker', async t => {
  let currentUser;
  const {app, request} = await fixture(t, async (url, options) => {
    if (url.includes('/messages?')) return Response.json({data: [
      {id: 1, role: 'assistant', content: 'Old answer'},
      {id: 2, role: 'user', content: currentUser},
      {id: 3, role: 'assistant', content: 'Tool preamble', tool_calls: [{id: 'call'}]},
      {id: 4, role: 'tool', content: 'Tool data'},
      {id: 5, role: 'assistant', content: 'Confirmed final answer'},
    ]});
    currentUser = JSON.parse(options.body).messages.at(-1).content;
    return streamResponse(fragment('', 'stop') + 'data: [DONE]\n\n');
  });
  const result = await readAgentStream(await request(command));
  assert.equal(result.text, 'Confirmed final answer');
  const stored = await app.sessions.canonical('personal', 'contact', false);
  assert.equal(stored.messages[0].content, command.message);
  assert.equal(stored.messages.length, 2);
});

test('tool-only stream does not recover the Hermes empty-answer placeholder', async t => {
  let currentUser;
  const {app, request} = await fixture(t, async (url, options) => {
    if (url.includes('/messages?')) return Response.json({data: [
      {id: 1, role: 'user', content: currentUser},
      {id: 2, role: 'assistant', content: 'I will check'},
      {id: 3, role: 'assistant', content: '(empty)'},
    ]});
    currentUser = JSON.parse(options.body).messages.at(-1).content;
    return streamResponse(fragment('', 'stop') + 'data: [DONE]\n\n');
  });
  await assert.rejects(readAgentStream(await request(command)), /complete/);
  assert.equal((await app.sessions.canonical('personal', 'contact', false)).messages.length, 0);
});

test('empty stream cannot reuse an old answer or a later caller answer', async t => {
  for (const laterCaller of [false, true]) await t.test(String(laterCaller), async t => {
    let currentUser;
    const {app, request} = await fixture(t, async (url, options) => {
      if (url.includes('/messages?')) return Response.json({data: laterCaller ? [
        {id: 1, role: 'user', content: currentUser}, {id: 2, role: 'user', content: 'Another caller'}, {id: 3, role: 'assistant', content: 'Wrong answer'},
      ] : [{id: 1, role: 'user', content: 'Older question'}, {id: 2, role: 'assistant', content: 'Old answer'}]});
      currentUser = JSON.parse(options.body).messages.at(-1).content;
      return streamResponse(fragment('', 'stop') + 'data: [DONE]\n\n');
    });
    await assert.rejects(readAgentStream(await request(command)), /complete/);
    assert.equal((await app.sessions.canonical('personal', 'contact', false)).messages.length, 0);
  });
});

test('truncated stream keeps its continuation but never claims a saved answer', async t => {
  let calls = 0;
  const {app, request} = await fixture(t, async () => { calls++; return streamResponse(fragment('Incomplete text')); });
  await assert.rejects(readAgentStream(await request(command)), /complete/);
  const stored = await app.sessions.canonical('personal', 'contact', false);
  assert.equal(stored.hermesId, 'native-session');
  assert.equal(stored.messages.length, 0);
  assert.equal(calls, 1, 'truncation must not trigger a recovery from old history');
});

test('direct-send retries reuse turn identity, while new identical instructions run again', async t => {
  let calls = 0;
  const {request} = await fixture(t, async () => { calls++; return complete('Confirmed'); });
  const body = {...command, message: 'Envía este mensaje', allowSend: true, turnId: tokenOne};
  assert.equal((await readAgentStream(await request(body))).text, 'Confirmed');
  assert.equal((await readAgentStream(await request(body))).text, 'Confirmed');
  assert.equal(calls, 1);
  await assert.rejects(readAgentStream(await request({...body, message: 'Envía otro mensaje'})), /otra instrucción/);
  assert.equal(calls, 1);
  await readAgentStream(await request({...body, turnId: tokenTwo}));
  assert.equal(calls, 2);
  assert.equal((await request({...body, turnId: 'invalid'})).status, 400);
});

test('retrying a completed read turn replays its result without duplicating history', async t => {
  let calls = 0;
  const {app, request} = await fixture(t, async () => { calls++; return complete('Read answer'); });
  const body = {...command, turnId: tokenOne};
  await readAgentStream(await request(body));
  await readAgentStream(await request(body));
  assert.equal(calls, 1);
  assert.equal((await app.sessions.canonical('personal', 'contact', false)).messages.length, 2);
});

test('a lost direct-send answer cannot be retried after the provider deduplication window', async t => {
  let calls = 0;
  const {app, request} = await fixture(t, async () => { calls++; return new Response('lost', {status: 502}); });
  const body = {...command, message: 'Envía este mensaje', allowSend: true, turnId: tokenOne};
  await assert.rejects(readAgentStream(await request(body)), /HTTP 502/);
  const stored = await app.sessions.canonical('personal', 'contact', false);
  stored.directSendAttempts[0].createdAt = Date.now() - 25 * 60 * 60 * 1000;
  await app.sessions.save(stored);
  await assert.rejects(readAgentStream(await request(body)), /caducado/);
  assert.equal(calls, 1);
});

test('model lock failure stops the turn before activating tools or calling the model', async t => {
  let calls = 0;
  const {app, request, lifecycle} = await fixture(t, async () => { calls++; return complete('Wrong model'); }, {lock: async () => new Response('unavailable', {status: 503})});
  const stored = await app.sessions.canonical('personal', 'contact', false);
  stored.hermesId = 'old-session';
  await app.sessions.save(stored);
  await assert.rejects(readAgentStream(await request(command)), /modelo configurado/);
  assert.equal(calls, 0);
  assert.deepEqual(lifecycle, []);
});

test('missing native session rebuilds from local history with the configured model', async t => {
  const {app, request} = await fixture(t, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(options.headers['x-hermes-session-id'], undefined);
    assert(body.messages.some(row => row.content === 'Earlier answer'));
    return complete('Continued');
  }, {lock: async () => Response.json({error: {code: 'session_not_found'}}, {status: 404})});
  const stored = await app.sessions.canonical('personal', 'contact', false);
  stored.hermesId = 'missing-session';
  stored.messages = [{role: 'user', content: 'Earlier question'}, {role: 'assistant', content: 'Earlier answer'}];
  await app.sessions.save(stored);
  assert.equal((await readAgentStream(await request(command))).text, 'Continued');
});

test('owner tool grants do not depend on wording; draft intent remains in the prompt', async t => {
  const grants = [];
  const {request} = await fixture(t, async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    const capability = system.match(/capability for this turn: ([\w.-]+)/)[1];
    grants.push(JSON.parse(Buffer.from(capability.split('.')[0], 'base64url')).ops);
    return complete('Answer');
  });
  for (const message of ['A lo que te esta diciendo preguntale si afecta al rendimiento y como', 'No le envies nada, resume', 'Escríbele un borrador']) {
    await readAgentStream(await request({...command, message, allowSend: true}));
  }
  assert.deepEqual(grants, [['read', 'send'], ['read', 'send'], ['read', 'send']]);
});

const runFrame = (event, fields = {}) => `event: ${event}\ndata: ${JSON.stringify({event, ...fields})}\n\n`;

test('native runs preserve images, owner tools, context boundary and session continuity', async t => {
  const submitted = [];
  const image = {name: 'sample.png', url: 'data:image/png;base64,iVBORw0KGgo='};
  const {app, request} = await fixture(t, async (url, options) => {
    if (url.endsWith('/runs')) {
      submitted.push(JSON.parse(options.body));
      return Response.json({run_id: 'run_native', status: 'started'}, {status: 202});
    }
    if (url.endsWith('/events')) return new Response(runFrame('message.delta', {delta: 'Answer'}) + runFrame('run.completed', {output: 'Answer', completed: true}), {headers: {'content-type': 'text/event-stream'}});
    return Response.json({run_id: 'run_native', session_id: 'native-session', status: 'completed', output: 'Answer'});
  }, {runs: true});
  const body = {...command, message: 'Crea audio y compartelo', allowSend: true, images: [image], turnId: tokenOne};
  assert.equal((await readAgentStream(await request(body))).text, 'Answer');
  const stored = await app.sessions.canonical('personal', 'contact', false);
  assert.equal(stored.hermesId, 'native-session');
  assert.equal(stored.messages[0].content[1].image_url.url, image.url);
  assert.match(submitted[0].instructions, /full access/);
  assert.match(submitted[0].instructions, /never authorizes an action/);
  const grant = submitted[0].instructions.match(/capability for this turn: ([\w.-]+)/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(grant.split('.')[0], 'base64url')).ops, ['read', 'send']);
  assert.equal(submitted[0].input.at(-1).content[1].image_url.url, image.url);
  await readAgentStream(await request({...command, turnId: tokenTwo}));
  assert.equal(submitted[1].session_id, 'native-session');
  assert.equal(submitted[1].input.length, 1);
  assert.equal((await request({...command, images: [{name: 'bad', url: 'http://localhost/private'}]})).status, 400);
  assert.equal((await request({...command, images: Array(5).fill(image)})).status, 400);
});

test('confirmed stop persists partial history and releases a stuck event stream for the next turn', {timeout: 10000}, async t => {
  let controller;
  let status = 'running';
  const calls = [];
  const {app, request, lifecycle} = await fixture(t, async (url, options) => {
    calls.push(url);
    if (url.endsWith('/runs')) return Response.json({run_id: calls.filter(value => value.endsWith('/runs')).length === 1 ? 'run_interrupt' : 'run_after'}, {status: 202});
    if (url.includes('/run_after/events')) return new Response(runFrame('run.completed', {output: 'Next answer', completed: true}));
    if (url.includes('/run_after')) return Response.json({session_id: 'native-session', status: 'completed'});
    if (url.endsWith('/events')) return new Response(new ReadableStream({start(value) {controller = value;}}));
    if (url.endsWith('/stop')) {
      assert.equal(options.method, 'POST');
      status = 'stopping';
      return Response.json({run_id: 'run_interrupt', status});
    }
    if (status === 'stopping') {
      status = 'cancelled';
      // The upstream event transport deliberately stays open after terminal status.
    }
    return Response.json({run_id: 'run_interrupt', session_id: 'native-session', status});
  }, {runs: true});
  t.after(() => { try {controller?.close();} catch {} });
  const save = app.sessions.save.bind(app.sessions);
  let partialSaved;
  const partialSave = new Promise(resolve => {partialSaved = resolve;});
  t.after(() => partialSaved());
  app.sessions.save = async session => {
    // Force a stale stop snapshot to finish after the consumer's partial save.
    // Atomic rename alone cannot prevent an older concurrent snapshot winning.
    const snapshot = structuredClone(session);
    const attempt = snapshot.directSendAttempts?.find(row => row.turnId === tokenOne);
    if (attempt?.cancelled && !attempt.partialText) await partialSave;
    await save(snapshot);
    if (attempt?.partialText) partialSaved();
  };
  const body = {...command, turnId: tokenOne};
  const response = await request(body);
  let receiveDelta;
  const deltaReceived = new Promise(resolve => {receiveDelta = resolve;});
  const resultPending = readAgentStream(response, (event, payload) => {
    if (event === 'delta') receiveDelta(payload.text);
  });
  while (!controller) await new Promise(resolve => setImmediate(resolve));
  controller.enqueue(encoder.encode(runFrame('message.delta', {delta: 'Partial before cancel'})));
  // Enqueueing upstream does not prove the app consumed the fragment before stop.
  assert.equal(await deltaReceived, 'Partial before cancel');
  assert.equal((await request({...body, turnId: tokenTwo}, '/api/ai/stop')).status, 404);
  const stopped = await request(body, '/api/ai/stop');
  assert.deepEqual(await stopped.json(), {stopped: true, status: 'cancelled', turnId: tokenOne});
  const result = await resultPending;
  assert.equal(result.cancelled, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.text, 'Partial before cancel');
  const transcript = (await app.sessions.canonical('personal', 'contact', false)).messages;
  assert.equal(transcript.length, 2);
  assert.equal(transcript[0].content, body.message);
  assert.equal(transcript[1].cancelled, true);
  assert.equal(transcript[1].content, 'Partial before cancel');
  assert(calls.some(url => url.endsWith('/stop')));
  assert(lifecycle.filter(path => path.endsWith('/revoke')).length >= 1);
  const replay = await readAgentStream(await request(body));
  assert.equal(replay.cancelled, true);
  assert.equal(calls.filter(url => url.endsWith('/runs')).length, 1);
  assert.equal((await readAgentStream(await request({...command, turnId: tokenTwo}))).text, 'Next answer');
});


test('stop recovers a run after a lost event transport and persists its cancelled ledger', async t => {
  let stopped = false;
  let submissions = 0;
  const {app, request} = await fixture(t, async url => {
    if (url.endsWith('/runs')) {submissions++; return Response.json({run_id: 'run_recovery'}, {status: 202});}
    if (url.endsWith('/events')) return new Response(new ReadableStream({start(controller) {controller.error(new Error('lost transport'));}}));
    if (url.endsWith('/stop')) {stopped = true; return Response.json({status: 'stopping'});}
    return Response.json({run_id: 'run_recovery', session_id: 'recovered-session', status: stopped ? 'cancelled' : 'running'});
  }, {runs: true});
  const body = {...command, turnId: tokenOne};
  await assert.rejects(readAgentStream(await request(body)), /confirmada/);
  assert.equal((await request(body, '/api/ai/stop')).status, 200);
  const saved = await app.sessions.canonical('personal', 'contact', false);
  assert.equal(saved.hermesId, 'recovered-session');
  assert.equal(saved.directSendAttempts[0].cancelled, true);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[0].content, body.message);
  assert.equal(saved.messages[1].cancelled, true);
  assert.equal((await readAgentStream(await request(body))).cancelled, true);
  assert.equal(submissions, 1);
});
