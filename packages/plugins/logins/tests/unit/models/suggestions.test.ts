import { describe, it } from 'bun:test';
import should from 'should';
import { builtInModelCatalogs } from '../../../daemon/lib/catalog/catalog.ts';
import {
  readSuggestions,
  stableJson,
  SUGGESTION_PROVIDERS,
  type Suggestions,
  suggestedModels,
  trimModelsDev,
  withRetirementDates,
} from '../../../daemon/lib/catalog/suggestions.ts';

/** A models.dev row as the database writes it: fields we keep, fields we drop, and a `null` it uses for absent. */
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'ignored-by-the-trim',
  name: 'Model',
  family: 'dropped',
  attachment: true,
  reasoning: true,
  tool_call: true,
  temperature: true,
  knowledge: '2026-01',
  release_date: '2026-05-01',
  last_updated: '2026-05-02',
  open_weights: false,
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 200000, output: 64000 },
  cost: { input: 3, output: 15, cache_read: 0.3, input_audio: 9, context_over_200k: { input: 6, output: 22 } },
  status: null,
  ...overrides,
});

const provider = (models: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  id: 'ignored',
  name: 'Provider',
  api: 'https://api.example.test/v1',
  env: ['EXAMPLE_API_KEY'],
  doc: 'https://docs.example.test',
  models,
  ...overrides,
});

describe('trimModelsDev (models.dev is untrusted data)', () => {
  it('should keep only the providers we have presets for and only the fields a suggestion carries', () => {
    // Arrange
    const raw = {
      anthropic: provider({ 'claude-x': row() }),
      'some-random-gateway': provider({ nope: row() }),
    };

    // Act
    const { providers, dropped } = trimModelsDev(raw);

    // Assert
    should(Object.keys(providers)).eql(['anthropic']);
    should(providers.anthropic).eql({
      name: 'Provider',
      api: 'https://api.example.test/v1',
      env: ['EXAMPLE_API_KEY'],
      models: {
        'claude-x': {
          name: 'Model',
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 200000, output: 64000 },
          cost: { input: 3, output: 15, cache_read: 0.3 },
          release_date: '2026-05-01',
        },
      },
    });
    should(dropped.map(entry => entry.where)).containEql('openai');
    should(dropped.map(entry => entry.where)).not.containEql('anthropic');
  });

  it('should drop a row that does not check and name it, keeping its siblings', () => {
    // Arrange
    const raw = {
      xai: provider({
        good: row(),
        'name-too-long': row({ name: 'x'.repeat(201) }),
        'bad-status': row({ status: 'trusted-by-us' }),
        'negative-cost': row({ cost: { input: -1, output: 1 } }),
        'a bad id': row(),
        'not-a-map': 'text',
      }),
    };

    // Act
    const { providers, dropped } = trimModelsDev(raw);

    // Assert
    should(Object.keys(providers.xai?.models ?? {})).eql(['good']);
    const named = dropped.filter(entry => entry.where.startsWith('xai/')).map(entry => entry.where);
    should(named.sort()).eql(
      ['xai/a bad id', 'xai/bad-status', 'xai/name-too-long', 'xai/negative-cost', 'xai/not-a-map'].sort(),
    );
  });

  it('should drop a provider whose own fields do not check and refuse a document that is not a map', () => {
    // Act
    const odd = trimModelsDev({ xai: provider({ a: row() }, { api: 'javascript:alert(1)', env: ['lower'] }) });
    const none = trimModelsDev([]);

    // Assert
    should(odd.providers.xai).be.undefined();
    should(odd.dropped.map(entry => entry.where)).containEql('xai');
    should(none.providers).eql({});
    should(none.dropped[0]?.problem).match(/not a map/u);
  });
});

describe('withRetirementDates (LiteLLM)', () => {
  const base = (): Record<string, Suggestions['providers'][string]> => ({
    openai: trimModelsDev({ openai: provider({ 'gpt-5': row(), 'gpt-6': row() }) }).providers.openai as never,
    google: trimModelsDev({ google: provider({ 'gemini-2.5-pro': row() }) }).providers.google as never,
  });

  it('should add the date where an id matches, bare or under that provider’s LiteLLM prefix, and only a valid date', () => {
    // Act
    const { providers, added } = withRetirementDates(base(), {
      'gpt-5': { deprecation_date: '2027-03-01' },
      'gemini/gemini-2.5-pro': { deprecation_date: '2027-06-17' },
      'gpt-6': { deprecation_date: 'soon' },
      'unrelated/model': { deprecation_date: '2027-01-01' },
    });

    // Assert
    should(added).equal(2);
    should(providers.openai?.models['gpt-5']?.retires).equal('2027-03-01');
    should(providers.openai?.models['gpt-6']?.retires).be.undefined();
    should(providers.google?.models['gemini-2.5-pro']?.retires).equal('2027-06-17');
  });

  it('should add nothing from a document that is not a map', () => {
    should(withRetirementDates(base(), 'nope').added).equal(0);
  });
});

describe('stableJson', () => {
  it('should sort every key and end with one newline, so a refresh diffs line by line', () => {
    // Act
    const text = stableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } });

    // Assert
    should(text).equal(
      '{\n  "a": {\n    "c": 3,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });
});

describe('readSuggestions (what a daemon makes of the published value)', () => {
  const published = (): Suggestions => ({
    generated: '2026-11-23',
    sources: { modelsDev: 'https://models.dev/api.json' },
    providers: trimModelsDev({ xai: provider({ a: row() }) }).providers,
  });

  it('should read a good value whole, read nothing from an absent one, and refuse one that is not a document', () => {
    should(readSuggestions(published())).eql({ suggestions: published(), dropped: [] });
    should(readSuggestions(undefined)).eql({ suggestions: undefined, dropped: [] });
    should(readSuggestions('x').suggestions).be.undefined();
    should(readSuggestions({ ...published(), generated: 'yesterday' }).suggestions).be.undefined();
  });

  it('should leave out a row or a provider that does not check, naming it', () => {
    // Arrange
    const value = published() as unknown as {
      providers: Record<string, { models: Record<string, unknown> }>;
    };
    value.providers.xai!.models.broken = { name: '' };
    value.providers['Bad Provider'] = { models: {} };

    // Act
    const read = readSuggestions(value);

    // Assert
    should(Object.keys(read.suggestions?.providers.xai?.models ?? {})).eql(['a']);
    should(read.suggestions?.providers['Bad Provider']).be.undefined();
    should(read.dropped.map(entry => entry.where).sort()).eql(['Bad Provider', 'xai/broken']);
  });
});

describe('suggestedModels ("new / not reviewed", never a default, tier or effort)', () => {
  const suggestions: Suggestions = {
    generated: '2026-11-23',
    sources: { modelsDev: 'https://models.dev/api.json' },
    providers: trimModelsDev({
      xai: provider({
        'grok-4.7': row({ name: 'Grok 4.7' }),
        'grok-9': row({ name: 'Grok 9' }),
        'grok-old': row({ name: 'Grok Old', status: 'deprecated' }),
      }),
    }).providers,
  };

  it('should offer the ids the catalog does not list, in id order, leaving out a deprecated one', () => {
    // Arrange
    const xai = builtInModelCatalogs().xai;
    if (xai === undefined) throw new Error('the xai catalog is built in');

    // Act
    const rows = suggestedModels(xai, suggestions);

    // Assert
    should(rows.map(entry => entry.id)).eql(['grok-9']);
    should(rows[0]).match({ provider: 'xai', review: 'new / not reviewed' });
    should(xai.opencode?.models.some(model => model.id === 'grok-9')).be.false();
  });

  it('should offer nothing for a catalog with no provider here, or when there are no suggestions', () => {
    const gateway = builtInModelCatalogs().gateway;
    if (gateway === undefined) throw new Error('the gateway catalog is built in');
    should(suggestedModels(gateway, suggestions)).eql([]);
    should(suggestedModels(builtInModelCatalogs().xai!, undefined)).eql([]);
  });

  it('should keep only providers that a preset or a catalog names', () => {
    should([...SUGGESTION_PROVIDERS])
      .containEql('google')
      .and.containEql('github-copilot');
    should(new Set(SUGGESTION_PROVIDERS).size).equal(SUGGESTION_PROVIDERS.length);
  });
});
