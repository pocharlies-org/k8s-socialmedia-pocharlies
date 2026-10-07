import test from 'node:test';
import assert from 'node:assert/strict';
import {stopHermesRun, hermesImages} from '../lib/hermes-runs.mjs';

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
