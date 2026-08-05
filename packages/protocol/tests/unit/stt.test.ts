import { describe, it } from 'bun:test';
import should from 'should';
import type { SttEnhancementErrorView, SttEnhancementRequest, SttEnhancementResult } from '../../src/lib/index.ts';
import * as stt from '../../src/lib/stt.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const enhancementRequest = {
  text: 'ship the protocol package',
  provider: 'groq',
  model: 'moonshotai/kimi-k2-instruct',
  context: ['previous turn', 'current turn'],
  userContext: 'The speaker is dictating commit messages.',
  dictionary: [{ term: 'ferretry', aliases: ['ferret tree', 'ferretree'] }, { term: 'dictation' }],
} satisfies SttEnhancementRequest;
const minimalEnhancementRequest = { text: '', provider: 'groq' } satisfies SttEnhancementRequest;

const enhancementResult = {
  text: 'Ship the protocol package.',
  provider: 'groq',
  model: 'moonshotai/kimi-k2-instruct',
  latencyMs: 412,
} satisfies SttEnhancementResult;

const enhancementErrorView = {
  error: 'GROQ_API_KEY is not configured',
  code: 'secret_missing',
} satisfies SttEnhancementErrorView;

const sttCases: SchemaCase[] = [
  { name: 'enhancement provider', schema: stt.SttEnhancementProviderSchema, value: 'groq' },
  { name: 'enhancement request', schema: stt.SttEnhancementRequestSchema, value: enhancementRequest },
  { name: 'enhancement result', schema: stt.SttEnhancementResultSchema, value: enhancementResult },
  { name: 'enhancement error code', schema: stt.SttEnhancementErrorCodeSchema, value: 'rate_limited' },
  { name: 'enhancement error view', schema: stt.SttEnhancementErrorViewSchema, value: enhancementErrorView },
];

describe('stt schemas', () => {
  it('should round-trip every public STT schema', () => {
    // Arrange
    const cases = sttCases;

    // Act + Assert
    assertRoundTrips(cases);
    // The module holds ONE subject now — dictation enhancement — so this assertion is also the
    // record that nothing recognition-shaped survived the browser taking recognition over.
    assertCoversEverySchema(stt, cases);
  });

  it('should resolve every enhancement-error and provider member', () => {
    // Arrange
    const enums = [
      {
        schema: stt.SttEnhancementErrorCodeSchema,
        members: [
          'bad_request',
          'too_long',
          'provider_unknown',
          'bad_model',
          'secret_missing',
          'secret_invalid',
          'rate_limited',
          'timeout',
          'provider_unreachable',
          'provider_error',
          'malformed_response',
        ],
      },
      { schema: stt.SttEnhancementProviderSchema, members: ['groq'] },
    ];

    // Act + Assert
    for (const entry of enums) {
      for (const member of entry.members) should(entry.schema.parse(member)).equal(member);
      should(entry.schema.safeParse('nonesuch').success).be.false();
    }
    should(stt.SttEnhancementErrorCodeSchema.options).have.length(11);
  });

  it('should publish the dictionary bound clients have to clamp to', () => {
    // Exported so a client sends the first entries rather than guessing a
    // larger cap and having the whole request refused as bad_request.
    should(stt.MAX_STT_DICTIONARY_ENTRIES).equal(128);
    const dictionary = (count: number) => Array.from({ length: count }, (_unused, index) => ({ term: `t-${index}` }));

    should(
      stt.SttEnhancementRequestSchema.safeParse({
        ...minimalEnhancementRequest,
        dictionary: dictionary(stt.MAX_STT_DICTIONARY_ENTRIES),
      }).success,
    ).be.true();
    should(
      stt.SttEnhancementRequestSchema.safeParse({
        ...minimalEnhancementRequest,
        dictionary: dictionary(stt.MAX_STT_DICTIONARY_ENTRIES + 1),
      }).success,
    ).be.false();
  });

  it('should accept minimal and fully populated enhancement requests within their bounds', () => {
    // Arrange
    const maxima = {
      text: 'a'.repeat(8_000),
      provider: 'groq',
      model: 'm'.repeat(128),
      context: Array.from({ length: 10 }, (_unused, index) => `turn-${index}`),
      userContext: 'u'.repeat(2_000),
      dictionary: Array.from({ length: stt.MAX_STT_DICTIONARY_ENTRIES }, (_unused, index) => ({
        term: `term-${index}`,
      })),
    };

    // Act
    const parsed = [minimalEnhancementRequest, enhancementRequest, maxima].map(value =>
      stt.SttEnhancementRequestSchema.parse(value),
    );

    // Assert
    should(parsed[0]).deepEqual(minimalEnhancementRequest);
    should(parsed[1]).deepEqual(enhancementRequest);
    should(parsed[2]?.dictionary).have.length(stt.MAX_STT_DICTIONARY_ENTRIES);
    should(stt.SttEnhancementRequestSchema.parse({ text: 'x', provider: 'groq', model: '  kimi  ' }).model).equal(
      'kimi',
    );
    should(
      stt.SttEnhancementRequestSchema.parse({
        text: 'x',
        provider: 'groq',
        dictionary: [{ term: '  ferretry  ', aliases: ['  ferret tree  '] }],
      }).dictionary,
    ).deepEqual([{ term: 'ferretry', aliases: ['ferret tree'] }]);
  });

  it('should reject enhancement requests that break strictness or exceed their limits', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'unknown key',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, temperature: 0.2 },
      },
      { name: 'no text', schema: stt.SttEnhancementRequestSchema, value: { provider: 'groq' } },
      { name: 'no provider', schema: stt.SttEnhancementRequestSchema, value: { text: 'x' } },
      {
        name: 'unknown provider',
        schema: stt.SttEnhancementRequestSchema,
        value: { text: 'x', provider: 'openai' },
      },
      {
        name: 'text above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { text: 'a'.repeat(8_001), provider: 'groq' },
      },
      {
        name: 'blank model',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, model: '   ' },
      },
      {
        name: 'model above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, model: 'm'.repeat(129) },
      },
      {
        name: 'too many context turns',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, context: Array.from({ length: 11 }, () => 'turn') },
      },
      {
        name: 'user context above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, userContext: 'u'.repeat(2_001) },
      },
      {
        name: 'too many dictionary entries',
        schema: stt.SttEnhancementRequestSchema,
        value: {
          ...minimalEnhancementRequest,
          dictionary: Array.from({ length: stt.MAX_STT_DICTIONARY_ENTRIES + 1 }, () => ({ term: 'term' })),
        },
      },
      {
        name: 'blank dictionary term',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, dictionary: [{ term: '   ' }] },
      },
      {
        name: 'dictionary term above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, dictionary: [{ term: 't'.repeat(65) }] },
      },
      {
        name: 'dictionary alias above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, dictionary: [{ term: 'ferretry', aliases: ['a'.repeat(65)] }] },
      },
      {
        name: 'unknown dictionary key',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, dictionary: [{ term: 'ferretry', weight: 2 }] },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should resolve enhancement results and error views and reject malformed ones', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'result text above the maximum',
        schema: stt.SttEnhancementResultSchema,
        value: { ...enhancementResult, text: 'a'.repeat(16_001) },
      },
      {
        name: 'result without a model',
        schema: stt.SttEnhancementResultSchema,
        value: { ...enhancementResult, model: '' },
      },
      {
        name: 'result with a negative latency',
        schema: stt.SttEnhancementResultSchema,
        value: { ...enhancementResult, latencyMs: -1 },
      },
      {
        name: 'result with an unknown provider',
        schema: stt.SttEnhancementResultSchema,
        value: { ...enhancementResult, provider: 'anthropic' },
      },
      {
        name: 'error view without a message',
        schema: stt.SttEnhancementErrorViewSchema,
        value: { ...enhancementErrorView, error: '' },
      },
      {
        name: 'error view with an unknown code',
        schema: stt.SttEnhancementErrorViewSchema,
        value: { ...enhancementErrorView, code: 'bad_audio' },
      },
    ];

    // Act
    const parsed = stt.SttEnhancementResultSchema.parse({ ...enhancementResult, text: '', latencyMs: 0 });

    // Assert
    should(parsed.text).equal('');
    should(stt.SttEnhancementErrorViewSchema.parse(enhancementErrorView)).deepEqual(enhancementErrorView);
    assertRejects(cases);
  });
});
