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
