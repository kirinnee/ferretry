import { describe, it } from 'bun:test';
import should from 'should';
import { MAX_ROUGH_PROMPT_CHARS, MAX_ROUTING_PROMPT_CHARS } from '../../src/lib/pack.ts';
import * as cleanUp from '../../src/lib/pack-cleanup.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const INSTANT = '2026-10-22T12:00:00.000Z';
const quota = { state: 'plenty', leftPercent: 54, tightest: 'week', windows: [], summary: '5h 2% · wk 46%' };
const runtime = {
  name: 'claude-work',
  harness: 'claude',
  provider: 'anthropic',
  login: 'claude-work',
  ready: true,
  quota,
  models: ['claude-opus-5-5', 'claude-haiku-5-5'],
};
const model = {
  provider: 'anthropic',
  harness: 'claude',
  id: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  tier: 'best',
  context: 1_000_000,
  efforts: ['low', 'high', 'max'],
  runtimes: [
    { name: 'claude-work', ready: true },
    { name: 'claude-off', ready: false },
  ],
};
const routing = { text: 'Plans on claude-opus-5-5 max.', source: 'file' };
const job = {
  id: 'run-1',
  session: 's9',
  name: 'Routing Prompt Clean-up',
  runtime: 'claude-work',
  startedAt: INSTANT,
  status: 'suggested',
};
const suggested = { by: 'claude-opus-5-5', via: 'claude-work', at: INSTANT };
const suggestion = {
  suggested,
  before: 'opus for hard stuff, haiku chores, glm-9 whatever',
  after: 'Planning and review: claude-opus-5-5 at max. Chores: claude-haiku-5-5 low.',
  notes: [
    { kind: 'unknown_model', message: 'glm-9 is not a model any catalog lists; it was left out.', model: 'glm-9' },
    { kind: 'suggestion', message: 'Add a Codex login for a second family.' },
  ],
};

const cases: SchemaCase[] = [
  { name: 'inventory runtime', schema: cleanUp.PackInventoryRuntimeSchema, value: runtime },
  { name: 'inventory model', schema: cleanUp.PackInventoryModelSchema, value: model },
  {
    name: 'inventory',
    schema: cleanUp.PackInventorySchema,
    value: { at: INSTANT, runtimes: [runtime], models: [model], routing },
  },
  { name: 'rough prompt', schema: cleanUp.RoughPromptSchema, value: 'x'.repeat(MAX_ROUTING_PROMPT_CHARS + 500) },
  { name: 'clean-up request', schema: cleanUp.PackCleanUpRequestSchema, value: { prompt: 'opus for hard stuff' } },
  {
    name: 'clean-up request on a named runtime',
    schema: cleanUp.PackCleanUpRequestSchema,
    value: { runtime: 'claude-work', model: 'claude-opus-5-5' },
  },
  {
    name: 'write-it-for-me request',
    schema: cleanUp.PackCleanUpRequestSchema,
    value: { mode: 'generate', idea: 'cheap models for chores, Opus for planning' },
  },
  {
    name: 'write-it-for-me request with no idea',
    schema: cleanUp.PackCleanUpRequestSchema,
    value: { mode: 'generate' },
  },
  { name: 'idea', schema: cleanUp.IdeaSchema, value: 'never burn the Claude weekly quota' },
  { name: 'idea at its limit', schema: cleanUp.IdeaSchema, value: 'x'.repeat(cleanUp.MAX_IDEA_CHARS) },
  {
    name: 'multi-line idea with a rough prompt',
    schema: cleanUp.PackCleanUpRequestSchema,
    value: {
      mode: 'generate',
      idea: 'Chores on the cheap models.\n\n- Opus for planning\n- never burn the weekly quota',
      prompt: 'x'.repeat(MAX_ROUGH_PROMPT_CHARS),
    },
  },
  {
    name: 'written job',
    schema: cleanUp.PackCleanUpJobResultSchema,
    value: {
      job: { ...job, mode: 'generate', name: 'Routing Prompt Writer' },
      suggestion: { ...suggestion, before: '', suggested: { ...suggested, mode: 'generate' } },
    },
  },
  { name: 'clean-up started', schema: cleanUp.PackCleanUpStartSchema, value: { outcome: 'started', job } },
  {
    name: 'clean-up refused',
    schema: cleanUp.PackCleanUpStartSchema,
    value: { outcome: 'refused', message: 'No runtime can start a ferret now.' },
  },
  { name: 'draft', schema: cleanUp.PackCleanUpDraftSchema, value: { prompt: 'x', notes: ['a', 3], extra: true } },
  { name: 'note', schema: cleanUp.PackCleanUpNoteSchema, value: suggestion.notes[0] },
  { name: 'suggestion', schema: cleanUp.PackCleanUpSuggestionSchema, value: suggestion },
  { name: 'job result', schema: cleanUp.PackCleanUpJobResultSchema, value: { job, suggestion } },
  {
    name: 'accept',
    schema: cleanUp.PackRoutingAcceptRequestSchema,
    value: { prompt: suggestion.after, suggested },
  },
  {
    name: 'write result',
    schema: cleanUp.PackRoutingWriteResultSchema,
    value: { outcome: 'nothing', message: 'There is no accepted clean-up to undo.' },
  },
];

describe('clean-up schemas', () => {
  it('should round-trip every valid value and cover every exported schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(cleanUp, cases);
  });

  it('should refuse what a caller or a model could get wrong', () => {
    assertRejects([
      {
        name: 'a rough prompt past its limit',
        schema: cleanUp.RoughPromptSchema,
        value: 'x'.repeat(MAX_ROUGH_PROMPT_CHARS + 1),
      },
      {
        name: 'a rewrite too long to save',
        schema: cleanUp.PackCleanUpSuggestionSchema,
        value: { ...suggestion, after: 'x'.repeat(MAX_ROUTING_PROMPT_CHARS + 1) },
      },
      {
        name: 'accepting a prompt too long to save',
        schema: cleanUp.PackRoutingAcceptRequestSchema,
        value: { prompt: 'x'.repeat(MAX_ROUTING_PROMPT_CHARS + 1), suggested },
      },
      { name: 'a draft with no prompt', schema: cleanUp.PackCleanUpDraftSchema, value: { notes: [] } },
      {
        name: 'an unknown note kind',
        schema: cleanUp.PackCleanUpNoteSchema,
        value: { kind: 'praise', message: 'Nice.' },
      },
      { name: 'an idea past its limit', schema: cleanUp.IdeaSchema, value: 'x'.repeat(cleanUp.MAX_IDEA_CHARS + 1) },
      { name: 'an unknown builder mode', schema: cleanUp.PackCleanUpRequestSchema, value: { mode: 'invent' } },
      { name: 'an unknown request key', schema: cleanUp.PackCleanUpRequestSchema, value: { preferences: 'x' } },
    ]);
  });

  it('should let an idea run to four thousand characters, line breaks kept, trimmed at the edges', () => {
    should(cleanUp.MAX_IDEA_CHARS).equal(4_000);
    should(cleanUp.IdeaSchema.parse(`  first\n\nsecond  `)).equal('first\n\nsecond');
    should(cleanUp.IdeaSchema.safeParse('x'.repeat(4_000)).success).be.true();
    should(cleanUp.IdeaSchema.safeParse('x'.repeat(4_001)).success).be.false();
    should(cleanUp.MAX_IDEA_CHARS).be.below(MAX_ROUGH_PROMPT_CHARS);
  });

  it('should keep a clean-up session hidden under the old builder label', () => {
    should(cleanUp.PACK_CLEAN_UP_LABEL).equal('ferretry-guide-builder');
    should(cleanUp.PACK_CLEAN_UP_JOBS_PATH).equal('/v1/pack/routing/jobs');
  });
});

describe('diffText', () => {
  const join = (parts: readonly cleanUp.TextDiffPart[], drop: 'added' | 'removed'): string =>
    parts
      .filter(part => part.kind !== drop)
      .map(part => part.text)
      .join('');

  it('should give the after side back exactly and mark only the words that changed', () => {
    // Arrange
    const before = 'Use opus for planning. Use haiku for chores.';
    const after = 'Use claude-opus-5-5 for planning. Use haiku for chores and renames.';

    // Act
    const parts = cleanUp.diffText(before, after);

    // Assert
    should(join(parts, 'removed')).equal(after);
    should(join(parts, 'added')).equal(before);
    should(parts.filter(part => part.kind === 'removed').map(part => part.text.trim())).deepEqual(['opus', 'chores.']);
    should(parts.filter(part => part.kind === 'added').map(part => part.text.trim())).deepEqual([
      'claude-opus-5-5',
      'chores and renames.',
    ]);
  });

  it('should merge neighbouring parts of a kind and say nothing changed for equal text', () => {
    should(cleanUp.diffText('a b c', 'a b c')).deepEqual([{ kind: 'same', text: 'a b c' }]);
    should(cleanUp.diffText('', 'new words')).deepEqual([{ kind: 'added', text: 'new words' }]);
    should(cleanUp.diffText('old words', '')).deepEqual([{ kind: 'removed', text: 'old words' }]);
  });

  it('should not count a reflowed line as every word changing', () => {
    should(cleanUp.diffText('a b\nc', 'a b c').every(part => part.kind === 'same')).be.true();
  });

  it('should replace a side too long to compare word by word whole', () => {
    // Arrange
    const long = 'w '.repeat(2_500);

    // Act
    const parts = cleanUp.diffText(long, `${long}x`);

    // Assert
    should(parts.map(part => part.kind)).deepEqual(['removed', 'added']);
  });
});
