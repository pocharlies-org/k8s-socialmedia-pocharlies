const callTool = jest.fn();
const connect = jest.fn(async () => undefined);
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect,
    callTool,
    close: jest.fn(async () => undefined),
  })),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));

import { HindsightBoundaryRecall, boundaryRecallConfigFromEnv } from './hindsight-boundary-recall';

const config = boundaryRecallConfigFromEnv({ HINDSIGHT_CLIENT_SECRET: 's3cret' });
const tokenOk = () =>
  new Response(JSON.stringify({ access_token: 'tok', expires_in: 300 }), { status: 200 });
const text = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });

beforeEach(() => jest.clearAllMocks());

it('falla cerrado sin la credencial del cliente', () => {
  expect(() => boundaryRecallConfigFromEnv({})).toThrow('HINDSIGHT_CLIENT_SECRET');
});

it('pide el token con client_credentials y lo reutiliza hasta que caduca', async () => {
  const fetchImpl = jest.fn(async () => tokenOk());
  callTool.mockResolvedValue(text({ results: [] }));
  const reader = new HindsightBoundaryRecall(config, fetchImpl as any);
  await reader.recall('q', ['type:conversation_chunk']);
  await reader.recall('q', ['type:conversation_chunk']);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const body = String((fetchImpl.mock.calls[0] as any)[1].body);
  expect(body).toContain('grant_type=client_credentials');
  expect(body).toContain('client_id=socialmedia-hindsight');
});

it('un error del proveedor de identidad no vuelca su cuerpo', async () => {
  const fetchImpl = jest.fn(
    async () => new Response('client_secret=s3cret rechazado', { status: 401 })
  );
  const reader = new HindsightBoundaryRecall(config, fetchImpl as any);
  await expect(reader.recall('q', ['t'])).rejects.toThrow(/^hindsight token: HTTP 401$/);
});

it('conserva solo hits con document_id y todos los tags pedidos, con su score final', async () => {
  callTool.mockResolvedValue(
    text({
      results: [
        {
          document_id: 'writer:a',
          tags: ['type:conversation_chunk', 'account:personal'],
          scores: { final: 0.7 },
        },
        { document_id: 'writer:b', tags: ['type:conversation_chunk'], scores: { final: 0.9 } },
        {
          document_id: null,
          tags: ['type:conversation_chunk', 'account:personal'],
          scores: { final: 0.8 },
        },
      ],
    })
  );
  const reader = new HindsightBoundaryRecall(config, jest.fn(async () => tokenOk()) as any);
  expect(await reader.recall('q', ['type:conversation_chunk', 'account:personal'])).toEqual([
    { documentId: 'writer:a', score: 0.7 },
  ]);
  expect(callTool.mock.calls[0][0]).toMatchObject({
    name: 'recall',
    arguments: { query: 'q', tags_match: 'all_strict' },
  });
});

it('una respuesta que no es de recall es un error, no una lista vacía', async () => {
  callTool.mockResolvedValue(text({ nope: true }));
  const reader = new HindsightBoundaryRecall(config, jest.fn(async () => tokenOk()) as any);
  await expect(reader.recall('q', ['t'])).rejects.toThrow('respuesta inválida');
});
