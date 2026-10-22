import { describe, it } from 'bun:test';
import should from 'should';
import * as pack from '../../src/lib/pack.ts';
import { INSTANT, sessionView } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const candidate = { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', why: 'The strongest planner.' };
const useCase = {
  id: 'plan-review',
  title: 'Hard planning, review, critical code',
  description: 'Plans and reviews; claude-opus-5-5 first.',
  keywords: ['plan', 'review'],
  candidates: [candidate, { provider: 'openai', model: 'gpt-6-astra', harness: 'codex', why: 'A second family.' }],
};
const refusal = { code: 'out_of_quota', message: 'claude-auto-x is out of quota.', remedy: 'Try the next candidate.' };
const ready = {
  rank: 1,
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  modelLabel: 'Claude Opus 5.5',
  harness: 'claude',
  effort: 'high',
  why: 'The strongest planner.',
  runtime: 'claude-auto-x',
  ready: true,
};
const attempt = { runtime: 'claude-auto-x', model: 'claude-opus-5-5', outcome: 'started', probe: 'ran', probeMs: 812 };
const routing = {
  prompt: 'Plans and reviews on claude-opus-5-5; gpt-6-astra when it is low.',
  short: 'Routing: plan-review → claude-opus-5-5 max; bulk → glm-5-air low.',
};
const suggested = { by: 'gpt-oss-120b', via: 'claude-auto-x', at: INSTANT, acceptedAt: INSTANT, partial: true };
const quota = {
  state: 'low',
  leftPercent: 9,
  tightest: 'week',
  windows: [
    { label: '5h', usedPercent: 10, leftPercent: 90 },
    { label: 'week', usedPercent: 91, leftPercent: 9, resetsAt: INSTANT },
    { label: 'month', usedPercent: 0, leftPercent: 100, reset: true },
  ],
  measuredAt: INSTANT,
  summary: '5h 10% · wk 91% · mo 0%',
};

const cases: SchemaCase[] = [
  { name: 'decision mode', schema: pack.PackDecisionModeSchema, value: 'jev' },
  { name: 'limits', schema: pack.PackLimitsSchema, value: pack.DEFAULT_PACK_CONFIG.limits },
  { name: 'probe', schema: pack.PackProbeSchema, value: pack.DEFAULT_PACK_CONFIG.probe },
  { name: 'jev', schema: pack.PackJevSchema, value: { usdPerDay: 0.5 } },
  { name: 'config', schema: pack.PackConfigSchema, value: pack.DEFAULT_PACK_CONFIG },
  { name: 'file', schema: pack.PackFileSchema, value: { decision: 'jev', limits: { maxDepth: 3 } } },
  { name: 'use case id', schema: pack.GuideUseCaseIdSchema, value: 'long-context' },
  { name: 'candidate', schema: pack.GuideCandidateSchema, value: candidate },
  { name: 'use case', schema: pack.GuideUseCaseSchema, value: useCase },
  { name: 'guide file', schema: pack.ModelsGuideFileSchema, value: { useCases: [useCase] } },
  {
    name: 'guide file with routing and where it came from',
    schema: pack.ModelsGuideFileSchema,
    value: { useCases: [useCase], routing, suggested },
  },
  { name: 'routing', schema: pack.GuideRoutingSchema, value: routing },
  { name: 'routing preferences', schema: pack.RoutingPreferencesSchema, value: 'Opus for reviews; GLM for bulk.' },
  {
    name: 'model description',
    schema: pack.ModelDescriptionSchema,
    value: { provider: 'zai', model: 'glm-5.3', description: 'Cheap and fast; weak at long plans.' },
  },
  {
    name: 'guide file with descriptions',
    schema: pack.ModelsGuideFileSchema,
    value: { models: [{ provider: 'zai', model: 'glm-5.3', description: 'Cheap.' }] },
  },
  { name: 'undo', schema: pack.GuideUndoSchema, value: { savedAt: INSTANT, source: 'derived' } },
  {
    name: 'builder job',
    schema: pack.PackGuideJobSchema,
    value: {
      id: 'run-1',
      session: 's9',
      name: 'gonzalo',
      runtime: 'claude-auto-x',
      model: 'claude-opus-5-5',
      startedAt: INSTANT,
      status: 'failed',
      message: 'The builder stopped without writing a guide.',
    },
  },
  {
    name: 'builder',
    schema: pack.PackGuideBuilderSchema,
    value: { available: false, runtimes: [], reason: 'No runtime can start a ferret now.' },
  },
  { name: 'suggested', schema: pack.GuideSuggestedSchema, value: suggested },
  { name: 'guide', schema: pack.ModelsGuideSchema, value: { source: 'derived', useCases: [useCase] } },
  {
    name: 'guide with routing',
    schema: pack.ModelsGuideSchema,
    value: { source: 'file', useCases: [useCase], routing: { ...routing, source: 'file' }, suggested },
  },
  { name: 'quota state', schema: pack.PackQuotaStateSchema, value: 'exhausted' },
  { name: 'quota window', schema: pack.PackQuotaWindowSchema, value: quota.windows[1] },
  { name: 'quota', schema: pack.PackQuotaSchema, value: quota },
  {
    name: 'fleet model',
    schema: pack.PackFleetModelSchema,
    value: {
      provider: 'zai',
      providerLabel: 'GLM / Z.ai',
      harness: 'claude',
      id: 'glm-5.3',
      label: 'GLM-5.3',
      tier: 'best',
      context: 1_000_000,
      efforts: ['low', 'high'],
      runtimes: [],
    },
  },
  {
    name: 'view',
    schema: pack.PackViewSchema,
    value: { config: pack.DEFAULT_PACK_CONFIG, guide: { source: 'file', useCases: [] }, models: [] },
  },
  {
    name: 'view with undo and the builder',
    schema: pack.PackViewSchema,
    value: {
      config: { ...pack.DEFAULT_PACK_CONFIG, routingPreferences: 'Opus for reviews.' },
      guide: { source: 'file', useCases: [] },
      models: [],
      undo: { savedAt: INSTANT, source: 'file' },
      builder: { available: true, runtimes: ['claude-auto-x'] },
    },
  },
  { name: 'refusal code', schema: pack.PackRefusalCodeSchema, value: 'probe_failed' },
  { name: 'refusal', schema: pack.PackRefusalSchema, value: refusal },
  {
    name: 'recommend request',
    schema: pack.PackRecommendRequestSchema,
    value: { task: 'rename a symbol', useCase: 'bulk' },
  },
  { name: 'candidate view', schema: pack.PackCandidateSchema, value: ready },
  {
    name: 'candidate moved down by quota',
    schema: pack.PackCandidateSchema,
    value: { ...ready, quota, movedDown: 'claude-auto-x, 91% of the week used' },
  },
  {
    name: 'recommendation',
    schema: pack.PackRecommendationSchema,
    value: {
      task: 'plan it',
      useCase: { id: 'plan-review', title: 'Planning', matchedBy: 'words' },
      guideSource: 'derived',
      candidates: [ready, { ...ready, rank: 2, runtime: undefined, ready: false, refusal }],
      next: 'fy new --runtime claude-auto-x --model claude-opus-5-5 "plan it"',
    },
  },
  {
    name: 'recommendation from an accepted suggestion',
    schema: pack.PackRecommendationSchema,
    value: {
      task: 'plan it',
      useCase: { id: 'plan-review', title: 'Planning', matchedBy: 'named' },
      guideSource: 'file',
      guideSuggested: suggested,
      routing: routing.prompt,
      candidates: [{ ...ready, quota }],
    },
  },
  {
    name: 'new request',
    schema: pack.PackNewRequestSchema,
    value: {
      task: 'do it',
      parent: 'p',
      runtime: 'claude-auto-x',
      model: 'm',
      effort: 'low',
      cwd: '/w',
      name: 'Do It',
      mode: 'auto',
    },
  },
  {
    name: 'automatic new request',
    schema: pack.PackNewRequestSchema,
    value: { task: 'do it', auto: true, useCase: 'bulk', allowScratch: true },
  },
  { name: 'attempt', schema: pack.PackAttemptSchema, value: attempt },
  {
    name: 'started',
    schema: pack.PackNewOutcomeSchema,
    value: {
      outcome: 'started',
      view: sessionView,
      decidedBy: 'guide',
      attempts: [attempt],
      note: 'Jev was over its cap.',
    },
  },
  {
    name: 'refused',
    schema: pack.PackNewOutcomeSchema,
    value: { outcome: 'refused', refusal, attempts: [{ runtime: 'r', outcome: 'refused', refusal }] },
  },
  {
    name: 'result',
    schema: pack.SessionResultSchema,
    value: { id: 's', status: 'completed', finished: true, finishedAt: INSTANT, summary: 'Done: 3 files.' },
  },
  { name: 'pack switch', schema: pack.SessionPackPatchSchema, value: { enabled: false } },
  {
    name: 'pack switch result',
    schema: pack.SessionPackPatchResultSchema,
    value: { view: sessionView, restartRequired: true, note: 'Pack mode is off from the next launch.' },
  },
];

describe('pack schemas', () => {
  it('should round-trip every valid value and cover every exported schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(pack, cases);
  });

  it('should refuse what a caller or an editor could get wrong', () => {
    assertRejects([
      { name: 'an unknown key', schema: pack.PackFileSchema, value: { turbo: true } },
      {
        name: 'depth zero',
        schema: pack.PackLimitsSchema,
        value: { interactiveChildren: 1, autoChildren: 1, maxDepth: 0 },
      },
      { name: 'a probe too short', schema: pack.PackProbeSchema, value: { timeoutSeconds: 1, cacheSeconds: 0 } },
      { name: 'an upper-case id', schema: pack.GuideUseCaseIdSchema, value: 'Bulk' },
      { name: 'a blank why', schema: pack.GuideCandidateSchema, value: { ...candidate, why: '  ' } },
      {
        name: 'a use case twice',
        schema: pack.ModelsGuideFileSchema,
        value: { useCases: [useCase, { ...useCase, title: 'Again' }] },
      },
      { name: 'neither runtime nor auto', schema: pack.PackNewRequestSchema, value: { task: 'x' } },
      {
        name: 'auto with a runtime',
        schema: pack.PackNewRequestSchema,
        value: { task: 'x', auto: true, runtime: 'r' },
      },
      { name: 'an unknown code', schema: pack.PackRefusalCodeSchema, value: 'busy' },
      {
        name: 'a routing line with a quote',
        schema: pack.GuideRoutingSchema,
        value: { ...routing, short: 'say "hi"' },
      },
      {
        name: 'a routing line with a backslash',
        schema: pack.GuideRoutingSchema,
        value: { ...routing, short: 'a\\b' },
      },
      { name: 'a routing line of two lines', schema: pack.GuideRoutingSchema, value: { ...routing, short: 'a\nb' } },
      {
        name: 'a routing line too long for the system prompt',
        schema: pack.GuideRoutingSchema,
        value: { ...routing, short: 'x'.repeat(pack.MAX_ROUTING_SHORT_CHARS + 1) },
      },
      { name: 'an unknown quota state', schema: pack.PackQuotaStateSchema, value: 'full' },
      {
        name: 'a model described twice',
        schema: pack.ModelsGuideFileSchema,
        value: {
          models: [
            { provider: 'zai', model: 'glm-5.3', description: 'a' },
            { provider: 'zai', model: 'glm-5.3', description: 'b' },
          ],
        },
      },
      { name: 'preferences too long', schema: pack.RoutingPreferencesSchema, value: 'x'.repeat(4_001) },
      { name: 'more than all left', schema: pack.PackQuotaWindowSchema, value: { label: '5h', leftPercent: 101 } },
    ]);
  });

  it('should name the duplicate use case where it is', () => {
    // Act
    const actual = pack.ModelsGuideFileSchema.safeParse({ useCases: [useCase, useCase] });

    // Assert
    should(actual.success).be.false();
    should(actual.error?.issues[0]?.path).deepEqual(['useCases', 1, 'id']);
  });
});

describe('packConfigFromFile', () => {
  it('should be the defaults for an empty file: on, the agent decides, 20 / 4 / depth 2', () => {
    should(pack.packConfigFromFile({})).deepEqual(pack.DEFAULT_PACK_CONFIG);
    should(pack.DEFAULT_PACK_CONFIG.limits).deepEqual({ interactiveChildren: 20, autoChildren: 4, maxDepth: 2 });
    should(pack.DEFAULT_PACK_CONFIG.decision).equal('agent');
  });

  it('should take each setting the file names and keep the rest of its section', () => {
    // Act
    const actual = pack.packConfigFromFile({
      enabled: false,
      decision: 'jev',
      limits: { autoChildren: 2 },
      probe: { cacheSeconds: 0 },
      jev: { usdPerDay: 1 },
    });

    // Assert
    should(actual).deepEqual({
      enabled: false,
      decision: 'jev',
      limits: { interactiveChildren: 20, autoChildren: 2, maxDepth: 2 },
      probe: { timeoutSeconds: 45, cacheSeconds: 0 },
      jev: { usdPerDay: 1 },
    });
  });

  it('should carry routing preferences that say something, and leave out empty ones', () => {
    should(pack.packConfigFromFile({ routingPreferences: 'Opus for reviews.' }).routingPreferences).equal(
      'Opus for reviews.',
    );
    should(pack.packConfigFromFile({ routingPreferences: '' })).deepEqual(pack.DEFAULT_PACK_CONFIG);
  });

  it('should start from a guide file that names no use case, so the derived guide is in effect', () => {
    should(pack.DEFAULT_MODELS_GUIDE_FILE).deepEqual({});
    should(pack.PACK_REFUSAL_CODES).containEql('limit_reached');
    should(pack.PACK_REFUSAL_CODES).containEql('scratch_cwd');
  });
});
