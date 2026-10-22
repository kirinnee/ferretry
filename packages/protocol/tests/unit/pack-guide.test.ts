import { describe, it } from 'bun:test';
import should from 'should';
import type { GuideUseCase } from '../../src/lib/pack.ts';
import * as guide from '../../src/lib/pack-guide.ts';
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
};
const model = {
  provider: 'anthropic',
  providerLabel: 'Anthropic',
  harness: 'claude',
  id: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  tier: 'best',
  context: 1_000_000,
  efforts: ['low', 'high', 'max'],
  description: 'Strongest; slow.',
  describedBy: 'owner',
  retires: '2027-06-01',
  price: { input: 5, output: 25 },
  runtimes: [
    { name: 'claude-work', ready: true },
    { name: 'claude-off', ready: false, reason: 'needs signing in' },
  ],
  headroom: { runtimes: 2, ready: 1, best: { runtime: 'claude-work', quota }, summary: '2 runtimes, 1 ready' },
};
const useCase = (id: string, overrides: Partial<GuideUseCase> = {}): GuideUseCase => ({
  id,
  title: `Title ${id}`,
  description: `About ${id}.`,
  candidates: [{ provider: 'anthropic', model: 'claude-opus-5-5', why: 'Strongest.' }],
  ...overrides,
});
const job = {
  id: 'run-1',
  session: 's9',
  name: 'gonzalo',
  runtime: 'claude-work',
  startedAt: INSTANT,
  status: 'running',
};
const suggested = { by: 'claude-opus-5-5', via: 'claude-work', at: INSTANT };
const routing = { prompt: 'Plans on Opus.', short: 'Routing: plan → opus.' };
const suggestion = {
  suggested,
  routing,
  useCases: [useCase('plan-review')],
  dropped: [{ useCase: 'plan-review', provider: 'x', model: 'ghost', message: 'x ghost is not in any catalog' }],
  flagged: [{ message: 'its routing guidance did not check' }],
  current: { source: 'derived', useCases: [] },
};

const cases: SchemaCase[] = [
  { name: 'runtime', schema: guide.PackInventoryRuntimeSchema, value: runtime },
  { name: 'price', schema: guide.PackInventoryPriceSchema, value: { input: 0.5, output: 1.5 } },
  { name: 'headroom', schema: guide.PackModelHeadroomSchema, value: model.headroom },
  { name: 'model', schema: guide.PackInventoryModelSchema, value: model },
  {
    name: 'inventory',
    schema: guide.PackInventorySchema,
    value: {
      at: INSTANT,
      models: [model],
      runtimes: [runtime],
      guide: { source: 'derived', useCases: [] },
      preferences: 'Opus for reviews.',
    },
  },
  {
    name: 'suggest request',
    schema: guide.PackGuideSuggestRequestSchema,
    value: { runtime: 'claude-work', model: 'opus', preferences: 'x' },
  },
  { name: 'started', schema: guide.PackGuideSuggestStartSchema, value: { outcome: 'started', job } },
  {
    name: 'refused',
    schema: guide.PackGuideSuggestStartSchema,
    value: { outcome: 'refused', message: 'No runtime is ready.' },
  },
  { name: 'draft', schema: guide.PackGuideDraftSchema, value: { routing: 'anything', useCases: [{}], extra: true } },
  { name: 'note', schema: guide.PackGuideNoteSchema, value: suggestion.dropped[0] },
  { name: 'suggestion', schema: guide.PackGuideSuggestionSchema, value: suggestion },
  {
    name: 'job result',
    schema: guide.PackGuideJobResultSchema,
    value: { job: { ...job, status: 'suggested' }, suggestion },
  },
  {
    name: 'accept',
    schema: guide.PackGuideAcceptRequestSchema,
    value: { useCases: [useCase('a')], routing, suggested, partial: true },
  },
  {
    name: 'describe',
    schema: guide.PackGuideDescribeRequestSchema,
    value: { provider: 'anthropic', model: 'opus', description: null },
  },
  {
    name: 'write result',
    schema: guide.PackGuideWriteResultSchema,
    value: { outcome: 'nothing', message: 'Nothing to undo.' },
  },
];

describe('pack-guide schemas', () => {
  it('should round-trip every valid value and cover every exported schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(guide, cases);
  });

  it('should refuse what a caller or a builder could get wrong', () => {
    assertRejects([
      { name: 'a draft without use cases', schema: guide.PackGuideDraftSchema, value: { routing: {} } },
      { name: 'an unknown start outcome', schema: guide.PackGuideSuggestStartSchema, value: { outcome: 'queued' } },
      {
        name: 'a blank description',
        schema: guide.PackGuideDescribeRequestSchema,
        value: { model: 'm', description: '  ' },
      },
      {
        name: 'a credential on a runtime',
        schema: guide.PackInventoryRuntimeSchema,
        value: { ...runtime, token: 'x' },
      },
      {
        name: 'an accepted suggestion with its own accept time',
        schema: guide.PackGuideAcceptRequestSchema,
        value: { useCases: [], suggested: { ...suggested, acceptedAt: INSTANT } },
      },
    ]);
  });

  it('should name a run by an encoded path, and its builder by a fixed label', () => {
    should(guide.packGuideJobPath('run 1/x')).equal('/v1/pack/guide/jobs/run%201%2Fx');
    should(guide.PACK_GUIDE_BUILDER_LABEL).equal('ferretry-guide-builder');
  });
});

describe('diffGuide', () => {
  it('should say what was added, changed, removed or left the same, in the draft order then the removed', () => {
    // Arrange
    const before = [
      useCase('keep'),
      useCase('reword', { title: 'Old', keywords: ['a', 'b'] }),
      useCase('gone'),
      useCase('why', { candidates: [{ provider: 'anthropic', model: 'claude-opus-5-5', why: 'Old reason.' }] }),
    ];
    const after = [
      useCase('new'),
      useCase('reword', {
        title: 'New',
        description: 'Different.',
        keywords: ['b', 'c'],
        candidates: [
          { provider: 'openai', model: 'gpt-6', harness: 'codex', effort: 'high', why: 'x' },
          { provider: 'anthropic', model: 'claude-opus-5-5', why: 'y' },
        ],
      }),
      useCase('keep'),
      useCase('why', { candidates: [{ provider: 'anthropic', model: 'claude-opus-5-5', why: 'New reason.' }] }),
    ];

    // Act
    const diff = guide.diffGuide(before, after);

    // Assert
    should(diff.map(row => [row.id, row.status, row.changes])).deepEqual([
      ['new', 'added', []],
      [
        'reword',
        'changed',
        [
          'title: "Old" → "New"',
          'description reworded',
          'keywords: +c -a',
          'candidates: gpt-6 (codex) @high, claude-opus-5-5',
        ],
      ],
      ['keep', 'same', []],
      ['why', 'changed', ['reasons reworded']],
      ['gone', 'removed', []],
    ]);
    should(guide.changingIds(diff)).deepEqual(['new', 'reword', 'why', 'gone']);
  });

  it('should word reordered keywords and an emptied candidate list', () => {
    // Act
    const diff = guide.diffGuide(
      [useCase('a', { keywords: ['x', 'y'] })],
      [useCase('a', { keywords: ['y', 'x'], candidates: [] })],
    );

    // Assert
    should(diff[0]?.changes).deepEqual(['keywords: reordered', 'candidates: none']);
  });
});

describe('mergeGuide', () => {
  const before = [useCase('keep'), useCase('change', { title: 'Old' }), useCase('remove')];
  const after = [useCase('add'), useCase('change', { title: 'New' }), useCase('keep')];

  it('should be the draft itself when every change is accepted', () => {
    should(guide.mergeGuide(before, after, new Set(['add', 'change', 'remove']))).equal(after);
  });

  it('should keep the current order, replacing, removing and appending only what was accepted', () => {
    // Act
    const some = guide.mergeGuide(before, after, new Set(['change', 'add']));
    const removal = guide.mergeGuide(before, after, new Set(['remove']));
    const none = guide.mergeGuide(before, after, new Set());

    // Assert
    should(some.map(entry => [entry.id, entry.title])).deepEqual([
      ['keep', 'Title keep'],
      ['change', 'New'],
      ['remove', 'Title remove'],
      ['add', 'Title add'],
    ]);
    should(removal.map(entry => entry.id)).deepEqual(['keep', 'change']);
    should(none).deepEqual(before);
  });
});

describe('routingChanged', () => {
  it('should be true for a new routing, or one whose prompt or short line differs', () => {
    should(guide.routingChanged(undefined, routing)).be.true();
    should(guide.routingChanged(routing, routing)).be.false();
    should(guide.routingChanged(routing, { ...routing, short: 'Routing: other.' })).be.true();
    should(guide.routingChanged(routing, { ...routing, prompt: 'Other.' })).be.true();
  });
});
