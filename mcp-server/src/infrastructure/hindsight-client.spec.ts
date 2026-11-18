import assert from 'node:assert/strict';
import {
  HindsightClient,
  HindsightError,
  hindsightConfigFromEnv,
  semanticProviderFromEnv,
  socialmediaScopeTag,
  socialmediaChatTag,
  socialmediaDocumentId,
  messageIdFromHindsightDocumentId,
  socialmediaConversationDocumentId,
  isSocialmediaConversationDocumentId,
  hindsightDestinationKey,
} from './hindsight-client';

const messageId = '550e8400-e29b-41d4-a716-446655440000';
const operationId = '650e8400-e29b-41d4-a716-446655440001';
const documentId = socialmediaDocumentId(messageId);
const scope = socialmediaScopeTag('whatsapp', 'personal', 'account1');
const chat = socialmediaChatTag('conversation1');
const config = hindsightConfigFromEnv({ HINDSIGHT_URL: 'http://hindsight.test/' });
const response = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });
const ack = {
  success: true,
  bank_id: config.bankId,
  items_count: 1,
  async: true,
  operation_id: operationId,
};

function fixture(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetchImpl = (async (url, init = {}) => {
    requests.push({
      url: String(url),
      init,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return handler(String(url), init);
  }) as typeof fetch;
  return { client: new HindsightClient(config, fetchImpl), requests, fetchImpl };
}

test('configuration defaults preserve brain and dedicate SocialMedia memory', () => {
  assert.equal(semanticProviderFromEnv({}), 'brain');
  assert.equal(semanticProviderFromEnv({ SEMANTIC_PROVIDER: 'hindsight' }), 'hindsight');
  assert.throws(() => semanticProviderFromEnv({ SEMANTIC_PROVIDER: 'other' }), /SEMANTIC_PROVIDER/);
  assert.equal(config.bankId, 'socialmedia-staticduo');
  assert.equal(config.timeoutMs, 30000);
  assert.equal(config.recallMaxTokens, 4096);
  assert.equal(config.recallBudget, 'mid');
  assert.equal(config.url, 'http://hindsight.test');
});

test('bank guards cover environment and direct construction', () => {
  for (const bankId of ['user-staticduo', 'user-ari', '../socialmedia', '', 'socialmedia/other']) {
    assert.throws(() => new HindsightClient({ ...config, bankId }), /dedicated socialmedia bank/);
    if (bankId)
      assert.throws(
        () => hindsightConfigFromEnv({ HINDSIGHT_BANK_ID: bankId }),
        /dedicated socialmedia bank/
      );
  }
  assert.equal(
    hindsightConfigFromEnv({ HINDSIGHT_BANK_ID: 'socialmedia-staging' }).bankId,
    'socialmedia-staging'
  );
});

test('invalid configuration never embeds secrets in errors', () => {
  for (const env of [
    { HINDSIGHT_URL: 'https://secret-key@hindsight.test' },
    { HINDSIGHT_URL: 'https://hindsight.test/?api_key=secret-key' },
    { HINDSIGHT_TIMEOUT_MS: '-1' },
    { HINDSIGHT_TIMEOUT_MS: '1.5' },
    { HINDSIGHT_TIMEOUT_MS: '300001' },
    { HINDSIGHT_RECALL_MAX_TOKENS: '32769' },
    { HINDSIGHT_RECALL_BUDGET: 'secret-key' },
    { HINDSIGHT_API_KEY: 'secret-key\r\nx: y' },
  ]) {
    assert.throws(
      () => hindsightConfigFromEnv(env),
      error =>
        error instanceof HindsightError &&
        error.code === 'config' &&
        !error.message.includes('secret-key')
    );
  }
});

test('scope encoding prevents account and conversation collisions', () => {
  assert.notEqual(socialmediaScopeTag('a:b', 'c', 'd'), socialmediaScopeTag('a', 'b:c', 'd'));
  assert.notEqual(
    socialmediaScopeTag('whatsapp', 'personal', 'a'),
    socialmediaScopeTag('telegram', 'personal', 'a')
  );
  assert.notEqual(socialmediaChatTag('a/b'), socialmediaChatTag('a%2Fb'));
  assert.equal(messageIdFromHindsightDocumentId(documentId), messageId);
  assert.equal(messageIdFromHindsightDocumentId('arbitrary-document'), undefined);
  assert.equal(messageIdFromHindsightDocumentId('socialmedia-not-a-uuid'), undefined);
  assert.throws(() => socialmediaDocumentId('not-a-uuid'), /UUID/);
});

test('initialization checks dedicated bank and confirms chunks mode', async () => {
  const { client, requests } = fixture(url =>
    response(
      url.endsWith('/config')
        ? {
            bank_id: config.bankId,
            config: { retain_extraction_mode: 'chunks', store_document_text: true },
            overrides: {},
          }
        : { bank_id: config.bankId }
    )
  );
  await client.initializeBank();
  assert.equal(requests[0].init.method, 'PUT');
  assert.equal(requests[0].body.name, config.bankId);
  assert.equal(requests[0].body.retain_extraction_mode, 'chunks');
  assert.equal(requests[1].init.method, 'PATCH');
  assert.deepEqual(requests[1].body, {
    updates: { retain_extraction_mode: 'chunks', store_document_text: true },
  });
  const bad = fixture(url =>
    response(
      url.endsWith('/config')
        ? { bank_id: config.bankId, config: { retain_extraction_mode: 'concise' } }
        : { bank_id: config.bankId }
    )
  );
  await assert.rejects(bad.client.initializeBank(), /chunks extraction mode/);
});

test('retain retries preserve stable operation UUID and document replace semantics', async () => {
  const { client, requests } = fixture(() => response(ack));
  const document = {
    documentId,
    operationId,
    content: 'message text',
    tags: [scope, chat],
    metadata: { message_id: messageId },
    timestamp: '2026-10-01T10:00:00Z',
  };
  assert.deepEqual(await client.retainDocument(document), { operationId });
  assert.deepEqual(await client.retainDocument(document), { operationId });
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(requests[0].body.async, true);
  assert.equal(requests[0].body.operation_id, operationId);
  assert.deepEqual(requests[0].body.items, [
    {
      content: document.content,
      document_id: documentId,
      update_mode: 'replace',
      metadata: document.metadata,
      tags: document.tags,
      timestamp: document.timestamp,
    },
  ]);
});

test('conversation IDs isolate every scope dimension and support append, recall and deletion', async () => {
  const parts = ['whatsapp', 'personal', 'account1', 'conversation1', ''] as const;
  const id = socialmediaConversationDocumentId(...parts);
  assert.equal(isSocialmediaConversationDocumentId(id), true);
  assert.equal(isSocialmediaConversationDocumentId(id + '0'), false);
  assert.equal(messageIdFromHindsightDocumentId(id), undefined);
  for (let i = 0; i < parts.length; i++) {
    const changed: string[] = [...parts];
    changed[i] += 'different';
    assert.notEqual(
      socialmediaConversationDocumentId(changed[0], changed[1], changed[2], changed[3], changed[4]),
      id
    );
  }
  assert.equal(
    hindsightDestinationKey({ url: config.url + '/', bankId: config.bankId }),
    hindsightDestinationKey(config)
  );
  const { client, requests } = fixture(url =>
    response(
      url.endsWith('/memories')
        ? ack
        : url.endsWith('/recall')
          ? { results: [{ id: 'chunk', text: 'transcript', document_id: id, tags: [scope, chat] }] }
          : { success: true, document_id: id }
    )
  );
  assert.equal(client.destination, hindsightDestinationKey(config));
  await client.retainDocument({
    documentId: id,
    operationId,
    content: 'new turn',
    tags: [scope, chat],
    updateMode: 'append',
  });
  assert.equal(requests[0].body.items[0].update_mode, 'append');
  assert.equal((await client.recall({ query: 'turn', tags: [scope] }))[0].documentId, id);
  await client.deleteDocument(id);
});

test('initialization fails closed when document text required by append is not confirmed', async () => {
  for (const stored of [undefined, false, 'true']) {
    const { client } = fixture(url =>
      response(
        url.endsWith('/config')
          ? {
              bank_id: config.bankId,
              config: { retain_extraction_mode: 'chunks', store_document_text: stored },
            }
          : { bank_id: config.bankId }
      )
    );
    await assert.rejects(client.initializeBank(), /document text storage required for append/);
  }
});

test('lost acknowledgement can be reconciled using the original operation ID', async () => {
  let operationAccepted = false;
  const { client, requests } = fixture(url => {
    if (url.endsWith('/memories')) {
      operationAccepted = true;
      throw new Error('transport with secret-key');
    }
    assert.equal(operationAccepted, true);
    return response({ operation_id: operationId, status: 'processing' });
  });
  await assert.rejects(
    client.retainDocument({ documentId, operationId, content: 'message', tags: [scope, chat] }),
    error =>
      error instanceof HindsightError &&
      error.code === 'transport' &&
      !error.message.includes('secret-key')
  );
  assert.deepEqual(await client.getOperation(operationId), { operationId, status: 'processing' });
  assert.equal(requests[0].body.operation_id, operationId);
  assert.ok(requests[1].url.endsWith(`/operations/${operationId}`));
});

test('retain requires valid document, stable UUID, account and chat scope', async () => {
  const { client, requests } = fixture(() => response(ack));
  const good = { documentId, operationId, content: 'message', tags: [scope, chat] };
  for (const input of [
    { ...good, operationId: 'random' },
    { ...good, documentId: 'foreign' },
    { ...good, tags: [scope] },
    { ...good, tags: [chat] },
    { ...good, tags: ['socialmedia:scope:invalid', chat] },
    { ...good, tags: [scope, scope, chat] },
    { ...good, content: '' },
    { ...good, timestamp: 'bad' },
    { ...good, metadata: { invalid: 1 } } as any,
    { ...good, updateMode: 'invalid' } as any,
  ])
    await assert.rejects(client.retainDocument(input), HindsightError);
  assert.equal(requests.length, 0);
});

test('retain rejects acknowledgements for other banks, operations and sync responses', async () => {
  for (const invalid of [
    { ...ack, bank_id: 'user-staticduo' },
    { ...ack, operation_id: messageId },
    { ...ack, async: false },
    { ...ack, success: false },
    { ...ack, items_count: 0 },
    {},
  ]) {
    const { client } = fixture(() => response(invalid));
    await assert.rejects(
      client.retainDocument({ documentId, operationId, content: 'message', tags: [scope, chat] }),
      error => error instanceof HindsightError && error.code === 'protocol'
    );
  }
});

test('operation status distinguishes all terminal and in-flight states', async () => {
  for (const status of ['pending', 'processing', 'completed', 'failed', 'cancelled', 'not_found']) {
    const { client } = fixture(() => response({ operation_id: operationId, status }));
    assert.deepEqual(await client.getOperation(operationId), { operationId, status });
  }
  const absent = fixture(() => response({}, 404));
  assert.deepEqual(await absent.client.getOperation(operationId), {
    operationId,
    status: 'not_found',
  });
  for (const invalid of [
    { operation_id: messageId, status: 'completed' },
    { operation_id: operationId, status: 'queued' },
  ]) {
    await assert.rejects(
      fixture(() => response(invalid)).client.getOperation(operationId),
      /invalid operation status/
    );
  }
});

test('operation retry retains UUID and verifies acknowledgement', async () => {
  const { client, requests } = fixture(() =>
    response({ success: true, operation_id: operationId })
  );
  assert.deepEqual(await client.retryOperation(operationId), { operationId });
  assert.equal(requests[0].init.method, 'POST');
  assert.ok(requests[0].url.endsWith(`/operations/${operationId}/retry`));
  await assert.rejects(
    fixture(() => response({ success: true, operation_id: messageId })).client.retryOperation(
      operationId
    ),
    /operation retry/
  );
});

test('delete validates document and treats already absent as success', async () => {
  const { client, requests } = fixture(() => response({ success: true, document_id: documentId }));
  await client.deleteDocument(documentId);
  assert.equal(requests[0].init.method, 'DELETE');
  await fixture(() => response({}, 404)).client.deleteDocument(documentId);
  await assert.rejects(
    fixture(() => response({ success: false, document_id: documentId })).client.deleteDocument(
      documentId
    ),
    /document deletion/
  );
});

test('recall sends strict compound scope and drops untagged, foreign and invented documents', async () => {
  const valid = {
    id: 'hit1',
    text: 'message',
    document_id: documentId,
    tags: [scope, chat],
    metadata: { message_id: 'untrusted-but-not-used' },
    scores: { final: 0.8 },
  };
  const { client, requests } = fixture(() =>
    response({
      results: [
        valid,
        { ...valid, id: 'untagged', tags: [] },
        { ...valid, id: 'foreign', tags: [chat] },
        { ...valid, id: 'observation', document_id: null },
        { ...valid, id: 'invented', document_id: 'foreign' },
      ],
    })
  );
  expect(await client.recall({ query: 'hello', tags: [scope, chat] })).toEqual([
    {
      id: 'hit1',
      text: 'message',
      documentId,
      tags: [scope, chat],
      metadata: valid.metadata,
      score: 0.8,
    },
  ]);
  assert.deepEqual(requests[0].body, {
    query: 'hello',
    tags: [scope, chat],
    tags_match: 'all_strict',
    max_tokens: config.recallMaxTokens,
    budget: config.recallBudget,
  });
  await assert.rejects(client.recall({ query: 'hello', tags: [] }), /compound account scope/);
});

test('recall accepts account-only filters and ignores malformed optional metadata and scores', async () => {
  const { client } = fixture(() =>
    response({
      results: [
        {
          id: 'hit',
          text: 'message',
          document_id: documentId,
          tags: [scope, chat],
          metadata: { bad: 42 },
          scores: { final: 'bad' },
        },
      ],
    })
  );
  const hits = await client.recall({ query: 'hello', tags: [scope] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].metadata, undefined);
  assert.equal(hits[0].score, undefined);
});

test('malformed JSON and schema responses fail without leaking response content', async () => {
  for (const res of [
    new Response('secret-key', { status: 200 }),
    response([]),
    response({ results: {} }),
    response({ results: [null] }),
    response({ results: [{ text: 'missing id' }] }),
  ]) {
    const { client } = fixture(() => res);
    await assert.rejects(
      client.recall({ query: 'hello', tags: [scope] }),
      error =>
        error instanceof HindsightError &&
        error.code === 'protocol' &&
        !error.message.includes('secret-key')
    );
  }
  for (const status of [401, 403, 409, 429, 500]) {
    const { client } = fixture(() => response({ detail: 'secret-key' }, status));
    await assert.rejects(
      client.recall({ query: 'hello', tags: [scope] }),
      error =>
        error instanceof HindsightError &&
        error.status === status &&
        !error.message.includes('secret-key')
    );
  }
});

test('timeout bounds transport and response body while aborting the request', async () => {
  for (const hangBody of [false, true]) {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (async (_url, init) => {
      signal = init?.signal;
      if (hangBody) return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const client = new HindsightClient({ ...config, timeoutMs: 10 }, fetchImpl);
    await assert.rejects(
      client.recall({ query: 'hello', tags: [scope] }),
      error => error instanceof HindsightError && error.code === 'timeout'
    );
    assert.equal(signal?.aborted, true);
  }
});

test('optional authorization header is sent without redirecting to another host', async () => {
  const { fetchImpl, requests } = fixture(() => response({ results: [] }));
  const client = new HindsightClient({ ...config, apiKey: 'secret-key' }, fetchImpl);
  await client.recall({ query: 'hello', tags: [scope] });
  assert.equal(
    (requests[0].init.headers as Record<string, string>).Authorization,
    'Bearer secret-key'
  );
  assert.equal(requests[0].init.redirect, 'error');
});
