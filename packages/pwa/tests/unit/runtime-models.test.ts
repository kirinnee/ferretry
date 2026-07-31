import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  DaemonResponseError,
  DaemonRuntimeModelCatalogStore,
  fetchRuntimeModelCatalog,
  parseRuntimeModelCatalog,
  type RuntimeModelCatalog,
  requireRuntimeModelCatalogHarness,
  runtimeModelCatalogErrorMessage,
} from '../../src/lib/runtime-models.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'same/session');
const scopeB = daemonSessionScope(daemonB, 'same/session');

const catalog = (label: string): RuntimeModelCatalog => ({
  harness: 'codex',
  source: 'codex-app-server',
  choices: [
    {
      value: 'gpt-5.6-sol',
      label,
      description: 'Frontier',
      isDefault: true,
      reasoningEfforts: [{ value: 'medium', description: 'Balanced' }, { value: 'ultra' }],
      defaultReasoningEffort: 'medium',
    },
  ],
});

const responseFor = (value: RuntimeModelCatalog): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

/** A fetcher whose response settles only when the test resolves it, modelling a slow daemon. */
const deferredResponse = (): { resolve: (value: Response) => void; response: Promise<Response> } => {
  let resolve!: (value: Response) => void;
  const response = new Promise<Response>(res => {
    resolve = res;
  });
  return { resolve, response };
};

describe('runtime model catalog parsing', () => {
  it('should preserve opaque ordered model data and optional values', () => {
    should(parseRuntimeModelCatalog(catalog('GPT-5.6 Sol'))).deepEqual(catalog('GPT-5.6 Sol'));
    should(parseRuntimeModelCatalog({ harness: 'claude', source: 'wrapper-inventory', choices: [] })).deepEqual({
      harness: 'claude',
      source: 'wrapper-inventory',
      choices: [],
    });
  });

  it('should reject malformed catalogs, choices, and effort ids', () => {
    should(() => parseRuntimeModelCatalog({ harness: 'other', source: 'codex-app-server', choices: [] })).throw(
      /invalid runtime model catalog/u,
    );
    should(() =>
      parseRuntimeModelCatalog({ harness: 'codex', source: 'codex-app-server', choices: [{ value: 'm' }] }),
    ).throw(/invalid runtime model choice/u);
    should(() =>
      parseRuntimeModelCatalog({
        harness: 'codex',
        source: 'codex-app-server',
        choices: [{ value: 'm', label: 'M', reasoningEfforts: [{}] }],
      }),
    ).throw(/invalid runtime reasoning choice/u);
  });

  it('should reject a catalog whose harness does not match the session', () => {
    should(() => requireRuntimeModelCatalogHarness(catalog('Codex'), 'claude')).throw(
      /codex model catalog for a claude session/u,
    );
    should(requireRuntimeModelCatalogHarness(catalog('Codex'), 'codex')).deepEqual(catalog('Codex'));
  });

  it('should explain missing routes without recommending an ineffective restart', () => {
    const absent = runtimeModelCatalogErrorMessage(new DaemonResponseError(404, 'missing', 'unknown_route'));
    should(absent).containEql('does not provide the runtime model catalog endpoint');
    should(absent).containEql('Restarting an unchanged daemon build will not add the missing route');
    should(runtimeModelCatalogErrorMessage(new Error('other'))).equal('other');
    should(runtimeModelCatalogErrorMessage('other')).equal('other');
  });
});

describe('daemon-scoped runtime model catalog queries', () => {
  it('should query the paired daemon with the encoded session route and device credential', async () => {
    let requested: { url: string; init: RequestInit } | undefined;
    const result = await fetchRuntimeModelCatalog(daemonA, scopeA, async (input, init) => {
      requested = { url: String(input), init: init ?? {} };
      return responseFor(catalog('A'));
    });

    should(result.choices[0]?.label).equal('A');
    should(requested?.url).equal('https://a.example.test/v1/sessions/same%2Fsession/runtime-models');
    should(new Headers(requested?.init.headers).get('authorization')).equal('Bearer token-a');
    should(requested?.init.credentials).equal('include');
  });

  it('should reject cross-daemon scopes and expose daemon failures', async () => {
    const crossDaemon = (): Promise<RuntimeModelCatalog> =>
      fetchRuntimeModelCatalog(daemonA, scopeB, async () => responseFor(catalog('no')));
    await should(crossDaemon()).be.rejectedWith('runtime model scope must belong to the requested daemon');

    const unavailable = fetchRuntimeModelCatalog(
      daemonA,
      scopeA,
      async () =>
        new Response(JSON.stringify({ error: 'catalog timed out', code: 'catalog_timeout' }), { status: 503 }),
    );
    await should(unavailable).be.rejectedWith('catalog timed out');

    const nonJson = fetchRuntimeModelCatalog(daemonA, scopeA, async () => new Response('no', { status: 500 }));
    await should(nonJson).be.rejectedWith('HTTP 500');
  });

  it('should cache and coalesce only an identical daemon/session query', async () => {
    const store = new DaemonRuntimeModelCatalogStore();
    let requests = 0;
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      requests += 1;
      return responseFor(catalog(String(input).startsWith('https://a.') ? 'A' : 'B'));
    };

    const [first, sameRequest, otherDaemon] = await Promise.all([
      store.load(daemonA, scopeA, fetcher),
      store.load(daemonA, scopeA, fetcher),
      store.load(daemonB, scopeB, fetcher),
    ]);
    should(first).equal(sameRequest);
    should(first.choices[0]?.label).equal('A');
    should(otherDaemon.choices[0]?.label).equal('B');
    should(requests).equal(2);
    should(store.get(scopeA)).equal(first);
    should(store.get(scopeB)).equal(otherDaemon);
    should(await store.load(daemonA, scopeA, fetcher)).equal(first);
    should(requests).equal(2);

    store.clearDaemon(daemonA.daemonId);
    should(store.get(scopeA)).equal(undefined);
    should(store.get(scopeB)).equal(otherDaemon);
  });
});

describe('daemon runtime model catalog fencing', () => {
  it('should not publish a result that completes after its daemon is cleared', async () => {
    const store = new DaemonRuntimeModelCatalogStore();
    const slow = deferredResponse();
    const loadPromise = store.load(daemonA, scopeA, async () => slow.response);
    should(store.get(scopeA)).equal(undefined);

    store.clearDaemon(daemonA.daemonId);
    slow.resolve(responseFor(catalog('stale')));
    const result = await loadPromise;

    // The original caller still receives its own result, but the late completion
    // must not repopulate the shared cache after the clear.
    should(result.choices[0]?.label).equal('stale');
    should(store.get(scopeA)).equal(undefined);
  });

  it('should treat a same-id re-pair as a new generation and never publish or coalesce the prior token result', async () => {
    const store = new DaemonRuntimeModelCatalogStore();
    const oldToken = deferredResponse();
    let requests = 0;
    const oldLoad = store.load(daemonA, scopeA, async () => {
      requests += 1;
      return oldToken.response;
    });

    // Same daemon id and base URL, rotated device token: a re-pair, not a reuse.
    const rePaired = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'token-a-rotated',
    });
    const fresh = await store.load(rePaired, scopeA, async () => {
      requests += 1;
      return responseFor(catalog('fresh'));
    });
    should(fresh.choices[0]?.label).equal('fresh');
    // The re-pair issued its own request instead of coalescing onto the old token.
    should(requests).equal(2);

    oldToken.resolve(responseFor(catalog('old-token')));
    await oldLoad;
    should(store.get(scopeA)?.choices[0]?.label).equal('fresh');
  });

  it('should isolate the same session id across two daemons, including a late result', async () => {
    const store = new DaemonRuntimeModelCatalogStore();
    const slowA = deferredResponse();
    const loadA = store.load(daemonA, scopeA, async () => slowA.response);
    const daemonBResult = await store.load(daemonB, scopeB, async () => responseFor(catalog('B')));
    should(daemonBResult.choices[0]?.label).equal('B');

    // daemon-a's late completion must land only in daemon-a's slot, never daemon-b's.
    slowA.resolve(responseFor(catalog('A-late')));
    await loadA;
    should(store.get(scopeA)?.choices[0]?.label).equal('A-late');
    should(store.get(scopeB)?.choices[0]?.label).equal('B');
  });
});
