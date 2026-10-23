import { describe, expect, it } from 'bun:test';
import type { PackFleetModel } from '../../src/lib/pack.ts';
import {
  applyModelSuggestion,
  looksLikeModel,
  mentionedModels,
  mentionQueryAt,
  modelKey,
  modelMentions,
  modelNamed,
  modelVocabulary,
  namedModels,
  suggestionsAreSettled,
  suggestModels,
} from '../../src/lib/pack-mentions.ts';

const model = (overrides: Partial<PackFleetModel> & Pick<PackFleetModel, 'id' | 'label'>): PackFleetModel => ({
  provider: 'anthropic',
  providerLabel: 'Anthropic',
  harness: 'claude',
  tier: 'balanced',
  efforts: [],
  runtimes: ['claude-main'],
  ...overrides,
});

const OPUS = model({
  id: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  tier: 'best',
  efforts: ['low', 'high', 'max'],
});
const SONNET = model({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' });
const HAIKU = model({ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'fast' });
const LATEST = model({ id: '~anthropic/claude-opus-latest', label: 'Opus (latest)', tier: 'best' });
const GLM = model({
  provider: 'zai',
  providerLabel: 'z.ai',
  id: 'glm-5.3',
  label: 'GLM-5.3',
  runtimes: [],
});
const ASTRA = model({
  provider: 'openai',
  providerLabel: 'OpenAI',
  harness: 'codex',
  id: 'gpt-6-astra',
  label: 'GPT-6 Astra',
  tier: 'best',
  efforts: ['medium', 'high'],
  runtimes: ['codex-main'],
});
const OSS = model({
  provider: 'ollama',
  providerLabel: 'Ollama',
  id: 'gpt-oss:20b',
  label: 'gpt-oss 20B',
  tier: 'fast',
});
const FLASH = model({
  provider: 'deepseek',
  providerLabel: 'DeepSeek',
  id: 'deepseek-flash[1m]',
  label: 'DeepSeek Flash 1M',
  tier: 'fast',
  runtimes: [],
});

const FLEET_MODELS: readonly PackFleetModel[] = [OPUS, SONNET, HAIKU, LATEST, GLM, ASTRA, OSS, FLASH];

const vocabulary = modelVocabulary(FLEET_MODELS);
const marks = (text: string) =>
  modelMentions(text, vocabulary)
    .filter(segment => segment.kind !== 'text')
    .map(segment => [segment.kind, segment.text, segment.model?.id ?? null]);

describe('modelMentions', () => {
  it('gives the text back unchanged when its segments are joined', () => {
    const text = 'Use claude-opus-5-5 first, then gpt-6-astra-mini.\nOr GLM-5.3 — or nothing.';
    expect(
      modelMentions(text, vocabulary)
        .map(segment => segment.text)
        .join(''),
    ).toBe(text);
    expect(modelMentions('', vocabulary)).toEqual([]);
  });

  it('recognises ids and labels ignoring case, labels with spaces and ids with dots, colons and brackets', () => {
    expect(marks('Claude Opus 5.5 or CLAUDE-OPUS-5-5')).toEqual([
      ['known', 'Claude Opus 5.5', 'claude-opus-5-5'],
      ['known', 'CLAUDE-OPUS-5-5', 'claude-opus-5-5'],
    ]);
    expect(marks('try gpt-oss:20b, deepseek-flash[1m] and ~anthropic/claude-opus-latest.')).toEqual([
      ['known', 'gpt-oss:20b', 'gpt-oss:20b'],
      ['absent', 'deepseek-flash[1m]', 'deepseek-flash[1m]'],
      ['known', '~anthropic/claude-opus-latest', '~anthropic/claude-opus-latest'],
    ]);
  });

  it('marks a model no runtime here runs as absent, and a sentence-ending dot is not part of a name', () => {
    expect(marks('Reading: glm-5.3.')).toEqual([['absent', 'glm-5.3', 'glm-5.3']]);
  });

  it('does not see a known name inside a longer one, and calls the longer one unknown', () => {
    expect(marks('gpt-6-astra-mini')).toEqual([['unknown', 'gpt-6-astra-mini', null]]);
    expect(marks('xgpt-6-astra')).toEqual([['unknown', 'xgpt-6-astra', null]]);
  });

  it('marks what looks like a model nobody lists: a family, a letters-dash-digit, or a word after "model"', () => {
    expect(marks('claude-foo glm5 opus astra-7 5-mini')).toEqual([
      ['unknown', 'claude-foo', null],
      ['unknown', 'glm5', null],
      ['unknown', 'astra-7', null],
      ['unknown', '5-mini', null],
    ]);
    expect(marks('the model q.9 is fine, the model is fine')).toEqual([['unknown', 'q.9', null]]);
    expect(marks('released 2026-10-19, version 4.36.0')).toEqual([]);
  });

  it('prefers the model a runtime here runs when two catalogs share a name', () => {
    const elsewhere = { ...SONNET, provider: 'proxy', providerLabel: 'Proxy', runtimes: [] };
    const both = modelVocabulary([elsewhere, SONNET, { ...SONNET, provider: 'third' }]);
    expect(modelMentions('claude-sonnet-5', both)[0]).toMatchObject({ kind: 'known', model: SONNET });
    expect(modelVocabulary([{ ...SONNET, label: ' ' }]).terms).toHaveLength(1);
  });
});

describe('looksLikeModel', () => {
  it('needs a letter, and treats only a model introducer as one', () => {
    expect(looksLikeModel('12-3', null)).toBe(false);
    expect(looksLikeModel('foo.bar', 'model')).toBe(true);
    expect(looksLikeModel('foo.bar', '--models')).toBe(true);
    expect(looksLikeModel('foo.bar', 'the')).toBe(false);
    expect(looksLikeModel('plain', 'model')).toBe(false);
  });
});

describe('mentionedModels', () => {
  it('names each model once, unknown words by their text', () => {
    const segments = modelMentions('opus-x OPUS-X claude-opus-5-5 Claude Opus 5.5', vocabulary);
    expect(mentionedModels(segments).map(segment => segment.text)).toEqual(['opus-x', 'claude-opus-5-5']);
  });
});

describe('suggestions', () => {
  it('finds the word at the caret, half-written dots and colons included', () => {
    expect(mentionQueryAt('use glm-5. now', 10)).toEqual({ start: 4, end: 10, query: 'glm-5.' });
    expect(mentionQueryAt('use gpt-oss:2', 13)).toEqual({ start: 4, end: 13, query: 'gpt-oss:2' });
    expect(mentionQueryAt('use claude here', 7)).toEqual({ start: 4, end: 10, query: 'cla' });
    expect(mentionQueryAt('a b', 2)).toBeNull();
    expect(mentionQueryAt('abc', 99)).toEqual({ start: 0, end: 3, query: 'abc' });
  });

  it('ranks ids before labels before contains, a model here before one elsewhere, then by tier', () => {
    expect(suggestModels(FLEET_MODELS, 'claude').map(entry => entry.id)).toEqual([
      OPUS.id,
      SONNET.id,
      HAIKU.id,
      LATEST.id,
    ]);
    expect(suggestModels(FLEET_MODELS, 'gpt').map(entry => entry.id)).toEqual([ASTRA.id, OSS.id]);
    expect(suggestModels(FLEET_MODELS, 'deepseek').map(entry => entry.id)).toEqual([FLASH.id]);
    expect(suggestModels(FLEET_MODELS, 'astra').map(entry => entry.id)).toEqual([ASTRA.id]);
    expect(suggestModels(FLEET_MODELS, 'latest').map(entry => entry.id)).toEqual([LATEST.id]);
    expect(suggestModels(FLEET_MODELS, 'c')).toEqual([]);
    expect(suggestModels(FLEET_MODELS, 'claude', { limit: 1 })).toEqual([OPUS]);
    expect(suggestModels([GLM, { ...GLM, id: 'glm-5.2', label: 'GLM-5.2' }], 'glm').map(entry => entry.id)).toEqual([
      'glm-5.2',
      'glm-5.3',
    ]);
  });

  it('settles when the only suggestions are the word itself', () => {
    expect(suggestionsAreSettled([GLM], 'GLM-5.3')).toBe(true);
    expect(suggestionsAreSettled([GLM], 'glm-5.3')).toBe(true);
    expect(suggestionsAreSettled([GLM], 'glm')).toBe(false);
    expect(suggestionsAreSettled([], 'glm')).toBe(false);
  });

  it('replaces the whole word with the id and puts the caret after it', () => {
    expect(applyModelSuggestion('use cla here', { start: 4, end: 7 }, OPUS)).toEqual({
      text: 'use claude-opus-5-5 here',
      caret: 19,
    });
  });

  it('names a model exactly by id or label, and keys each catalog entry apart', () => {
    expect(modelNamed(vocabulary, ' glm-5.3 ')).toBe(GLM);
    expect(modelNamed(vocabulary, 'gpt-6 astra')).toBe(ASTRA);
    expect(modelNamed(vocabulary, 'gpt-6')).toBeUndefined();
    expect(modelKey(ASTRA)).toBe('openai:codex:gpt-6-astra');
  });
});

describe('namedModels', () => {
  it('should list each model the prompt names once, in the order it first appears, with the effort after it', () => {
    // Act
    const named = namedModels(
      'Plans: Claude Opus 5.5 at max. Chores: claude-haiku-4-5. Second family: gpt-6-astra @high, then claude-opus-5-5 low.',
      vocabulary,
    );

    // Assert
    expect(named.map(entry => [entry.position, entry.model.id, entry.effort ?? null])).toEqual([
      [1, OPUS.id, 'max'],
      [2, HAIKU.id, null],
      [3, ASTRA.id, 'high'],
    ]);
  });

  it('should take only an effort the model has, and skip words that only look like models', () => {
    // Act
    const named = namedModels('claude-sonnet-5 max; glm-9 for chores; claude-opus-5-5 (low)', vocabulary);

    // Assert
    expect(named.map(entry => [entry.model.id, entry.effort ?? null])).toEqual([
      [SONNET.id, null],
      [OPUS.id, 'low'],
    ]);
  });
});
