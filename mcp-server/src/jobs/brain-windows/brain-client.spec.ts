import { httpBrainClient, isPoison } from './brain-client';

const WID = 'cw:whatsapp:personal:c0a8f1d2-0000-4000-8000-000000000001:4711';
const config = { brainUrl: 'http://brain/', apiKey: 'k' };
const fetchMock = jest.fn();
(global as { fetch: unknown }).fetch = fetchMock;
const reply = (status: number, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });

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

  it('404 (unknown instance) and 422 (not a cw: id) are not swallowed and count as poison', async () => {
    for (const status of [404, 422]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(reply(status, 'nope'));
      const err = await httpBrainClient(config).deleteWindow('nope', WID).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(isPoison(err)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on 4xx
    }
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
