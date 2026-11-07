import { describe, it } from 'bun:test';
import should from 'should';
import {
  DaemonRuntimeModelCatalogStore,
  fetchRuntimeModelCatalog,
  parseRuntimeModelCatalog,
  RUNTIME_MODELS_ROUTE,
  type RuntimeModelCatalog,
  requireRuntimeModelCatalogHarness,
  runtimeModelCatalogErrorMessage,
} from '../../../app/lib/runtime-models.ts';
import { type Call, scripted } from './support/client.ts';

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

/** An answer that settles only when the test resolves it, modelling a slow daemon. */
const deferred = (): { resolve: (value: unknown) => void; answer: Promise<unknown> } => {
  let resolve!: (value: unknown) => void;
  const answer = new Promise<unknown>(res => {
    resolve = res;
  });
  return { resolve, answer };
};

describe('runtime model catalog parsing', () => {
  it('should preserve opaque ordered model data and optional values', () => {
    should(parseRuntimeModelCatalog(catalog('GPT-5.6 Sol'))).deepEqual(catalog('GPT-5.6 Sol'));
    should(parseRuntimeModelCatalog({ harness: 'claude-code', source: 'wrapper-inventory', choices: [] })).deepEqual({
      harness: 'claude-code',
      source: 'wrapper-inventory',
      choices: [],
    });
  });

  it('should keep what the daemon says about fast mode, and nothing it did not say', () => {
    // Arrange
    const row = (extra: Record<string, unknown>) => ({ value: 'm', label: 'M', reasoningEfforts: [], ...extra });
    const raw = {
      harness: 'codex',
      source: 'codex-app-server',
      choices: [
        row({ fast: true, fastDefault: true }),
        row({ fast: false }),
        row({ fast: 'yes', fastDefault: false }),
        row({}),
      ],
    };

    // Act
    const parsed = parseRuntimeModelCatalog(raw).choices;

    // Assert
    should(parsed[0]).containEql({ fast: true, fastDefault: true });
    should(parsed[1]).containEql({ fast: false });
    should(parsed[1]).not.have.property('fastDefault');
    should(parsed[2]).not.have.property('fast');
    should(parsed[2]).not.have.property('fastDefault');
    should(parsed[3]).not.have.property('fast');
  });

  it("should keep a choice's catalog tier and context window, and the login's catalog", () => {
    // Arrange
    const raw = {
      harness: 'claude-code',
      source: 'wrapper-inventory',
      catalog: { id: 'zai', label: 'GLM / Z.ai', customIds: true },
      choices: [
        { value: 'glm-5.3', label: 'GLM-5.3', tier: 'best', context: 1_000_000, reasoningEfforts: [] },
        { value: 'odd', label: 'Odd', tier: 'ultra', context: -1, reasoningEfforts: [] },
      ],
    };

    // Act
    const parsed = parseRuntimeModelCatalog(raw);

    // Assert — an unknown tier or a nonsense window is dropped, never trusted
    should(parsed.catalog).deepEqual({ id: 'zai', label: 'GLM / Z.ai', customIds: true });
    should(parsed.choices[0]).match({ tier: 'best', context: 1_000_000 });
    should(parsed.choices[1]).not.have.properties(['tier', 'context']);
    should(parseRuntimeModelCatalog({ ...raw, catalog: { id: 'x' } }).catalog).be.undefined();
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
    should(() => requireRuntimeModelCatalogHarness(catalog('Codex'), 'claude-code')).throw(
      /codex model catalog for a claude-code session/u,
    );
    should(requireRuntimeModelCatalogHarness(catalog('Codex'), 'codex')).deepEqual(catalog('Codex'));
  });

  it('should say what went wrong, whatever was thrown', () => {
    should(runtimeModelCatalogErrorMessage(new Error('other'))).equal('other');
    should(runtimeModelCatalogErrorMessage('other')).equal('other');
  });
});

describe('daemon-scoped runtime model catalog queries', () => {
  it('should ask the bound daemon for the session through the route key and the session parameter', async () => {
    const calls: Call[] = [];
    const client = scripted({ [RUNTIME_MODELS_ROUTE]: catalog('A') }, calls);
    const result = await fetchRuntimeModelCatalog(client, 'same/session');

    should(result.choices[0]?.label).equal('A');
    should(calls).have.length(1);
    should(calls[0]?.route).equal('GET /v1/ferrets/:sessionId/runtime-models');
    should(calls[0]?.params).deepEqual({ sessionId: 'same/session' });
  });

  it('should expose daemon failures and refuse an answer that is not a catalog', async () => {
    const unavailable = fetchRuntimeModelCatalog(
      scripted({ [RUNTIME_MODELS_ROUTE]: new Error('catalog timed out') }),
      's-1',
    );
    await should(unavailable).be.rejectedWith('catalog timed out');

    const notACatalog = fetchRuntimeModelCatalog(scripted({ [RUNTIME_MODELS_ROUTE]: 'no' }), 's-1');
    await should(notACatalog).be.rejectedWith(/invalid runtime model catalog/u);
  });

  it('should cache and coalesce only an identical session query on one daemon', async () => {
    const store = new DaemonRuntimeModelCatalogStore();
    const callsA: Call[] = [];
    const clientA = scripted({ [RUNTIME_MODELS_ROUTE]: catalog('A') }, callsA);
    const storeB = new DaemonRuntimeModelCatalogStore();
    const callsB: Call[] = [];
    const clientB = scripted({ [RUNTIME_MODELS_ROUTE]: catalog('B') }, callsB);

    const [first, sameRequest, otherDaemon] = await Promise.all([
      store.load(clientA, 'same-session'),
      store.load(clientA, 'same-session'),
      storeB.load(clientB, 'same-session'),
    ]);
    should(first).equal(sameRequest);
    should(first.choices[0]?.label).equal('A');
    should(otherDaemon.choices[0]?.label).equal('B');
    should(callsA.length + callsB.length).equal(2);
    should(store.get('same-session')).equal(first);
    should(storeB.get('same-session')).equal(otherDaemon);
    should(await store.load(clientA, 'same-session')).equal(first);
    should(callsA).have.length(1);

    store.clear();
    should(store.get('same-session')).equal(undefined);
    should(storeB.get('same-session')).equal(otherDaemon);
  });
});

describe('daemon runtime model catalog fencing', () => {
  it('should not publish a result that completes after its daemon is cleared', async () => {
    const store = new DaemonRuntimeModelCatalogStore();
    const slow = deferred();
    const loadPromise = store.load(scripted({ [RUNTIME_MODELS_ROUTE]: () => slow.answer }), 's-1');
    should(store.get('s-1')).equal(undefined);

    store.clear();
    slow.resolve(catalog('stale'));
    const result = await loadPromise;

    // The original caller still receives its own result, but the late completion
    // must not repopulate the shared cache after the clear.
    should(result.choices[0]?.label).equal('stale');
    should(store.get('s-1')).equal(undefined);
  });

  it('should treat a new client for the same daemon as a new generation and never publish or coalesce the prior result', async () => {
    const store = new DaemonRuntimeModelCatalogStore();
    const oldToken = deferred();
    let requests = 0;
    const oldClient = scripted({
      [RUNTIME_MODELS_ROUTE]: () => {
        requests += 1;
        return oldToken.answer;
      },
    });
    const oldLoad = store.load(oldClient, 's-1');

    // The shell hands a new client when the pairing rotated: a re-pair, not a reuse.
    const rePaired = scripted({
      [RUNTIME_MODELS_ROUTE]: () => {
        requests += 1;
        return catalog('fresh');
      },
    });
    const fresh = await store.load(rePaired, 's-1');
    should(fresh.choices[0]?.label).equal('fresh');
    // The re-pair issued its own request instead of coalescing onto the old connection.
    should(requests).equal(2);

    oldToken.resolve(catalog('old-token'));
    await oldLoad;
    should(store.get('s-1')?.choices[0]?.label).equal('fresh');
  });
});
