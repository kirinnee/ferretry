import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  DaemonResponseError,
  DaemonRuntimeModelCatalogStore,
  fetchRuntimeModelCatalog,
  parseRuntimeModelCatalog,
  requireRuntimeModelCatalogHarness,
  runtimeModelCatalogErrorMessage,
  type RuntimeModelCatalog,
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
