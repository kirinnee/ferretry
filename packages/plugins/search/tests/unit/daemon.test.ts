import { describe, expect, test } from 'bun:test';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { Log, OutboundSecretOutcome } from '@ferretry/kernel/contract';
import { config as hostConfig, state as hostState } from '@ferretry/kernel/host';
import type { DaemonImplementation, Manifest } from '@ferretry/kernel/manifest';
import { ferret, owner, testHost } from '@ferretry/kernel/testing';
import {
  SEARCH_CONFIG,
  SEARCH_LEDGER_STATE,
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
function realConfig(owner: boolean | (() => boolean)) {
  const files = hostConfig.createConfigFiles({
    home: '/home/fy',
    fs: hostState.createMemoryHostFs(),
    clock: { nowMs: () => Date.parse('2026-11-07T12:00:00.000Z'), after: () => () => {}, every: () => () => {} },
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'search', def: SEARCH_CONFIG }],
    ...(owner === false ? {} : { judge: typeof owner === 'function' ? owner : () => true }),
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
    readonly plugin?: DaemonImplementation<Manifest>;
  } = {},
) {
  const world = servers(options.answer);
  const host = await testHost({
    plugins: [options.plugin ?? (options.real === undefined ? search : over(options.real))],
    ...(file === undefined ? {} : { config: { 'search.yaml': file } }),
    ...(options.vault === undefined ? {} : { vault: options.vault }),
    // Search needs the Vault only for the Settings screen's key paste; the key it SPENDS is `vault` above, the kernel's.
    fakes: { vault: new FakeVault() },
    fetch: world.fetch,
  });
  return { host, seen: world.seen };
}

/** The plugin with the kernel's outbound send, or its config write, replaced: the answers a fake server cannot make. */
const withKernel = (
  change: (kernel: Record<string, unknown>) => Record<string, unknown>,
): DaemonImplementation<Manifest> =>
  ({
    ...search,
    build: (given: Parameters<NonNullable<typeof search.build>>[0]) =>
      search.build?.({
        ...given,
        kernel: change(given.kernel as unknown as Record<string, unknown>),
      } as unknown as typeof given),
  }) as unknown as DaemonImplementation<Manifest>;

const sending = (outcome: OutboundSecretOutcome) =>
  withKernel(kernel => ({
    ...kernel,
    secrets: { ...(kernel.secrets as object), send: async () => outcome },
  }));

const entryOf = (id: SearchProviderId) => ({ provider: id, key: searchKeyReference(id) });
/** A `search.yaml` that lists these providers, in this order. */
const listed = (ids: readonly SearchProviderId[], extra: Record<string, unknown> = {}) => ({
  providers: ids.map(entryOf),
  ...extra,
});
const named = (id: SearchProviderId, extra: Record<string, unknown> = {}) => listed([id], extra);
const failedOn = (...parts: string[]) =>
  `Web search failed on every provider tried: ${parts.join('; ')}. The owner can check them in Settings › Web search.`;
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

  test('a file that lists no provider is still off, whatever the Vault holds', async () => {
    const { host, seen } = await hostFor({ providers: [], dailyCap: 5 }, { vault: stored('serper') });
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
    expect(view).toMatchObject({ providers: [{ provider: 'brave' }], usedToday: 0, dailyCap: 1 });
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
    const cases: readonly [number, string][] = [
      [401, 'the key was refused'],
      [403, 'the key was refused'],
      [429, 'rate limited or busy'],
      [500, 'returned an error'],
    ];
    for (const [status, reason] of cases) {
      const { host } = await hostFor(named('exa'), {
        vault: stored('exa'),
        answer: () => new Response(`secret details ${KEY}`, { status }),
      });
      const result = await host.tool('web_search', { query: 'q' }, asFerret);
      expect(result).toMatchObject({ isError: true, text: failedOn(`Exa (${reason})`) });
      expect(result.text).not.toContain(KEY);
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
    expect((await down.host.tool('web_search', { query: 'q' }, asFerret)).text).toBe(
      failedOn('Exa (could not be reached)'),
    );
    await down.host.stop();

    const odd = await hostFor(named('exa'), { vault: stored('exa'), answer: () => new Response('<html>hi</html>') });
    expect((await odd.host.tool('web_search', { query: 'q' }, asFerret)).text).toBe(
      failedOn('Exa (sent a reply that could not be read)'),
    );
    await odd.host.stop();
  });
});

describe('every answer the kernel can give a send', () => {
  const cases: readonly [OutboundSecretOutcome, string][] = [
    [{ kind: 'timeout' }, 'did not answer in time'],
    [{ kind: 'too_large' }, 'sent a reply that could not be read'],
    [{ kind: 'unreadable' }, 'sent a reply that could not be read'],
    [{ kind: 'vault_damaged' }, 'the secret store could not be read'],
    [{ kind: 'completion', status: 200, payload: 'not an object' }, 'sent a reply that could not be read'],
  ];
  for (const [outcome, reason] of cases)
    test(`${outcome.kind} reads as "${reason}", in one fixed sentence naming the provider`, async () => {
      const { host } = await hostFor(named('serper'), { vault: stored('serper'), plugin: sending(outcome) });
      expect(await host.tool('web_search', { query: 'q' }, asFerret)).toMatchObject({
        isError: true,
        text: failedOn(`Serper (${reason})`),
      });
      await host.stop();
    });

  test('a send the kernel refused before anything left gives its call back to the day', async () => {
    const { host } = await hostFor(named('serper'), {
      vault: stored('serper'),
      plugin: sending({ kind: 'vault_damaged' }),
    });
    await host.tool('web_search', { query: 'q' }, asFerret);
    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.usedToday).toBe(0);
    await host.stop();
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

describe('a damaged daily counter', () => {
  test('pauses web search with a sentence, sends nothing, and never reads as zero', async () => {
    const { host, seen } = await hostFor(named('serper'), { vault: stored('serper') });
    host.state('search').plant(SEARCH_LEDGER_STATE, 'this is not json');

    const result = await host.tool('web_search', { query: 'q' }, asFerret);

    expect(result).toMatchObject({ isError: true, text: 'Web search is paused: its daily counter could not be read.' });
    expect(seen).toEqual([]);
    await host.stop();
  });
});

describe('Settings › Web search, when the counter or the file is not in order', () => {
  test('a Test over a damaged counter says the provider failed, never that the key works', async () => {
    const { host, seen } = await hostFor(named('serper'), { vault: stored('serper') });
    host.state('search').plant(SEARCH_LEDGER_STATE, 'this is not json');
    const response = await host.request('POST', '/v1/web-search/test', { as: owner(), body: { provider: 'serper' } });
    expect(response.json()).toMatchObject({ ok: false, code: 'provider_error' });
    expect(seen).toEqual([]);
    await host.stop();
  });

  test('a file that changed while it was being written is a 409 that says to read it again', async () => {
    const plugin = withKernel(kernel => ({
      ...kernel,
      config: { ...(kernel.config as object), writeAsCaller: async () => ({ kind: 'conflict' }) },
    }));
    const { host } = await hostFor(undefined, { plugin });
    const response = await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { dailyCap: 5 } });
    expect(response.status).toBe(409);
    await host.stop();
  });
});

describe('Settings › Web search routes', () => {
  test('a ferret may use the tool but may not set up or test: those are a person’s act', async () => {
    const { host, seen } = await hostFor(named('serper'), { vault: stored('serper') });
    expect(
      (await host.request('PUT', '/v1/web-search/setup', { ...asFerret, body: { provider: 'brave' } })).status,
    ).toBe(403);
    expect(
      (await host.request('POST', '/v1/web-search/test', { ...asFerret, body: { provider: 'serper' } })).status,
    ).toBe(403);
    expect(seen).toEqual([]);
    await host.stop();
  });

  test('the owner lists a provider; its key is then in use', async () => {
    const { host } = await hostFor(undefined, { vault: stored('brave'), real: realConfig(true) });
    const before = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(before).toMatchObject({ providers: [], usedToday: 0 });

    const done = await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { providers: ['brave'] } });
    expect(done.status).toBe(200);
    expect(done.json()).toEqual({ outcome: 'applied', held: [] });

    const after = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(after.providers).toEqual([{ provider: 'brave' }]);
    // The test host's own secret rule reads ITS config, not the stand-in writer's: hand it the file the writer made.
    host.setConfig('search.yaml', named('brave'));
    expect((await host.tool('web_search', { query: 'q' }, asFerret)).isError).toBeUndefined();
    await host.stop();
  });

  test('a setup nobody may confirm is held, says so, and leaves search off', async () => {
    const { host, seen } = await hostFor(undefined, { vault: stored('brave'), real: realConfig(false) });

    const done = await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { providers: ['brave'] } });

    expect(done.status).toBe(200);
    expect(done.json()).toMatchObject({ outcome: 'held', held: [expect.stringContaining('BRAVE_API_KEY')] });
    expect(done.body).not.toContain('${secret:');
    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.providers).toEqual([]);
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

  test('a setup the file’s own rules refuse is a 400 that says why', async () => {
    const { host } = await hostFor(undefined, { real: realConfig(true) });
    const response = await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { dailyCap: 20_000 } });
    expect(response.status).toBe(400);
    expect(response.json()).toMatchObject({ code: 'search_setup_refused' });
    await host.stop();
  });

  test('a setup that is not a list of distinct providers or a cap is a 400', async () => {
    const { host } = await hostFor(undefined);
    for (const body of [{ providers: ['bing'] }, { providers: ['brave', 'brave'] }, { provider: 'brave' }])
      expect((await host.request('PUT', '/v1/web-search/setup', { as: owner(), body })).status).toBe(400);
    expect((await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: 'not json' })).status).toBe(400);
    await host.stop();
  });

  test('Test is one real search, counted, remembered, and says what it proved', async () => {
    const { host, seen } = await hostFor(named('tavily', { dailyCap: 1 }), { vault: stored('tavily') });
    const response = await host.request('POST', '/v1/web-search/test', { as: owner(), body: { provider: 'tavily' } });
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ provider: 'tavily', ok: true, code: 'ok', message: SEARCH_MESSAGES.ok });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ max_results: 1 });

    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.usedToday).toBe(1);
    expect(view.providers).toMatchObject([{ provider: 'tavily', lastTest: { provider: 'tavily', ok: true } }]);
    // the owner's own act is never refused for the cap, even when the day is used up
    expect(
      (await host.request('POST', '/v1/web-search/test', { as: owner(), body: { provider: 'tavily' } })).status,
    ).toBe(200);
    await host.stop();
  });

  test('a Test of a key the provider refuses says rejected', async () => {
    const { host } = await hostFor(named('tavily'), {
      vault: stored('tavily'),
      answer: () => new Response('', { status: 401 }),
    });
    const result = (
      await host.request('POST', '/v1/web-search/test', { as: owner(), body: { provider: 'tavily' } })
    ).json();
    expect(result).toMatchObject({ ok: false, code: 'rejected' });
    await host.stop();
  });

  test('a Test of a provider that is not listed is a 409 that says what to do, and a Test with no provider is a 400', async () => {
    const { host, seen } = await hostFor(named('serper'), { vault: stored('serper') });
    const response = await host.request('POST', '/v1/web-search/test', { as: owner(), body: { provider: 'brave' } });
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'not_set' });
    expect((await host.request('POST', '/v1/web-search/test', { as: owner(), body: {} })).status).toBe(400);
    expect(seen).toEqual([]);
    await host.stop();
  });

  test('Test tries ONE provider and never falls through: a failing one reports its own failure', async () => {
    const { host, seen } = await hostFor(listed(['serper', 'brave']), {
      vault: { ...stored('serper'), ...stored('brave') },
      answer: seenAt =>
        seenAt.url.host === SEARCH_PROVIDERS.serper.host
          ? new Response('', { status: 503 })
          : Response.json(REPLIES.brave),
    });
    const result = (
      await host.request('POST', '/v1/web-search/test', { as: owner(), body: { provider: 'serper' } })
    ).json();
    expect(result).toMatchObject({ provider: 'serper', ok: false, code: 'provider_error' });
    expect(seen.map(one => one.url.host)).toEqual([SEARCH_PROVIDERS.serper.host]);
    await host.stop();
  });
});

/** Serper answers 503, Brave answers properly: the shape most of the fall-through proofs use. */
const serperDown: Answer = seen =>
  seen.url.host === SEARCH_PROVIDERS.serper.host
    ? new Response('overloaded', { status: 503 })
    : Response.json(REPLIES.brave);
const bothKeys = { ...stored('serper'), ...stored('brave') };

describe('providers are tried in order and fall through on a failure', () => {
  test('the first provider answers 503, so the second answers, and the reply says which', async () => {
    const { host, seen } = await hostFor(listed(['serper', 'brave']), { vault: bothKeys, answer: serperDown });

    const result = await host.tool('web_search', { query: 'zig comptime' }, asFerret);

    expect(result.isError).toBeUndefined();
    expect(seen.map(one => one.url.host)).toEqual([SEARCH_PROVIDERS.serper.host, SEARCH_PROVIDERS.brave.host]);
    expect(result.text).toContain('Web search results from Brave');
    expect(result.text).toContain('Serper did not answer');
    expect(result.text).toContain('https://found.test/brave');
    expect(result.data).toMatchObject({ provider: 'brave', skipped: [{ provider: 'serper', code: 'provider_error' }] });
    expect(JSON.stringify(result)).not.toContain(KEY);
    await host.stop();
  });

  test('the first provider answering is the only one asked: no fall-through, no second call', async () => {
    const { host, seen } = await hostFor(listed(['serper', 'brave']), { vault: bothKeys });
    const result = await host.tool('web_search', { query: 'q' }, asFerret);
    expect(result.data).toMatchObject({ provider: 'serper' });
    expect(result.data).not.toHaveProperty('skipped');
    expect(seen).toHaveLength(1);
    await host.stop();
  });

  test('each failure the brief names falls through: network, 5xx, 401, 403, 429 and an unreadable reply', async () => {
    const failures: readonly [string, Answer][] = [
      [
        'network',
        seen => {
          if (seen.url.host === SEARCH_PROVIDERS.serper.host) throw new Error('connect ECONNREFUSED');
          return Response.json(REPLIES.brave);
        },
      ],
      [
        '500',
        seen =>
          seen.url.host === SEARCH_PROVIDERS.serper.host
            ? new Response('', { status: 500 })
            : Response.json(REPLIES.brave),
      ],
      [
        '401',
        seen =>
          seen.url.host === SEARCH_PROVIDERS.serper.host
            ? new Response('', { status: 401 })
            : Response.json(REPLIES.brave),
      ],
      [
        '403',
        seen =>
          seen.url.host === SEARCH_PROVIDERS.serper.host
            ? new Response('', { status: 403 })
            : Response.json(REPLIES.brave),
      ],
      [
        '429',
        seen =>
          seen.url.host === SEARCH_PROVIDERS.serper.host
            ? new Response('', { status: 429 })
            : Response.json(REPLIES.brave),
      ],
      [
        'unreadable',
        seen =>
          seen.url.host === SEARCH_PROVIDERS.serper.host
            ? new Response('<html>no</html>')
            : Response.json(REPLIES.brave),
      ],
    ];
    for (const [label, answer] of failures) {
      const { host, seen } = await hostFor(listed(['serper', 'brave']), { vault: bothKeys, answer });
      const result = await host.tool('web_search', { query: 'q' }, asFerret);
      expect({
        label,
        isError: result.isError,
        provider: (result.data as { provider?: string } | undefined)?.provider,
      }).toEqual({
        label,
        isError: undefined,
        provider: 'brave',
      });
      expect(seen).toHaveLength(2);
      await host.stop();
    }
  });

  test('a listed provider with no key stored is skipped for free, and the next answers', async () => {
    const { host, seen } = await hostFor(listed(['serper', 'brave']), { vault: stored('brave') });
    const result = await host.tool('web_search', { query: 'q' }, asFerret);
    expect(result.data).toMatchObject({ provider: 'brave', skipped: [{ provider: 'serper', code: 'not_set' }] });
    expect(seen.map(one => one.url.host)).toEqual([SEARCH_PROVIDERS.brave.host]);
    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.usedToday).toBe(1);
    await host.stop();
  });

  test('a valid EMPTY answer is an answer: it does not fall through', async () => {
    const { host, seen } = await hostFor(listed(['serper', 'brave']), {
      vault: bothKeys,
      answer: one =>
        one.url.host === SEARCH_PROVIDERS.serper.host ? Response.json({ organic: [] }) : Response.json(REPLIES.brave),
    });
    const result = await host.tool('web_search', { query: 'nothing matches this' }, asFerret);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('Web search results from Serper');
    expect(result.text).toContain('No results.');
    expect(seen).toHaveLength(1);
    await host.stop();
  });

  test('every provider failing is ONE plain error that names each, in the order tried, with no body', async () => {
    const { host, seen } = await hostFor(listed(['serper', 'brave', 'exa']), {
      vault: { ...bothKeys, ...stored('exa') },
      answer: one => {
        if (one.url.host === SEARCH_PROVIDERS.serper.host) return new Response(`body ${KEY}`, { status: 503 });
        if (one.url.host === SEARCH_PROVIDERS.brave.host) return new Response('', { status: 401 });
        return new Response('', { status: 429 });
      },
    });
    const result = await host.tool('web_search', { query: 'q' }, asFerret);
    expect(result).toEqual({
      isError: true,
      text: failedOn('Serper (returned an error)', 'Brave Search (the key was refused)', 'Exa (rate limited or busy)'),
    });
    expect(seen).toHaveLength(3);
    expect(result.text).not.toContain(KEY);
    await host.stop();
  });

  test('an order the owner sets is the order tried, and a new order is a different order', async () => {
    const { host, seen } = await hostFor(listed(['brave', 'serper']), { vault: bothKeys, answer: serperDown });
    const result = await host.tool('web_search', { query: 'q' }, asFerret);
    expect(result.data).toMatchObject({ provider: 'brave' });
    expect(seen.map(one => one.url.host)).toEqual([SEARCH_PROVIDERS.brave.host]);
    await host.stop();
  });
});

describe('the one daily cap counts every attempt, a fall-through included', () => {
  test('a search that fell through used two calls of the day', async () => {
    const { host } = await hostFor(listed(['serper', 'brave']), { vault: bothKeys, answer: serperDown });
    await host.tool('web_search', { query: 'q' }, asFerret);
    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.usedToday).toBe(2);
    await host.stop();
  });

  test('the cap stops a fall-through half way: the second provider is never asked and the sentence says why', async () => {
    const { host, seen } = await hostFor(listed(['serper', 'brave'], { dailyCap: 1 }), {
      vault: bothKeys,
      answer: serperDown,
    });

    const result = await host.tool('web_search', { query: 'q' }, asFerret);

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Serper (returned an error)');
    expect(result.text).toContain('The daily limit (1 a day) was then used up');
    expect(seen.map(one => one.url.host)).toEqual([SEARCH_PROVIDERS.serper.host]);
    const next = await host.tool('web_search', { query: 'again' }, asFerret);
    expect(next.text).toContain('1 a day');
    expect(next.text).toContain('Settings › Web search');
    expect(seen).toHaveLength(1);
    await host.stop();
  });

  test('with room for exactly two calls, one fall-through search fits and the next is refused', async () => {
    const { host, seen } = await hostFor(listed(['serper', 'brave'], { dailyCap: 2 }), {
      vault: bothKeys,
      answer: serperDown,
    });
    expect((await host.tool('web_search', { query: 'one' }, asFerret)).isError).toBeUndefined();
    expect((await host.tool('web_search', { query: 'two' }, asFerret)).isError).toBe(true);
    expect(seen).toHaveLength(2);
    await host.stop();
  });
});

describe('the order persists, and listing a provider is not a loosening', () => {
  test('the owner’s list and its order are what the next read returns, and what search tries', async () => {
    const { host } = await hostFor(undefined, { vault: bothKeys, real: realConfig(true) });
    const put = async (providers: string[]) =>
      await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { providers } });
    const read = async () =>
      SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json()).providers.map(
        entry => entry.provider,
      );

    expect((await put(['brave', 'serper', 'exa'])).json()).toEqual({ outcome: 'applied', held: [] });
    expect(await read()).toEqual(['brave', 'serper', 'exa']);
    await put(['exa', 'brave', 'serper']);
    expect(await read()).toEqual(['exa', 'brave', 'serper']);
    await put(['brave']);
    expect(await read()).toEqual(['brave']);
    await host.stop();
  });

  test('for a caller who cannot confirm, adding a key reference is held as today; reordering and removing are not', async () => {
    let confirms = true;
    const { host } = await hostFor(undefined, { real: realConfig(() => confirms) });
    const put = async (providers: string[]) =>
      await host.request('PUT', '/v1/web-search/setup', { as: owner(), body: { providers } });
    expect((await put(['serper', 'brave'])).json()).toEqual({ outcome: 'applied', held: [] });

    confirms = false;
    expect((await put(['brave', 'serper'])).json()).toEqual({ outcome: 'applied', held: [] });
    expect((await put(['brave'])).json()).toEqual({ outcome: 'applied', held: [] });
    const add = await put(['brave', 'exa']);
    expect(add.json()).toMatchObject({ outcome: 'held', held: [expect.stringContaining('EXA_API_KEY')] });
    expect(add.body).not.toContain('${secret:');
    const view = SearchViewSchema.parse((await host.request('GET', '/v1/web-search', { as: owner() })).json());
    expect(view.providers.map(entry => entry.provider)).toEqual(['brave']);
    await host.stop();
  });

  test('a ferret may not set the list: it is a person’s act', async () => {
    const { host } = await hostFor(undefined);
    expect(
      (await host.request('PUT', '/v1/web-search/setup', { ...asFerret, body: { providers: ['brave'] } })).status,
    ).toBe(403);
    await host.stop();
  });
});
