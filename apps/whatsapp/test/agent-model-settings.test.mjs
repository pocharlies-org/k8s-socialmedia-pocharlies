import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {modelCatalog, hermesModelOptions} from '../lib/agent-model-settings.mjs';

const inventory = {providers: [
  {slug: 'litellm', authenticated: true, aliases: ['custom:litellm'], models: ['gpt-6-luna', 'qwen3.8-flash-next', 'plain'], capabilities: {'gpt-6-luna': {reasoning: true}, 'qwen3.8-flash-next': {reasoning: true}}},
  {slug: 'foreign', authenticated: true, models: ['foreign-secret-route']},
  {slug: 'unconfigured', authenticated: false, models: ['not-authenticated']},
]};

test('model inventory exposes only the configured authenticated route and supported effort controls', () => {
  const models = modelCatalog(inventory, 'custom:litellm');
  assert.deepEqual(models.map(row => row.id), ['gpt-6-luna', 'qwen3.8-flash-next', 'plain']);
  assert.deepEqual(models[2].reasoningEfforts.map(row => row.value), ['default']);
  assert(!models[0].reasoningEfforts.some(row => row.value === 'ultra'));
  assert.throws(() => modelCatalog(inventory, 'unconfigured'), /confirmed/);
  assert.throws(() => modelCatalog(inventory, ''), /configured provider/);
  assert.deepEqual(hermesModelOptions('none'), {reasoning: {enabled: false}});
  assert.deepEqual(hermesModelOptions('default'), {});
});

async function fixture(t, upstream = async () => Response.json({choices: [{message: {content: 'Done'}}]}, {headers: {'x-hermes-session-id': 'native'}}), {runs = false} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-model-settings-'));
  const calls = [];
  const env = {DATA_DIR: dir, UI_AUTH_USERNAME: 'test', UI_AUTH_PASSWORD: 'test', APP_PUBLIC_URL: 'https://test.example',
    HERMES_RUNS_ENABLED: String(runs), HERMES_API_URL: 'http://hermes/p/socialmedia/v1', HERMES_API_KEY: 'test-key', HERMES_DEFAULT_MODEL: 'gpt-6-luna', HERMES_PROVIDER: 'litellm', ACCOUNT_SECRET: 'test-secret'};
  const app = await createApp({ databaseSchema: {messageIdType: 'uuid', attachmentIdType: 'uuid', attachmentDurationColumns: ['duration_seconds', 'duration']},env, registry: ['personal', 'secondary'].map(accountId => ({channel: 'whatsapp', accountId, secretEnv: 'ACCOUNT_SECRET', connectorUrl: 'http://connector'})),
    db: {query: async (sql, args) => ({rows: /FROM conversations/.test(sql) && ['personal', 'secondary'].includes(args?.[0]) && ['contact', 'other'].includes(args?.[1]) ? [{id: args[1], name: 'Contact'}] : []})},
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/model/options')) return Response.json(inventory);
      calls.push({url, body: options?.body && JSON.parse(options.body)});
      if (url.endsWith('/model')) return Response.json({object: 'hermes.session.model_lock', runtime: {...JSON.parse(options.body)}});
      return upstream(url, options);
    }});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await app.close(); await rm(dir, {recursive: true, force: true});});
  const request = (path, body, extra = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {method: body ? 'POST' : 'GET',
    headers: {authorization: `Basic ${Buffer.from('test:test').toString('base64')}`, ...(body ? {origin: env.APP_PUBLIC_URL, 'content-type': 'application/json'} : {}), ...extra}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {app, request, calls};
}

const scope = {account: 'personal', chat: 'contact'};
const selection = {...scope, model: 'qwen3.8-flash-next', reasoningEffort: 'high'};
test('settings validate provider models, efforts, origin and account/chat isolation without touching Hermes sessions', async t => {
  const {app, request, calls} = await fixture(t);
  const original = await (await request('/api/ai/settings?account=personal&chat=contact')).json();
  assert.equal(original.model, 'gpt-6-luna');
  assert.equal(original.reasoningEffort, 'default');
  assert.equal((await request('/api/ai/settings', selection)).status, 200);
  assert.deepEqual((await app.sessions.canonical('personal', 'contact', false)).modelSettings, {model: selection.model, reasoningEffort: 'high'});
  for (const settings of [{...selection, model: 'foreign-secret-route'}, {...selection, reasoningEffort: 'ultra'}, {...selection, model: 'plain'}]) {
    assert.equal((await request('/api/ai/settings', settings)).status, 400);
  }
  assert.equal((await request('/api/ai/settings', selection, {origin: 'https://foreign.example'})).status, 403);
  assert.equal((await request('/api/ai/settings?account=personal&chat=missing')).status, 404);
  assert.equal((await request('/api/ai/settings?account=personal&chat=contact', undefined, {authorization: ''})).status, 401);
  for (const query of ['account=secondary&chat=contact', 'account=personal&chat=other']) assert.equal((await (await request(`/api/ai/settings?${query}`)).json()).model, 'gpt-6-luna');
  assert.equal(calls.length, 0);
});

test('selected model/options reach resumed lock and completion; resetting default clears reasoning', async t => {
  const {request, calls} = await fixture(t);
  await request('/api/ai/chat', {...scope, message: 'First'});
  await request('/api/ai/settings', selection);
  assert.equal((await request('/api/ai/chat', {...scope, message: 'Second'})).status, 200);
  const selected = calls.slice(-2);
  assert(selected[0].url.endsWith('/model'));
  for (const call of selected) {
    assert.equal(call.body.model, selection.model);
    assert.deepEqual(call.body.model_options, {reasoning: {enabled: true, effort: 'high'}});
    assert.equal(call.body.provider, 'litellm');
  }
  await request('/api/ai/settings', {...selection, reasoningEffort: 'default'});
  assert.equal((await request('/api/ai/chat', {...scope, message: 'Third'})).status, 200);
  assert.deepEqual(calls.slice(-2).map(call => call.body.model_options), [{}, {}]);
});

test('a retry keeps its original selection after settings change', async t => {
  let turns = 0;
  const {app, request, calls} = await fixture(t, async () => ++turns === 1 ? new Response('Temporary failure', {status: 503})
    : Response.json({choices: [{message: {content: 'Recovered'}}]}, {headers: {'x-hermes-session-id': 'native'}}));
  const body = {...scope, message: 'Resume', turnId: '11111111-1111-4111-8111-111111111111'};
  assert.equal((await request('/api/ai/chat', body)).status, 502);
  await request('/api/ai/settings', selection);
  assert.equal((await request('/api/ai/chat', body)).status, 200);
  const turnsSent = calls.filter(call => call.url.endsWith('/v1/chat/completions'));
  assert.deepEqual(turnsSent.map(call => [call.body.model, call.body.model_options]), [['gpt-6-luna', {}], ['gpt-6-luna', {}]]);
  assert.deepEqual((await app.sessions.canonical('personal', 'contact', false)).directSendAttempts[0].modelSettings, {model: 'gpt-6-luna', reasoningEffort: 'default'});
});

test('legacy unresolved attempts use the pre-selector deployment defaults after a selection change', async t => {
  let turns = 0;
  const {app, request, calls} = await fixture(t, async () => ++turns === 1 ? new Response('Temporary failure', {status: 503})
    : Response.json({choices: [{message: {content: 'Recovered'}}]}, {headers: {'x-hermes-session-id': 'native'}}));
  const body = {...scope, message: 'Legacy resume', turnId: '11111111-1111-4111-8111-111111111111'};
  assert.equal((await request('/api/ai/chat', body)).status, 502);
  const legacy = await app.sessions.canonical('personal', 'contact', false);
  delete legacy.directSendAttempts[0].modelSettings;
  await app.sessions.save(legacy);
  await request('/api/ai/settings', selection);
  assert.equal((await request('/api/ai/chat', body)).status, 200);
  assert.deepEqual(calls.filter(call => call.url.endsWith('/v1/chat/completions')).map(call => [call.body.model, call.body.model_options]), [['gpt-6-luna', {}], ['gpt-6-luna', {}]]);
});

test('settings save during an active turn waits for its transcript and affects only the next dispatch', async t => {
  let release, started;
  const began = new Promise(resolve => {started = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  t.after(() => release());
  let turns = 0;
  const {app, request, calls} = await fixture(t, async () => {
    if (++turns === 1) {started(); await gate;}
    return Response.json({choices: [{message: {content: 'Done'}}]}, {headers: {'x-hermes-session-id': 'native'}});
  });
  const active = request('/api/ai/chat', {...scope, message: 'Active'});
  await began;
  let saved = false;
  const save = request('/api/ai/settings', selection).then(response => {saved = true; return response;});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(saved, false);
  assert.equal(calls.length, 1);
  release();
  assert.equal((await active).status, 200);
  assert.equal((await save).status, 200);
  assert.equal((await app.sessions.canonical('personal', 'contact', false)).messages.length, 2);
  await request('/api/ai/chat', {...scope, message: 'Next'});
  assert.deepEqual(calls.filter(call => call.url.endsWith('/v1/chat/completions')).map(call => call.body.model), ['gpt-6-luna', selection.model]);
});

test('native run retry submits the original model and effort after a settings change', async t => {
  let submissions = 0;
  const error = "Provider authentication failed: Unknown provider 'old-provider'. Check 'hermes model' for available providers, or run 'hermes doctor' to diagnose config issues.";
  const {request, calls} = await fixture(t, async url => {
    if (url.endsWith('/runs')) return Response.json({run_id: ++submissions === 1 ? 'run_failed' : 'run_retry'});
    const failed = url.includes('run_failed');
    const data = failed ? {run_id: 'run_failed', status: 'failed', session_id: 'native', error} : {run_id: 'run_retry', status: 'completed', output: 'Recovered'};
    if (url.endsWith('/events')) return new Response(`event: run.${failed ? 'failed' : 'completed'}\ndata: ${JSON.stringify(data)}\n\n`, {headers: {'content-type': 'text/event-stream'}});
    return Response.json(data);
  }, {runs: true});
  await request('/api/ai/settings', selection);
  const body = {...scope, message: 'Resume', turnId: '11111111-1111-4111-8111-111111111111'};
  const failure = await (await request('/api/ai/chat', body)).json();
  assert.equal(failure.retryable, true);
  await request('/api/ai/settings', {...selection, model: 'gpt-6-luna', reasoningEffort: 'default'});
  const retry = await (await request('/api/ai/chat', {...body, retryFailedRun: true})).json();
  assert.equal(retry.text, 'Recovered');
  const sent = calls.filter(call => call.url.endsWith('/runs'));
  assert.equal(sent.length, 2);
  for (const call of sent) {
    assert.equal(call.body.model, selection.model);
    assert.deepEqual(call.body.model_options, {reasoning: {enabled: true, effort: 'high'}});
  }
});
