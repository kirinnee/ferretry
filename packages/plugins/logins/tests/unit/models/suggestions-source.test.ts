import { readFileSync } from 'node:fs';
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
  buildSuggestions,
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
    should(gzipped).be.below(300 * 1024);
    should(gzipped).be.above(10 * 1024);
  });
});
