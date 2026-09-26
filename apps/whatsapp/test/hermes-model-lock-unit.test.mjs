import assert from 'node:assert/strict';
import {test} from 'node:test';
import {modelLockAction, syncHermesModelLock} from '../lib/hermes-model-lock.mjs';

const target = {model: 'gpt-6-luna', provider: 'existing-provider'};
const confirmed = {hermesId: 'existing-session', hermesModelLock: {...target, state: 'confirmed'}};
const accepted = (model = target.model, provider = target.provider) => Response.json({
  object: 'hermes.session.model_lock', runtime: {model, provider, model_lock: 'accepted'},
});
const options = session => ({apiUrl: 'http://hermes/p/socialmedia/v1', apiKey: 'test-key', session, ...target});

test('legacy sessions must verify the deployment model without an opt-in switch', () => {
  assert.equal(modelLockAction({hermesId: 'old-qwen-session'}, target), 'lock');
  assert.equal(modelLockAction({}, target), 'none');
  for (const state of ['assumed', 'unavailable', 'missing', 'failed']) {
    assert.equal(modelLockAction({hermesId: 'old-session', hermesModelLock: {...target, state}}, target), 'lock', state);
  }
});

test('only a confirmed matching pair can skip the model lock', () => {
  assert.equal(modelLockAction(confirmed, target), 'none');
  assert.equal(modelLockAction(confirmed, {...target, model: 'different-model'}), 'lock');
  assert.equal(modelLockAction(confirmed, {...target, provider: 'different-provider'}), 'lock');
  assert.equal(modelLockAction(confirmed, target, {force: true}), 'lock');
});

test('model sync uses the existing profile and confirms the returned runtime', async () => {
  const session = {hermesId: 'existing/session', messages: [{role: 'user', content: 'History to preserve'}]};
  let calls = 0;
  const result = await syncHermesModelLock({...options(session), remote: async (url, request) => {
    calls++;
    assert.equal(url, 'http://hermes/p/socialmedia/api/sessions/existing%2Fsession/model');
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), target);
    return accepted();
  }});
  assert.equal(calls, 1);
  assert.equal(result, 'confirmed');
  assert.equal(session.hermesModelLock.state, 'confirmed');
  assert.equal(session.hermesModelLock.model, target.model);
  assert.deepEqual(session.messages, [{role: 'user', content: 'History to preserve'}]);
});

test('rejected, mismatched and unreachable model locks do not claim the new model', async () => {
  for (const remote of [
    async () => { throw Error('gateway unavailable'); },
    async () => accepted('old-model'),
    async () => accepted(target.model, 'wrong-provider'),
    async () => Response.json({error: {code: 'invalid_provider'}}, {status: 400}),
    async () => Response.json({object: 'unrelated-response'}),
  ]) {
    const previous = {model: 'old-model', provider: 'old-provider', state: 'confirmed'};
    const session = {hermesId: 'old-session', hermesModelLock: {...previous}};
    assert.equal(await syncHermesModelLock({...options(session), remote}), 'failed');
    assert.deepEqual(session.hermesModelLock, previous);
    assert.equal(modelLockAction(session, target), 'lock');
  }
});

test('unsupported routes and missing sessions remain unconfirmed and retryable', async () => {
  for (const [response, state] of [
    [new Response('Unknown route', {status: 404}), 'unavailable'],
    [Response.json({error: {code: 'session_not_found'}}, {status: 404}), 'missing'],
  ]) {
    const session = {hermesId: 'old-session', messages: [{role: 'assistant', content: 'Kept history'}]};
    assert.equal(await syncHermesModelLock({...options(session), remote: async () => response}), state);
    assert.notEqual(session.hermesModelLock?.state, 'confirmed');
    assert.equal(modelLockAction(session, target), 'lock');
    assert.equal(session.messages[0].content, 'Kept history');
  }
});
