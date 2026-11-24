import { describe, expect, test } from 'bun:test';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { Log } from '@ferretry/kernel/contract';
import { config as hostConfig, state as hostState } from '@ferretry/kernel/host';
import type { DaemonImplementation, Manifest } from '@ferretry/kernel/manifest';
import { ferret, owner, testHost } from '@ferretry/kernel/testing';
import {
  SEARCH_CONFIG,
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDERS,
  SearchViewSchema,
  searchKeyReference,
  type SearchProviderId,
} from '../../contract/index.ts';
import search from '../../daemon/index.ts';
import { SEARCH_MESSAGES } from '../../daemon/lib/service.ts';

const KEY = 'planted-search-key-4f9a1c2e';
const OFF = 'No search provider set up: Settings › Web search';

/** What each provider's own server answers: one result, in that provider's own shape. */
const REPLIES: Readonly<Record<SearchProviderId, unknown>> = {
  serper: { organic: [{ title: 'Serper hit', link: 'https://found.test/serper', snippet: 'about serper' }] },
  firecrawl: {
    data: { web: [{ title: 'Firecrawl hit', url: 'https://found.test/fc', description: 'about firecrawl' }] },
  },
  brave: { web: { results: [{ title: 'Brave hit', url: 'https://found.test/brave', description: 'about brave' }] } },
  perplexity: { results: [{ title: 'Perplexity hit', url: 'https://found.test/px', snippet: 'about perplexity' }] },
  exa: { results: [{ title: 'Exa hit', url: 'https://found.test/exa' }] },
  tavily: { results: [{ title: 'Tavily hit', url: 'https://found.test/tavily', content: 'about tavily' }] },
};

interface Seen {
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

type Answer = (seen: Seen) => Response | Promise<Response>;

/** A fake server per provider host: records what arrived and answers each provider in its own shape. */
function servers(answer?: Answer) {
  const seen: Seen[] = [];
  const fetch = async (url: URL, init?: RequestInit): Promise<Response> => {
    const entry: Seen = {
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    seen.push(entry);
    if (answer !== undefined) return await answer(entry);
    const id = SEARCH_PROVIDER_IDS.find(candidate => SEARCH_PROVIDERS[candidate].host === url.host);
    return id === undefined ? new Response('no such host', { status: 404 }) : Response.json(REPLIES[id]);
  };
  return { seen, fetch };
}

const quiet: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };

/**
 * The kernel's REAL config writer over an in-memory home that declares `search.yaml`. With `owner: false` the judge lets
 * nothing loosen, so an added key reference (and a raised cap) is HELD; with `owner: true` it answers what Gate answers
 * the owner at the machine. The same wiring Warden's tests use (`tests/unit/parity/host.ts`).
 */
function realConfig(owner: boolean) {
  const files = hostConfig.createConfigFiles({
    home: '/home/fy',
    fs: hostState.createMemoryHostFs(),
    clock: { nowMs: () => Date.parse('2026-11-07T12:00:00.000Z'), after: () => () => {}, every: () => () => {} },
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'search', def: SEARCH_CONFIG }],
    ...(owner ? { judge: () => true } : {}),
  });
  return files.port('search');
}

const over = (port: ReturnType<typeof realConfig>): DaemonImplementation<Manifest> =>
  ({
    ...search,
    build: (given: Parameters<NonNullable<typeof search.build>>[0]) =>
      search.build?.({ ...given, kernel: { ...given.kernel, config: port } } as typeof given),
  }) as unknown as DaemonImplementation<Manifest>;

async function hostFor(
  file: Record<string, unknown> | undefined,
  options: {
    readonly vault?: Record<string, string>;
    readonly answer?: Answer;
    readonly real?: ReturnType<typeof realConfig>;
  } = {},
) {
  const world = servers(options.answer);
  const host = await testHost({
    plugins: [options.real === undefined ? search : over(options.real)],
    ...(file === undefined ? {} : { config: { 'search.yaml': file } }),
    ...(options.vault === undefined ? {} : { vault: options.vault }),
    // Search needs the Vault only for the Settings screen's key paste; the key it SPENDS is `vault` above, the kernel's.
    fakes: { vault: new FakeVault() },
    fetch: world.fetch,
  });
  return { host, seen: world.seen };
}

const named = (id: SearchProviderId, extra: Record<string, unknown> = {}) => ({
  provider: id,
  key: searchKeyReference(id),
  ...extra,
});
const stored = (id: SearchProviderId) => ({ [SEARCH_PROVIDERS[id].secretName]: KEY });
const asFerret = { as: ferret('f1') } as const;

describe('web_search is off until a key is named and stored', () => {
  test('with no search.yaml the tool says so, and nothing leaves the machine', async () => {
    const { host, seen } = await hostFor(undefined, { vault: stored('serper') });
    const result = await host.tool('web_search', { query: 'anything' }, asFerret);
    expect(result).toMatchObject({ isError: true, text: OFF });
    expect(seen).toEqual([]);
    await host.stop();
  });

  test('a provider with no key line is still off, whatever the Vault holds', async () => {
    const { host, seen } = await hostFor({ provider: 'serper' }, { vault: stored('serper') });
    expect((await host.tool('web_search', { query: 'anything' }, asFerret)).text).toBe(OFF);
    expect(seen).toEqual([]);
    await host.stop();
  });

  test('a named key the Vault does not hold is off too, and the missing key never burns the day', async () => {
    const { host, seen } = await hostFor(named('brave', { dailyCap: 1 }));
    for (let attempt = 0; attempt < 4; attempt += 1)
      expect((await host.tool('web_search', { query: 'anything' }, asFerret)).text).toBe(OFF);
    expect(seen).toEqual([]);
    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view).toMatchObject({ provider: 'brave', keyNamed: true, usedToday: 0, dailyCap: 1 });
    await host.stop();
  });

  test('a bad input is told what the tool takes, before anything is counted or sent', async () => {
    const { host, seen } = await hostFor(named('serper'), { vault: stored('serper') });
    for (const input of [{}, { query: '' }, { query: 'ok', count: 99 }, { query: 'ok', extra: true }]) {
      const result = await host.tool('web_search', input, asFerret);
      expect(result.isError).toBe(true);
    }
    expect(seen).toEqual([]);
    await host.stop();
  });
});

describe('each of the six providers answers a ferret', () => {
  test.each(SEARCH_PROVIDER_IDS)(
    '%s: one request to its own host with the key placed, results marked untrusted',
    async id => {
      const { host, seen } = await hostFor(named(id), { vault: stored(id) });

      const result = await host.tool('web_search', { query: 'zig comptime', count: 3 }, asFerret);

      expect(result.isError).toBeUndefined();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url.host).toBe(SEARCH_PROVIDERS[id].host);
      const header =
        id === 'serper' || id === 'exa' ? 'x-api-key' : id === 'brave' ? 'x-subscription-token' : 'authorization';
      expect(seen[0]?.headers[header]).toBe(header === 'authorization' ? `Bearer ${KEY}` : KEY);
      expect(result.text).toContain('untrusted');
      expect(result.text).toContain(
        `https://found.test/${id === 'firecrawl' ? 'fc' : id === 'perplexity' ? 'px' : id}`,
      );
      expect(result.data).toMatchObject({ provider: id });
      // the key rides the request and nothing else: not the answer, not a log
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(host.logs)).not.toContain(KEY);
      expect(JSON.stringify(host.logs)).not.toContain('zig comptime');
      await host.stop();
    },
  );

  test('a provider with no results says so', async () => {
    const { host } = await hostFor(named('tavily'), {
      vault: stored('tavily'),
      answer: () => Response.json({ results: [] }),
    });
    const result = await host.tool('web_search', { query: 'nothing here' }, asFerret);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('No results.');
    await host.stop();
  });

  test('a provider’s failure is one fixed sentence, never its body', async () => {
    const cases: readonly [number, keyof typeof SEARCH_MESSAGES][] = [
      [401, 'rejected'],
      [403, 'rejected'],
      [429, 'rate_limited'],
      [500, 'provider_error'],
    ];
    for (const [status, code] of cases) {
      const { host } = await hostFor(named('exa'), {
        vault: stored('exa'),
        answer: () => new Response(`secret details ${KEY}`, { status }),
      });
      const result = await host.tool('web_search', { query: 'q' }, asFerret);
      expect(result).toMatchObject({ isError: true, text: SEARCH_MESSAGES[code] });
      await host.stop();
    }
  });

  test('a network failure and a reply that is not JSON are told apart', async () => {
    const down = await hostFor(named('exa'), {
      vault: stored('exa'),
      answer: () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    expect((await down.host.tool('web_search', { query: 'q' }, asFerret)).text).toBe(SEARCH_MESSAGES.unreachable);
    await down.host.stop();

    const odd = await hostFor(named('exa'), { vault: stored('exa'), answer: () => new Response('<html>hi</html>') });
    expect((await odd.host.tool('web_search', { query: 'q' }, asFerret)).text).toBe(SEARCH_MESSAGES.malformed);
    await odd.host.stop();
  });
});

describe('the daily cap', () => {
  test('stops at the cap with a sentence that says how to raise it, and sends nothing past it', async () => {
    const { host, seen } = await hostFor(named('serper', { dailyCap: 2 }), { vault: stored('serper') });
    expect((await host.tool('web_search', { query: 'one' }, asFerret)).isError).toBeUndefined();
    expect((await host.tool('web_search', { query: 'two' }, asFerret)).isError).toBeUndefined();

    const third = await host.tool('web_search', { query: 'three' }, asFerret);

    expect(third.isError).toBe(true);
    expect(third.text).toContain('2 a day');
    expect(third.text).toContain('Settings › Web search');
    expect(seen).toHaveLength(2);
    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view).toMatchObject({ usedToday: 2, dailyCap: 2 });
    await host.stop();
  });

  test('the default is 200 a day when search.yaml names none', async () => {
    const { host } = await hostFor(named('serper'), { vault: stored('serper') });
    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.dailyCap).toBe(200);
    await host.stop();
  });

  test('a new day starts the count again', async () => {
    const { host, seen } = await hostFor(named('serper', { dailyCap: 1 }), { vault: stored('serper') });
    expect((await host.tool('web_search', { query: 'a' }, asFerret)).isError).toBeUndefined();
    expect((await host.tool('web_search', { query: 'b' }, asFerret)).isError).toBe(true);

    await host.clock.advance(36 * 60 * 60 * 1000);

    expect((await host.tool('web_search', { query: 'c' }, asFerret)).isError).toBeUndefined();
    expect(seen).toHaveLength(2);
    await host.stop();
  });

  test('ferrets searching at once can never take more than the cap between them', async () => {
    const { host, seen } = await hostFor(named('serper', { dailyCap: 3 }), { vault: stored('serper') });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        host.tool('web_search', { query: `q${String(index)}` }, ferret(`f${String(index)}`) && asFerret),
      ),
    );
    expect(results.filter(result => result.isError !== true)).toHaveLength(3);
    expect(seen).toHaveLength(3);
    await host.stop();
  });
});

describe('Settings › Web search routes', () => {
  test('a ferret may use the tool but may not set up or test: those are a person’s act', async () => {
    const { host, seen } = await hostFor(named('serper'), { vault: stored('serper') });
    expect(
      (await host.request('PUT', '/v1/web-search/setup', { ...asFerret, body: { provider: 'brave' } })).status,
    ).toBe(403);
    expect((await host.request('POST', '/v1/web-search/test', asFerret)).status).toBe(403);
    expect(seen).toEqual([]);
    await host.stop();
  });

  test('the owner names a provider; its key is then the only one in use', async () => {
    const { host } = await hostFor(undefined, { vault: stored('brave'), real: realConfig(true) });
    const before = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(before).toMatchObject({ keyNamed: false, usedToday: 0 });
    expect(before.provider).toBeUndefined();

    const done = await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { provider: 'brave' } });
    expect(done.status).toBe(200);
    expect(done.json()).toEqual({ outcome: 'applied', held: [] });

    const after = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(after).toMatchObject({ provider: 'brave', keyNamed: true });
    // The test host's own secret rule reads ITS config, not the stand-in writer's: hand it the file the writer made.
    host.setConfig('search.yaml', named('brave'));
    expect((await host.tool('web_search', { query: 'q' }, asFerret)).isError).toBeUndefined();
    await host.stop();
  });

  test('a setup nobody may confirm is held, says so, and leaves search off', async () => {
    const { host, seen } = await hostFor(undefined, { vault: stored('brave'), real: realConfig(false) });

    const done = await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { provider: 'brave' } });

    expect(done.status).toBe(200);
    expect(done.json()).toMatchObject({ outcome: 'held', held: [expect.stringContaining('BRAVE_API_KEY')] });
    expect(done.body).not.toContain('${secret:');
    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.keyNamed).toBe(false);
    expect(view.held).toEqual([expect.stringContaining('BRAVE_API_KEY')]);
    expect((await host.tool('web_search', { query: 'q' }, asFerret)).text).toBe(OFF);
    expect(seen).toEqual([]);
    await host.stop();
  });

  test('raising the daily limit is the owner’s to confirm; lowering it is applied at once', async () => {
    const held = await hostFor(undefined, { real: realConfig(false) });
    await held.host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { dailyCap: 500 } });
    const view = SearchViewSchema.parse((await held.host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.dailyCap).toBe(200);
    expect(view.held).toEqual([expect.stringContaining('from 200 to 500')]);
    await held.host.stop();

    const lowered = await hostFor(undefined, { real: realConfig(false) });
    const answer = await lowered.host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { dailyCap: 50 } });
    expect(answer.json()).toEqual({ outcome: 'applied', held: [] });
    const after = SearchViewSchema.parse((await lowered.host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(after.dailyCap).toBe(50);
    await lowered.host.stop();
  });

  test('a setup that is not a provider or a cap is a 400', async () => {
    const { host } = await hostFor(undefined);
    expect(
      (await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { provider: 'bing' } })).status,
    ).toBe(400);
    expect((await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: 'not json' })).status).toBe(400);
    await host.stop();
  });

  test('Test is one real search, counted, remembered, and says what it proved', async () => {
    const { host, seen } = await hostFor(named('tavily', { dailyCap: 1 }), { vault: stored('tavily') });
    const response = await host.request('POST', '/v1/web-search/test', { as: owner() });
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ provider: 'tavily', ok: true, code: 'ok', message: SEARCH_MESSAGES.ok });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ max_results: 1 });

    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.usedToday).toBe(1);
    expect(view.lastTest).toMatchObject({ provider: 'tavily', ok: true });
    // the owner's own act is never refused for the cap, even when the day is used up
    expect((await host.request('POST', '/v1/web-search/test', { as: owner() })).status).toBe(200);
    await host.stop();
  });

  test('a Test of a key the provider refuses says rejected', async () => {
    const { host } = await hostFor(named('tavily'), {
      vault: stored('tavily'),
      answer: () => new Response('', { status: 401 }),
    });
    const result = (await host.request('POST', '/v1/web-search/test', { as: owner() })).json();
    expect(result).toMatchObject({ ok: false, code: 'rejected' });
    await host.stop();
  });

  test('a Test with no provider picked is a 409 that says what to do', async () => {
    const { host, seen } = await hostFor(undefined);
    const response = await host.request('POST', '/v1/web-search/test', { as: owner() });
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'not_set' });
    expect(seen).toEqual([]);
    await host.stop();
  });
});
