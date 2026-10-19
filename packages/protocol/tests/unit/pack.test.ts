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
const attempt = { runtime: 'claude-auto-x', model: 'claude-opus-5-5', outcome: 'started', probeMs: 812 };

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
  { name: 'guide', schema: pack.ModelsGuideSchema, value: { source: 'derived', useCases: [useCase] } },
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
  { name: 'refusal code', schema: pack.PackRefusalCodeSchema, value: 'probe_failed' },
  { name: 'refusal', schema: pack.PackRefusalSchema, value: refusal },
  { name: 'recommend request', schema: pack.PackRecommendRequestSchema, value: { task: 'rename a symbol', useCase: 'bulk' } },
  { name: 'candidate view', schema: pack.PackCandidateSchema, value: ready },
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
    name: 'new request',
    schema: pack.PackNewRequestSchema,
    value: { task: 'do it', parent: 'p', runtime: 'claude-auto-x', model: 'm', effort: 'low', cwd: '/w', name: 'Do It', mode: 'auto' },
  },
  { name: 'automatic new request', schema: pack.PackNewRequestSchema, value: { task: 'do it', auto: true, useCase: 'bulk' } },
  { name: 'attempt', schema: pack.PackAttemptSchema, value: attempt },
  {
    name: 'started',
    schema: pack.PackNewOutcomeSchema,
    value: { outcome: 'started', view: sessionView, decidedBy: 'guide', attempts: [attempt], note: 'Jev was over its cap.' },
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
      { name: 'depth zero', schema: pack.PackLimitsSchema, value: { interactiveChildren: 1, autoChildren: 1, maxDepth: 0 } },
      { name: 'a probe too short', schema: pack.PackProbeSchema, value: { timeoutSeconds: 1, cacheSeconds: 0 } },
      { name: 'an upper-case id', schema: pack.GuideUseCaseIdSchema, value: 'Bulk' },
      { name: 'a blank why', schema: pack.GuideCandidateSchema, value: { ...candidate, why: '  ' } },
      {
        name: 'a use case twice',
        schema: pack.ModelsGuideFileSchema,
        value: { useCases: [useCase, { ...useCase, title: 'Again' }] },
      },
      { name: 'neither runtime nor auto', schema: pack.PackNewRequestSchema, value: { task: 'x' } },
      { name: 'auto with a runtime', schema: pack.PackNewRequestSchema, value: { task: 'x', auto: true, runtime: 'r' } },
      { name: 'an unknown code', schema: pack.PackRefusalCodeSchema, value: 'busy' },
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

  it('should start from a guide file that names no use case, so the derived guide is in effect', () => {
    should(pack.DEFAULT_MODELS_GUIDE_FILE).deepEqual({});
    should(pack.PACK_REFUSAL_CODES).containEql('limit_reached');
  });
});
