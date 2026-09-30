import { httpBrainClient, isPoison } from './brain-client';

const WID = 'cw:whatsapp:personal:c0a8f1d2-0000-4000-8000-000000000001:4711';
const config = { brainUrl: 'http://brain/', apiKey: 'k' };
const fetchMock = jest.fn();
(global as { fetch: unknown }).fetch = fetchMock;
const reply = (status: number, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });

describe('isPoison: only 400, 413 and 422 mean "the brain rejected the document"', () => {
  const err = (status: number) => new Error(`brain push-ingest personal/conversation -> ${status}: x`);
  it.each([400, 413, 422])('%i is poison', (status) => expect(isPoison(err(status))).toBe(true));
  it.each([401, 403, 404, 405, 408, 409, 429, 500, 502, 503])('%i is a configuration/availability failure, not poison', (status) => expect(isPoison(err(status))).toBe(false));
  it('a network error is not poison', () => expect(isPoison(new Error('fetch failed'))).toBe(false));
});

describe('brain-client.deleteWindow (brain-v2 POST /instances/{id}/delete-window)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('posts {"window_id"} with the API key to the instance route; 200 (deleted or not_found) is success', async () => {
    fetchMock.mockResolvedValue(reply(200, '{"status":"not_found"}'));
    await httpBrainClient(config).deleteWindow('personal', WID);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://brain/instances/personal/delete-window');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-Key']).toBe('k');
    expect(JSON.parse(init.body)).toEqual({ window_id: WID });
  });

  it('404 (absent route / unknown instance) is NOT success and NOT poison: thrown, no retry', async () => {
    fetchMock.mockResolvedValue(reply(404, 'nope'));
    const err = await httpBrainClient(config).deleteWindow('nope', WID).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isPoison(err)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('422 (not a cw: id) is thrown too, without retry', async () => {
    fetchMock.mockResolvedValue(reply(422, 'bad id'));
    const err = await httpBrainClient(config).deleteWindow('personal', 'wa:1').catch((e: Error) => e);
    expect(isPoison(err)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx and then succeeds', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(reply(502, 'Delete failed')).mockResolvedValueOnce(reply(200, '{}'));
    const p = httpBrainClient(config).deleteWindow('personal', WID);
    await jest.advanceTimersByTimeAsync(1_500);
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
