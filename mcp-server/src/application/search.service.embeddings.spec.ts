/**
 * El lector de búsqueda semántica tiene que preguntar por el MISMO modelo que
 * escribió `message_embeddings` (vector(1024), bge-m3 vía EMBEDDING_BASE_URL).
 * Estaba apuntado a la ruta de chat de LiteLLM con `text-embedding-3-small`
 * (1536 dims): la key no lo permite y la dimensión no cabe en la columna, así
 * que toda búsqueda caía en texto sin decir por qué (handoff 02-10, pendiente 2).
 */
import { SearchService } from './search.service';

const constructed: Array<Record<string, unknown>> = [];
const embeddingsCreate = jest.fn();
const logInfo = jest.fn();

// El log de arranque es la única señal de a qué modelo y qué anchura está
// preguntando el lector en producción; se afirma aquí en vez de a ojo en el pod.
jest.mock('pino', () => ({
  __esModule: true,
  default: () => ({
    info: logInfo,
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: () => ({ info: logInfo, warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  }),
}));

jest.mock('openai', () => ({
  __esModule: true,
  default: class FakeOpenAI {
    embeddings: { create: typeof embeddingsCreate };
    constructor(opts: Record<string, unknown>) {
      constructed.push(opts);
      this.embeddings = { create: embeddingsCreate };
    }
  },
}));

const BGE_URL = 'http://bge-m3-embedding.llm.svc.cluster.local:8000/v1';
const LITELLM_URL = 'http://litellm-router.litellm.svc.cluster.local:4000/v1';

function fakePool(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { query, pool: { query } as unknown as import('pg').Pool };
}

beforeEach(() => {
  constructed.length = 0;
  embeddingsCreate.mockReset();
  logInfo.mockClear();
  process.env.EMBEDDING_BASE_URL = BGE_URL;
  process.env.EMBEDDING_MODEL = 'bge-m3';
  process.env.EMBEDDING_DIMENSION = '1024';
});

it('pregunta las embeddings del query al servicio de embeddings, no a LiteLLM', async () => {
  embeddingsCreate.mockResolvedValue({ data: [{ embedding: new Array(1024).fill(0.1) }] });
  const { pool } = fakePool();
  const svc = new SearchService('key', pool, 'enc', LITELLM_URL);

  await svc.semanticSearch('pedido de material deportivo');

  expect(constructed[0].baseURL).toBe(BGE_URL);
  expect(embeddingsCreate).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'bge-m3', input: 'pedido de material deportivo' })
  );
});

it('sin EMBEDDING_BASE_URL sigue usando la base que ya tenía (no rompe otras instalaciones)', async () => {
  delete process.env.EMBEDDING_BASE_URL;
  embeddingsCreate.mockResolvedValue({ data: [{ embedding: new Array(1024).fill(0.1) }] });
  const { pool } = fakePool();
  const svc = new SearchService('key', pool, 'enc', LITELLM_URL);

  await svc.semanticSearch('hola');

  expect(constructed[0].baseURL).toBe(LITELLM_URL);
});

it('un vector de otra anchura no llega a Postgres: search() cae a texto y lo dice', async () => {
  embeddingsCreate.mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.1) }] });
  const { pool, query } = fakePool();
  const svc = new SearchService('key', pool, 'enc', LITELLM_URL);

  const results = await svc.search('hola');

  expect(results).toEqual([]);
  const sqls = query.mock.calls.map(c => String(c[0])).join('\n');
  expect(sqls).toContain('to_tsvector'); // la de texto, la única
  expect(sqls).not.toContain('<=>'); // nunca el operador vectorial
});

it('la rama vectorial sí devuelve coincidencias con su similarity, hablando con bge-m3', async () => {
  embeddingsCreate.mockResolvedValue({ data: [{ embedding: new Array(1024).fill(0.1) }] });
  const rows = [
    {
      message_id: '1346605',
      conversation_id: 'professional:174869610295503@lid',
      content: 'te paso el presupuesto del material',
      sender_wa_id: 'professional:3EB0AA',
      wa_timestamp: new Date('2026-10-03T22:31:10Z'),
      platform: 'whatsapp',
      account: 'professional',
      message_type: 'TEXT',
      similarity: '0.8312',
    },
  ];
  const query = jest.fn().mockResolvedValue({ rows });
  const svc = new SearchService('key', { query } as unknown as import('pg').Pool, 'enc', LITELLM_URL);

  const results = await svc.semanticSearch('presupuesto de material deportivo');

  expect(query).toHaveBeenCalledTimes(1);
  const sql = String(query.mock.calls[0][0]);
  expect(sql).toContain('<=>'); // el operador vectorial, no el de texto
  expect(sql).not.toContain('to_tsvector');
  expect(results).toHaveLength(1);
  expect(results[0].similarity).toBeCloseTo(0.8312, 4);
  // el vector via como parametro, en la forma que espera pgvector
  expect(String(query.mock.calls[0][1][0])).toMatch(/^\[0\.1(,0\.1)*\]$/);
});

it('el arranque dice a qué modelo y qué anchura pregunta el lector', () => {
  const { pool } = fakePool();
  new SearchService('key', pool, 'enc', LITELLM_URL);

  expect(logInfo).toHaveBeenCalledWith(
    expect.stringContaining('SearchService: modelo=bge-m3 dim=1024')
  );
  expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(`baseURL=${BGE_URL}`));
});
