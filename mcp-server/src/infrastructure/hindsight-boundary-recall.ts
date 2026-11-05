import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Read plane of Hindsight for the semantic message search (SC-4304 S8): the
 * AgentGateway machine route `/hindsight-personal`, a Keycloak client_credentials
 * token for `socialmedia-hindsight` (role agentgateway-read:hindsight-personal),
 * and the read-only MCP tool `recall`. Writes never come through here.
 */
export interface BoundaryRecallConfig {
  gatewayUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
  maxTokens: number;
  /** Hindsight `scores.final` floor; it is not the brain reranker logit. */
  minScore: number;
  /** Writer identities whose documents this reader may resolve (document ids are hashed per identity). */
  writerIdentities: string[];
}

export interface BoundaryHit {
  documentId: string;
  score: number;
}

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const number = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return value?.trim() && Number.isFinite(n) ? n : fallback;
};

export function boundaryRecallConfigFromEnv(env: Env = process.env): BoundaryRecallConfig {
  const clientSecret = env.HINDSIGHT_CLIENT_SECRET?.trim() || '';
  // Fail closed: SEMANTIC_PROVIDER=hindsight without the credential is a deploy error.
  if (!clientSecret) throw new Error('HINDSIGHT_CLIENT_SECRET is required for hindsight search');
  return {
    gatewayUrl:
      env.HINDSIGHT_GATEWAY_URL?.trim() ||
      'http://agentgateway-mcp.agentgateway.svc.cluster.local:3000/hindsight-personal',
    tokenUrl:
      env.HINDSIGHT_TOKEN_URL?.trim() ||
      'http://keycloak.keycloak.svc.cluster.local/realms/edani/protocol/openid-connect/token',
    clientId: env.HINDSIGHT_CLIENT_ID?.trim() || 'socialmedia-hindsight',
    clientSecret,
    timeoutMs: number(env.HINDSIGHT_TIMEOUT_MS, 10000),
    maxTokens: number(env.HINDSIGHT_RECALL_MAX_TOKENS, 8192),
    // Set from the measured probes before the cutover (see search.service.ts, DEFAULT_SEMANTIC_MIN_SCORE).
    minScore: number(env.HINDSIGHT_MIN_SCORE, 0),
    // synapse-personal = the live brain_window path; socialmedia-mensajes = this repo's backfill.
    writerIdentities: (
      env.HINDSIGHT_WRITER_IDENTITIES?.trim() || 'synapse-personal,socialmedia-mensajes'
    )
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),
  };
}

export class HindsightBoundaryRecall {
  readonly minScore: number;
  readonly writerIdentities: string[];
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly config: BoundaryRecallConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {
    this.minScore = config.minScore;
    this.writerIdentities = config.writerIdentities;
  }

  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const response = await this.fetchImpl(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
      redirect: 'error',
    });
    // Bodies of identity-provider errors are never echoed: they may carry the client id/secret.
    if (!response.ok) throw new Error(`hindsight token: HTTP ${response.status}`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token)
      throw new Error('hindsight token: respuesta sin access_token');
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + number(String(body.expires_in), 60) * 1000,
    };
    return this.token.value;
  }

  /** Documents whose tags include every requested tag (`all_strict`), best first. */
  async recall(query: string, tags: string[]): Promise<BoundaryHit[]> {
    const token = await this.bearer();
    const client = new Client({ name: 'socialmedia-mcp-server', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.config.gatewayUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
      fetch: this.fetchImpl as typeof fetch,
    });
    try {
      await client.connect(transport, { timeout: this.config.timeoutMs });
      const result = await client.callTool(
        {
          name: 'recall',
          arguments: {
            query,
            tags,
            tags_match: 'all_strict',
            budget: 'mid',
            max_tokens: this.config.maxTokens,
          },
        },
        undefined,
        { timeout: this.config.timeoutMs }
      );
      if (result.isError) throw new Error('hindsight recall: la tool devolvió un error');
      const content = result.content as Array<{ type: string; text?: string }> | undefined;
      const text = content?.find(c => c.type === 'text')?.text;
      const body = (result.structuredContent ?? (text ? JSON.parse(text) : undefined)) as
        { results?: unknown } | undefined;
      if (!Array.isArray(body?.results)) throw new Error('hindsight recall: respuesta inválida');
      const hits: BoundaryHit[] = [];
      for (const raw of body.results as Array<Record<string, unknown>>) {
        const scores = raw.scores as { final?: unknown } | undefined;
        // Observations carry no document id, and an unscoped hit is never ours to read.
        if (
          typeof raw.document_id !== 'string' ||
          !Array.isArray(raw.tags) ||
          !tags.every(tag => (raw.tags as unknown[]).includes(tag))
        )
          continue;
        hits.push({
          documentId: raw.document_id,
          score: typeof scores?.final === 'number' ? scores.final : 0,
        });
      }
      return hits;
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
