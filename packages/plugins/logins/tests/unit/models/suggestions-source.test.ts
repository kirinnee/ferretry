import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'bun:test';
import should from 'should';
import { builtInModelCatalogs } from '../../../daemon/lib/catalog/catalog.ts';
import { publishedModelCatalogFiles } from '../../../daemon/lib/catalog/published.ts';
import {
  LITELLM_URL,
  MODELS_DEV_URL,
  readSuggestions,
  SUGGESTION_PROVIDERS,
  type Suggestions,
  stableJson,
} from '../../../daemon/lib/catalog/suggestions.ts';
import {
  buildPublishedFiles,
  buildSuggestions,
  GZIP_BUDGET_BYTES,
  MAX_DOWNLOAD_BYTES,
  readJsonCapped,
  SUGGESTIONS_SNAPSHOT_FILE,
  type SuggestionsDeps,
} from '../../../scripts/suggestions-source.ts';

const model = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  family: 'dropped',
  reasoning: true,
  limit: { context: 1000, output: 100 },
  cost: { input: 1, output: 2, context_over_200k: { input: 9 } },
  release_date: '2026-01-01',
  ...extra,
});

/** A models.dev document with every kept provider holding `models` models, plus one we do not keep. */
const modelsDev = (models = 4) => ({
  ...Object.fromEntries(
    SUGGESTION_PROVIDERS.map(id => [
      id,
      {
        id,
        name: id,
        env: ['KEY'],
        models: Object.fromEntries(
          Array.from({ length: models }, (_, index) => [`${id}-m${index}`, model(`M${index}`)]),
        ),
      },
    ]),
  ),
  'some-gateway': { name: 'gw', models: { x: model('X') } },
});

const LITELLM = {
  [`${SUGGESTION_PROVIDERS[0]}-m0`]: { deprecation_date: '2027-02-02' },
  'other/x': { deprecation_date: '2027-03-03' },
};

function deps(world: { modelsDev?: unknown; litellm?: unknown; snapshot?: unknown; down?: readonly string[] }): {
  deps: SuggestionsDeps;
  log: string[];
  asked: string[];
} {
  const log: string[] = [];
  const asked: string[] = [];
  return {
    log,
    asked,
    deps: {
      getJson: async url => {
        asked.push(url);
        if (world.down?.includes(url)) throw new Error(`${url} answered 503`);
        return url === MODELS_DEV_URL ? world.modelsDev : world.litellm;
      },
      readSnapshot: async () => {
        if (world.snapshot === undefined) throw new Error('ENOENT');
        return world.snapshot;
      },
      today: () => '2026-11-23',
      log: line => log.push(line),
    },
  };
}

describe('the build reads models.dev and LiteLLM from two fixed URLs, and only it does', () => {
  it('should pin the trimming: kept providers, kept fields, sorted, LiteLLM dates added, the sources named', async () => {
    // Arrange
    const first = SUGGESTION_PROVIDERS[0];
    const world = deps({ modelsDev: modelsDev(2), litellm: LITELLM });

    // Act
    const suggestions = await buildSuggestions(world.deps);

    // Assert
    should(world.asked).eql([MODELS_DEV_URL, LITELLM_URL]);
    should(MODELS_DEV_URL).equal('https://models.dev/api.json');
    should(Object.keys(suggestions.providers).sort()).eql([...SUGGESTION_PROVIDERS].sort());
    should(suggestions.providers['some-gateway' as never]).be.undefined();
    should(suggestions.generated).equal('2026-11-23');
    should(suggestions.sources).eql({ modelsDev: MODELS_DEV_URL, litellm: LITELLM_URL });
    should(suggestions.providers[first]?.models[`${first}-m0`]).eql({
      name: 'M0',
      reasoning: true,
      limit: { context: 1000, output: 100 },
      cost: { input: 1, output: 2 },
      release_date: '2026-01-01',
      retires: '2027-02-02',
    });
    should(suggestions.providers[first]?.models[`${first}-m1`]?.retires).be.undefined();
    should(world.log).eql([]);
  });

  it('should publish the models.dev rows without dates, and say so, when only LiteLLM is down', async () => {
    // Arrange
    const world = deps({ modelsDev: modelsDev(2), down: [LITELLM_URL] });

    // Act
    const suggestions = await buildSuggestions(world.deps);

    // Assert
    should(suggestions.sources).eql({ modelsDev: MODELS_DEV_URL });
    should(world.log.join('\n')).match(/::warning::LiteLLM could not be read/u);
  });

  it('should publish the committed snapshot with a warning, never an empty list, when models.dev is down', async () => {
    // Arrange
    const snapshot = await buildSuggestions(deps({ modelsDev: modelsDev(4), litellm: {} }).deps);
    const world = deps({ snapshot, down: [MODELS_DEV_URL] });

    // Act
    const built = await buildSuggestions(world.deps);

    // Assert
    should(built).eql(snapshot);
    should(world.log.join('\n')).match(/::warning::models\.dev could not be read.*snapshot of 2026-11-23/u);
  });

  it('should not believe a models.dev that lost a provider or half of its models, and use the snapshot instead', async () => {
    // Arrange
    const snapshot = await buildSuggestions(deps({ modelsDev: modelsDev(4), litellm: {} }).deps);
    const sparse = modelsDev(4) as Record<string, { models: Record<string, unknown> }>;
    sparse.xai = { ...sparse.xai!, models: { only: model('Only') } };
    const empty = {};

    // Act
    const fromSparse = deps({ snapshot, modelsDev: sparse, litellm: {} });
    const fromEmpty = deps({ snapshot, modelsDev: empty, litellm: {} });

    // Assert
    should(await buildSuggestions(fromSparse.deps)).eql(snapshot);
    should(fromSparse.log.join('\n')).match(/xai has 1 models, the snapshot 4/u);
    should(await buildSuggestions(fromEmpty.deps)).eql(snapshot);
    should(fromEmpty.log.join('\n')).match(/::warning::/u);
  });

  it('should fail the build loudly when models.dev is unusable and there is no valid snapshot', async () => {
    // Act
    const down = buildSuggestions(deps({ down: [MODELS_DEV_URL] }).deps);
    const garbage = buildSuggestions(deps({ modelsDev: 'not a map', snapshot: { providers: {} } }).deps);

    // Assert
    await should(down).rejectedWith(/no valid committed snapshot/u);
    await should(garbage).rejectedWith(/no suggestions to publish/u);
  });

  it('should drop a hostile row, name it in the log, and publish the rest', async () => {
    // Arrange
    const raw = modelsDev(2) as Record<string, { models: Record<string, unknown> }>;
    raw.xai!.models['xai-evil'] = model('x'.repeat(5000));
    const world = deps({ modelsDev: raw, litellm: {} });

    // Act
    const suggestions = await buildSuggestions(world.deps);

    // Assert
    should(suggestions.providers.xai?.models['xai-evil']).be.undefined();
    should(world.log.join('\n')).match(/models\.dev: dropped xai\/xai-evil/u);
  });
});

describe('the build never believes an unbounded or empty source', () => {
  const bodyOf = (chunks: readonly string[], headers: Record<string, string> = {}): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { headers },
    );

  it('should parse a download under the byte cap', async () => {
    // Act
    const value = await readJsonCapped('https://x.test/a', bodyOf(['{"a":', '1}']), 100);

    // Assert
    should(value).eql({ a: 1 });
  });

  it('should refuse a download whose declared length is over the cap, before reading it', async () => {
    // Arrange
    const response = bodyOf(['{}'], { 'content-length': '5000' });

    // Act
    const read = readJsonCapped('https://x.test/a', response, 1000);

    // Assert
    await should(read).rejectedWith(/declares 5000 bytes, over the 1000 byte cap/u);
  });

  it('should stop a body that outgrows the cap while streaming, whatever it declared', async () => {
    // Arrange
    const response = bodyOf(['[', '"x"'.repeat(200), ']']);

    // Act
    const read = readJsonCapped('https://x.test/a', response, 100);

    // Assert
    await should(read).rejectedWith(/is over the 100 byte cap/u);
  });

  it('should hold the real cap at 8 MiB', () => {
    should(MAX_DOWNLOAD_BYTES).equal(8 * 1024 * 1024);
  });

  it('should publish the committed snapshot, with a warning naming the cap, when models.dev is oversized', async () => {
    // Arrange
    const snapshot = await buildSuggestions(deps({ modelsDev: modelsDev(4), litellm: {} }).deps);
    const world = deps({ snapshot });
    const oversized: SuggestionsDeps = {
      ...world.deps,
      getJson: url =>
        url === MODELS_DEV_URL ? readJsonCapped(url, bodyOf([`[${'"x",'.repeat(100)}"x"]`]), 50) : Promise.resolve({}),
    };

    // Act
    const built = await buildSuggestions(oversized);

    // Assert
    should(built).eql(snapshot);
    should(world.log.join('\n')).match(/::warning::models\.dev could not be read.*byte cap.*snapshot of 2026-11-23/u);
  });

  it('should fail the build, offline, when the committed snapshot holds a provider with no models', async () => {
    // Arrange
    const whole = await buildSuggestions(deps({ modelsDev: modelsDev(4), litellm: {} }).deps);
    const emptied = { ...whole, providers: { ...whole.providers, xai: { ...whole.providers.xai!, models: {} } } };
    const onlyEmpty = { ...whole, providers: { xai: { name: 'xai', models: {} } } };

    // Act
    const withEmptyProvider = buildSuggestions(deps({ snapshot: emptied, down: [MODELS_DEV_URL] }).deps);
    const withOnlyEmpty = buildSuggestions(deps({ snapshot: onlyEmpty, down: [MODELS_DEV_URL] }).deps);

    // Assert
    await should(withEmptyProvider).rejectedWith(/no valid committed snapshot/u);
    await should(withOnlyEmpty).rejectedWith(/no valid committed snapshot/u);
  });

  it('should name the rows past the per-provider cap, and the LiteLLM dates that are not days', async () => {
    // Arrange
    const raw = modelsDev(2) as Record<string, { models: Record<string, unknown> }>;
    for (let index = 0; index < 1005; index += 1) raw.xai!.models[`bulk-${index}`] = model(`B${index}`);
    const litellm = { 'xai/xai-m0': { deprecation_date: 'next spring' }, 'xai/xai-m1': { deprecation_date: null } };
    const world = deps({ modelsDev: raw, litellm });

    // Act
    const built = await buildSuggestions(world.deps);

    // Assert
    should(Object.keys(built.providers.xai?.models ?? {})).have.length(1000);
    const log = world.log.join('\n');
    should(log).match(/models\.dev: dropped xai\/bulk-999: beyond the 1000 models kept per provider/u);
    should(log).match(/models\.dev: dropped xai\/bulk-1004: beyond the 1000 models/u);
    should(log).match(/LiteLLM: dropped litellm\/xai\/xai-m0: the date is not a day: "next spring"/u);
    should(log).not.match(/xai-m1/u);
  });
});

describe('the final models.json is held to the gzip budget before anything is written', () => {
  const gzipped = (suggestions: Suggestions): number =>
    gzipSync(publishedModelCatalogFiles(1, builtInModelCatalogs(), suggestions)['catalog/models.json'] as string)
      .length;

  it('should publish the committed snapshot, with a warning, when the live build is over budget', async () => {
    // Arrange
    const snapshot = await buildSuggestions(deps({ modelsDev: modelsDev(4), litellm: {} }).deps);
    const live = await buildSuggestions(deps({ modelsDev: modelsDev(40), litellm: {} }).deps);
    const budget = gzipped(snapshot);
    should(gzipped(live)).be.above(budget);
    const world = deps({ snapshot, modelsDev: modelsDev(40), litellm: {} });

    // Act
    const files = await buildPublishedFiles(1, builtInModelCatalogs(), world.deps, budget);

    // Assert
    should(JSON.parse(files['catalog/models.json'] as string).suggestions).eql(snapshot);
    should(world.log.join('\n')).match(
      /::warning::the published models\.json would be \d+ bytes gzipped, over the \d+ budget/u,
    );
  });

  it('should fail the build when the live build and the committed snapshot are both over budget', async () => {
    // Arrange
    const snapshot = await buildSuggestions(deps({ modelsDev: modelsDev(4), litellm: {} }).deps);
    const world = deps({ snapshot, modelsDev: modelsDev(40), litellm: {} });

    // Act
    const built = buildPublishedFiles(1, builtInModelCatalogs(), world.deps, gzipped(snapshot) - 1);

    // Assert
    await should(built).rejectedWith(/over the \d+ budget, and the committed snapshot is \d+ bytes/u);
  });

  it('should fail the build when the live build is over budget and there is no snapshot', async () => {
    // Arrange
    const live = await buildSuggestions(deps({ modelsDev: modelsDev(40), litellm: {} }).deps);
    const world = deps({ modelsDev: modelsDev(40), litellm: {} });

    // Act
    const built = buildPublishedFiles(1, builtInModelCatalogs(), world.deps, gzipped(live) - 1);

    // Assert
    await should(built).rejectedWith(/no valid committed snapshot to fall back to/u);
  });

  it('should fail the build when the committed snapshot is itself the answer and is over budget', async () => {
    // Arrange
    const snapshot = await buildSuggestions(deps({ modelsDev: modelsDev(4), litellm: {} }).deps);
    const world = deps({ snapshot, down: [MODELS_DEV_URL] });

    // Act
    const built = buildPublishedFiles(1, builtInModelCatalogs(), world.deps, gzipped(snapshot) - 1);

    // Assert
    await should(built).rejectedWith(/it is the committed snapshot: trim it/u);
  });

  it('should publish the live build untouched when it fits, and hold the real budget at 300 KB', async () => {
    // Arrange
    const world = deps({ modelsDev: modelsDev(4), litellm: {} });

    // Act
    const files = await buildPublishedFiles(1, builtInModelCatalogs(), world.deps);

    // Assert
    should(GZIP_BUDGET_BYTES).equal(300 * 1024);
    should(JSON.parse(files['catalog/models.json'] as string).suggestions.generated).equal('2026-11-23');
    should(world.log).eql([]);
  });
});

describe('the committed snapshot', () => {
  const text = readFileSync(SUGGESTIONS_SNAPSHOT_FILE, 'utf8');

  it('should read whole under the published schema, hold every provider we keep, and keep its keys sorted (the formatter, not --refresh, decides the line breaks)', () => {
    // Act
    const read = readSuggestions(JSON.parse(text));

    // Assert
    should(read.dropped).eql([]);
    should(Object.keys(read.suggestions?.providers ?? {}).sort()).eql([...SUGGESTION_PROVIDERS].sort());
    should(JSON.stringify(JSON.parse(text))).equal(JSON.stringify(JSON.parse(stableJson(JSON.parse(text)))));
  });

  it('should hold the models the new catalogs name, so a catalog id is never one the database has not heard of', () => {
    // Arrange
    const providers = (JSON.parse(text) as Suggestions).providers;
    const catalogs = builtInModelCatalogs();
    const expected: [string, string, 'gemini' | 'copilot' | 'opencode'][] = [
      ['google', 'google-gemini', 'gemini'],
      ['github-copilot', 'github-copilot', 'copilot'],
      ['xai', 'xai', 'opencode'],
      ['mistral', 'mistral', 'opencode'],
    ];

    // Assert
    for (const [provider, catalogId, half] of expected) {
      for (const entry of catalogs[catalogId]?.[half]?.models ?? []) {
        should(providers[provider]?.models[entry.id]).be.ok();
      }
    }
  });

  it('should fit the size budget: the whole published models.json under 300 KB gzipped', () => {
    // Act
    const suggestions = JSON.parse(text) as Suggestions;
    const file = publishedModelCatalogFiles(99, builtInModelCatalogs(), suggestions)['catalog/models.json'] as string;
    const gzipped = Bun.gzipSync(new TextEncoder().encode(file)).length;

    // Assert
    should(gzipped).be.below(GZIP_BUDGET_BYTES);
    should(gzipped).be.above(10 * 1024);
  });
});
