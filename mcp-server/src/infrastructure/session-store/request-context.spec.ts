import { actorFromHeaders, getRequestActor, runWithRequestActor } from './request-context';

describe('SC-552 request actor context', () => {
  test('extracts sub and name from gateway headers', () => {
    expect(
      actorFromHeaders({ 'x-user-sub': 'keycloak-sub-1', 'x-user-name': ' Daniel ' })
    ).toEqual({ sub: 'keycloak-sub-1', name: 'Daniel' });
  });

  test('missing or blank headers → empty actor', () => {
    expect(actorFromHeaders({})).toEqual({});
    expect(actorFromHeaders({ 'x-user-sub': '  ', 'x-user-name': '' })).toEqual({});
  });

  test('duplicated header → first value wins', () => {
    expect(actorFromHeaders({ 'x-user-sub': ['sub-a', 'sub-b'] })).toEqual({ sub: 'sub-a' });
  });

  test('actor is visible down the await chain and empty outside any run', async () => {
    expect(getRequestActor()).toEqual({});
    const seen = await runWithRequestActor({ sub: 'sub-1', name: 'Ana' }, async () => {
      await Promise.resolve();
      return getRequestActor();
    });
    expect(seen).toEqual({ sub: 'sub-1', name: 'Ana' });
    expect(getRequestActor()).toEqual({});
  });

  test('concurrent requests keep their own actor', async () => {
    const [a, b] = await Promise.all([
      runWithRequestActor({ sub: 'sub-A' }, async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return getRequestActor().sub;
      }),
      runWithRequestActor({ sub: 'sub-B' }, async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return getRequestActor().sub;
      }),
    ]);
    expect(a).toBe('sub-A');
    expect(b).toBe('sub-B');
  });
});
