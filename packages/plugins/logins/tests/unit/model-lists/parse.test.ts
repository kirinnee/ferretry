import { describe, it } from 'bun:test';
import should from 'should';
import {
  parseAnthropicList,
  parseGeminiList,
  parseModelList,
  parseOpenAiList,
} from '../../../daemon/lib/model-lists/parse.ts';
import { MODEL_LIST_MAX_IDS } from '../../../contract/model-list.ts';

/** Anthropic's documented `GET /v1/models` reply (platform.claude.com/docs/en/api/models/list), trimmed to the id rows. */
const ANTHROPIC_DOCS = {
  data: [
    { id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2019-12-27T18:11:19.117Z' },
  ],
  first_id: 'claude-opus-5-5',
  has_more: false,
  last_id: 'claude-opus-5-5',
};

/** MiniMax's documented Anthropic-compatible `GET /anthropic/v1/models` example. */
const MINIMAX_ANTHROPIC_DOCS = {
  data: [
    { id: 'MiniMax-M3.1-Flash', created_at: '2026-09-16T10:55:18Z', display_name: 'MiniMax-M3.1-Flash', type: 'model' },
    { id: 'MiniMax-M3', created_at: '2026-06-01T00:00:00Z', display_name: 'MiniMax-M3', type: 'model' },
  ],
  first_id: 'MiniMax-M3.1-Flash',
  has_more: false,
  last_id: 'MiniMax-M3',
};

/** MiniMax's documented OpenAI-compatible `GET /v1/models` example. */
const MINIMAX_OPENAI_DOCS = {
  object: 'list',
  data: [
    { id: 'MiniMax-M3.1-Flash', object: 'model', created: 1789556118, owned_by: 'minimax' },
    { id: 'MiniMax-M3', object: 'model', created: 1780272000, owned_by: 'minimax' },
  ],
};

/** OpenAI's documented `GET /v1/models` example (its placeholder ids). */
const OPENAI_DOCS = {
  object: 'list',
  data: [
    { id: 'model-id-0', object: 'model', created: 1686935002, owned_by: 'organization-owner', shutdown_date: null },
    { id: 'model-id-2', object: 'model', created: 1686935002, owned_by: 'openai', shutdown_date: '2026-10-23' },
  ],
};

/** DeepSeek's documented `GET /models` example. */
const DEEPSEEK_DOCS = {
  object: 'list',
  data: [
    { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
  ],
};

/** Gemini's documented `GET /v1beta/models` shape: `models/{model}` names, a page token when there is more. */
const GEMINI_DOCS = {
  models: [
    {
      name: 'models/gemini-1.5-flash-001',
      baseModelId: 'gemini-1.5-flash',
      version: '001',
      displayName: 'Gemini 1.5 Flash',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/text-embedding-004',
      version: '004',
      supportedGenerationMethods: ['embedContent'],
    },
  ],
};

describe('model list parsers', () => {
  it('should read the ids of Anthropic’s documented reply, whole', () => {
    // Act
    const actual = parseModelList(ANTHROPIC_DOCS);

    // Assert
    should(actual).eql({ shape: 'anthropic', ids: ['claude-opus-5-5'], complete: true });
  });

  it('should read MiniMax’s Anthropic-compatible reply as the Anthropic shape', () => {
    should(parseModelList(MINIMAX_ANTHROPIC_DOCS)).eql({
      shape: 'anthropic',
      ids: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
      complete: true,
    });
  });

  it('should read OpenAI-style replies (OpenAI, MiniMax /v1, DeepSeek) as the OpenAI shape', () => {
    should(parseModelList(OPENAI_DOCS)).eql({ shape: 'openai', ids: ['model-id-0', 'model-id-2'], complete: true });
    should(parseModelList(MINIMAX_OPENAI_DOCS)?.ids).eql(['MiniMax-M3.1-Flash', 'MiniMax-M3']);
    should(parseModelList(DEEPSEEK_DOCS)?.ids).eql(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('should strip Gemini’s models/ prefix and leave out a model that cannot generate content', () => {
    should(parseModelList(GEMINI_DOCS)).eql({ shape: 'gemini', ids: ['gemini-1.5-flash-001'], complete: true });
  });

  it('should say a paged list is not complete: an id missing from it proves nothing', () => {
    should(parseModelList({ ...ANTHROPIC_DOCS, has_more: true })?.complete).be.false();
    should(parseModelList({ ...GEMINI_DOCS, nextPageToken: 'abc' })?.complete).be.false();
  });

  it('should dispatch each shape to its own parser, and refuse the others’', () => {
    should(parseGeminiList(OPENAI_DOCS)).be.undefined();
    should(parseOpenAiList(GEMINI_DOCS)).be.undefined();
    should(parseAnthropicList(GEMINI_DOCS)).be.undefined();
    should(parseAnthropicList(ANTHROPIC_DOCS)?.shape).equal('anthropic');
  });

  it('should keep only ids, whatever else a gateway puts in a row', () => {
    // Arrange
    const row = { id: 'deepseek-chat', object: 'model', api_key: 'sk-not-a-real-key', owned_by: 'x' };

    // Act
    const actual = parseModelList({ object: 'list', data: [row] });

    // Assert
    should(JSON.stringify(actual)).not.containEql('sk-not-a-real-key');
    should(actual?.ids).eql(['deepseek-chat']);
  });

  it('should drop an id that is not one word of the catalog’s grammar, and a duplicate', () => {
    // Act
    const actual = parseModelList({
      object: 'list',
      data: [
        { id: 'deepseek-chat' },
        { id: 'deepseek-chat' },
        { id: 'has a space' },
        { id: '-leading-dash' },
        { id: 'x'.repeat(161) },
        { id: 42 },
        'not a row',
        null,
      ],
    });

    // Assert
    should(actual?.ids).eql(['deepseek-chat']);
  });

  it('should cap a very long list and say it was cut', () => {
    // Arrange
    const data = Array.from({ length: MODEL_LIST_MAX_IDS + 5 }, (_, index) => ({ id: `m${index}` }));

    // Act
    const actual = parseModelList({ object: 'list', data });

    // Assert
    should(actual?.ids).have.length(MODEL_LIST_MAX_IDS);
    should(actual?.complete).be.false();
  });

  it('should refuse a reply that is not a model list, so the last list is kept', () => {
    for (const payload of [
      undefined,
      null,
      'models',
      [],
      {},
      { data: 'x' },
      { data: [] },
      { data: [{ name: 'no id' }] },
      { models: [] },
      { error: { message: 'bad key' } },
      // A key or quota read shaped like a map, not a list.
      { data: { limit: 100, usage: 3 } },
    ]) {
      should(parseModelList(payload)).be.undefined();
    }
  });
});
