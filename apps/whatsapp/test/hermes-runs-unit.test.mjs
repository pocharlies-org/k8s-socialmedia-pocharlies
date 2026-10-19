import test from 'node:test';
import assert from 'node:assert/strict';
import {stopHermesRun, hermesImages, hermesRunFailure, safeHermesRunText} from '../lib/hermes-runs.mjs';

test('a stop acceptance without terminal status never claims cancellation', async () => {
  const calls = [];
  await assert.rejects(stopHermesRun({base: 'http://hermes/p/socialmedia', headers: {}, runId: 'run_stuck', timeoutMs: 10,
    remote: async (url, request) => {calls.push({url, method: request.method}); return Response.json({status: 'stopping'});}}), error => error.status === 502 && /no esta confirmada/.test(error.message));
  assert.equal(calls[0].method, 'POST');
  assert(calls.some(call => !call.url.endsWith('/stop')));
});

test('image validation rejects unsupported schemes, malformed base64 and excessive decoded bytes', () => {
  const image = url => ({name: 'photo.png', url});
  for (const url of ['file:///private', 'http://127.0.0.1/private', 'data:audio/mpeg;base64,YQ==', 'data:image/png;base64,YR==']) {
    assert.throws(() => hermesImages([image(url)]), error => error.status === 400);
  }
  const bytes = Buffer.alloc(5 * 1024 * 1024).toString('base64');
  assert.throws(() => hermesImages([image(`data:image/png;base64,${bytes}`), image(`data:image/png;base64,${bytes}`)]), error => error.status === 413);
});

test('only exact pre-execution provider errors without observed work authorize retry', () => {
  const error = "\u26a0\ufe0f Provider authentication failed: Unknown provider 'old-provider'. Check 'hermes model' for available providers, or run 'hermes doctor' to diagnose config issues.";
  assert.equal(hermesRunFailure({error}).retryable, true);
  for (const run of [{error: 'Unknown provider'}, {error: error + ' secret'}, {error, output: 'Action done'}, {error, tool_calls: [{}]}]) {
    assert.equal(hermesRunFailure(run).retryable, false);
  }
  assert.equal(hermesRunFailure({error}, {toolActivity: true}).retryable, false);
  assert.equal(hermesRunFailure({error}, {partialText: 'Started'}).retryable, false);
});

test('recovered run text redacts expired capabilities from earlier attempts', () => {
  const payload = Buffer.from(JSON.stringify({account: 'personal', chat: 'contact', turn: 'old', exp: 10})).toString('base64url');
  const token = `${payload}.${'a'.repeat(43)}`;
  assert.equal(safeHermesRunText(`Answer ${token}`), 'Answer [redacted capability]');
  assert.equal(safeHermesRunText('Ordinary answer'), 'Ordinary answer');
});
