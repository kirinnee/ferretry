import { describe, it } from 'bun:test';
import should from 'should';
import * as pack from '../../src/lib/pack.ts';
import { INSTANT, sessionView } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const refusal = { code: 'out_of_quota', message: 'claude-auto-x is out of quota.', remedy: 'Try the next candidate.' };
const attempt = { runtime: 'claude-auto-x', model: 'claude-opus-5-5', outcome: 'started', probe: 'ran', probeMs: 812 };
const prompt =
  'Plans and reviews on claude-opus-5-5 at max; chores on claude-haiku-5-5 low; gpt-6-astra when Claude is low.';
const suggested = { by: 'gpt-oss-120b', via: 'claude-auto-x', at: INSTANT, acceptedAt: INSTANT };
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
const option = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  modelLabel: 'Claude Opus 5.5',
  harness: 'claude',
  tier: 'best',
  efforts: ['low', 'high', 'max'],
  runtime: 'claude-auto-x',
  runtimes: 2,
  ready: true,
  quota,
  named: 1,
  effort: 'max',
  command:
    'fy new --runtime claude-auto-x --model claude-opus-5-5 --effort max --name "<short task title>" "<complete brief>"',
};
const routing = { text: prompt, source: 'file', suggested };
const job = {
  id: 'run-1',
  session: 's9',
  name: 'gonzalo',
  runtime: 'claude-auto-x',
  model: 'claude-opus-5-5',
  startedAt: INSTANT,
  status: 'failed',
  message: 'The clean-up stopped without writing a prompt.',
};

const cases: SchemaCase[] = [
  { name: 'decision mode', schema: pack.PackDecisionModeSchema, value: 'jev' },
  { name: 'limits', schema: pack.PackLimitsSchema, value: pack.DEFAULT_PACK_CONFIG.limits },
  { name: 'probe', schema: pack.PackProbeSchema, value: pack.DEFAULT_PACK_CONFIG.probe },
  { name: 'jev', schema: pack.PackJevSchema, value: { usdPerDay: 0.5 } },
  { name: 'config', schema: pack.PackConfigSchema, value: pack.DEFAULT_PACK_CONFIG },
  { name: 'file', schema: pack.PackFileSchema, value: { decision: 'jev', limits: { maxDepth: 3 } } },
  {
    name: 'a file not yet migrated, with the old preferences',
    schema: pack.PackFileSchema,
    value: { routingPreferences: 'Opus for reviews.' },
  },
  { name: 'routing prompt', schema: pack.RoutingPromptSchema, value: prompt },
  { name: 'suggested', schema: pack.RoutingSuggestedSchema, value: suggested },
  { name: 'guide file', schema: pack.ModelsGuideFileSchema, value: { prompt, suggested } },
  {
    name: 'a guide file not yet migrated, with the old keys',
    schema: pack.ModelsGuideFileSchema,
    value: {
      useCases: [{ id: 'bulk', title: 'Bulk', candidates: [] }],
      routing: { prompt: 'Opus first.', short: 'Routing: x.' },
      models: [{ provider: 'zai', model: 'glm-5.3', description: 'Cheap.' }],
      suggested: { ...suggested, partial: true },
    },
  },
  { name: 'routing view', schema: pack.RoutingPromptViewSchema, value: routing },
  { name: 'undo', schema: pack.RoutingUndoSchema, value: { savedAt: INSTANT, source: 'default' } },
  { name: 'clean-up job', schema: pack.PackCleanUpJobSchema, value: job },
  {
    name: 'clean-up status',
    schema: pack.PackCleanUpStatusSchema,
    value: { available: false, runtimes: [], reason: 'No runtime can start a ferret now.', job },
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
  { name: 'model option', schema: pack.PackModelOptionSchema, value: option },
  {
    name: 'model option that cannot start',
    schema: pack.PackModelOptionSchema,
    value: {
      model: 'glm-5.3',
      modelLabel: 'GLM-5.3',
      harness: 'claude',
      efforts: [],
      runtime: 'claude-zai',
      runtimes: 1,
      ready: false,
      refusal,
      quota,
    },
  },
  {
    name: 'view',
    schema: pack.PackViewSchema,
    value: {
      config: pack.DEFAULT_PACK_CONFIG,
      routing: { text: prompt, source: 'default' },
      models: [],
      available: [],
      cleanUp: { available: true, runtimes: ['claude-auto-x'] },
    },
  },
  {
    name: 'view with undo',
    schema: pack.PackViewSchema,
    value: {
      config: pack.DEFAULT_PACK_CONFIG,
      routing,
      models: [],
      available: [option],
      undo: { savedAt: INSTANT, source: 'file' },
      cleanUp: { available: true, runtimes: ['claude-auto-x'], job: { ...job, status: 'suggested' } },
    },
  },
  { name: 'refusal code', schema: pack.PackRefusalCodeSchema, value: 'probe_failed' },
  { name: 'refusal', schema: pack.PackRefusalSchema, value: refusal },
  { name: 'recommend request', schema: pack.PackRecommendRequestSchema, value: { task: 'rename a symbol' } },
  {
    name: 'recommendation',
    schema: pack.PackRecommendationSchema,
    value: { task: 'plan it', routing, available: [option], next: option.command },
  },
  {
    name: 'recommendation with nothing usable',
    schema: pack.PackRecommendationSchema,
    value: { routing: { text: prompt, source: 'default' }, available: [] },
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
    value: { task: 'do it', auto: true, allowScratch: true },
  },
  { name: 'attempt', schema: pack.PackAttemptSchema, value: attempt },
  {
    name: 'started',
    schema: pack.PackNewOutcomeSchema,
    value: {
      outcome: 'started',
      view: sessionView,
      decidedBy: 'routing',
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
      { name: 'neither runtime nor auto', schema: pack.PackNewRequestSchema, value: { task: 'x' } },
      {
        name: 'auto with a runtime',
        schema: pack.PackNewRequestSchema,
        value: { task: 'x', auto: true, runtime: 'r' },
      },
      {
        name: 'the old use-case pick',
        schema: pack.PackNewRequestSchema,
        value: { task: 'x', auto: true, useCase: 'bulk' },
      },
      { name: 'an unknown code', schema: pack.PackRefusalCodeSchema, value: 'busy' },
      { name: 'a blank prompt', schema: pack.RoutingPromptSchema, value: '   ' },
      {
        name: 'a prompt too long for the system prompt',
        schema: pack.RoutingPromptSchema,
        value: 'x'.repeat(pack.MAX_ROUTING_PROMPT_CHARS + 1),
      },
      { name: 'an unknown guide key', schema: pack.ModelsGuideFileSchema, value: { short: 'Routing: x.' } },
      { name: 'an unknown quota state', schema: pack.PackQuotaStateSchema, value: 'full' },
      { name: 'more than all left', schema: pack.PackQuotaWindowSchema, value: { label: '5h', leftPercent: 101 } },
    ]);
  });

  it('should hold the routing prompt to a paragraph that fits every system prompt', () => {
    should(pack.MAX_ROUTING_PROMPT_CHARS).equal(1_200);
    should(pack.MAX_ROUGH_PROMPT_CHARS).be.above(pack.MAX_ROUTING_PROMPT_CHARS);
  });
});

describe('isLegacyModelsGuide', () => {
  it('should say a file with any of the old keys still has a migration to run', () => {
    should(pack.isLegacyModelsGuide({ useCases: [] })).be.true();
    should(pack.isLegacyModelsGuide({ routing: { prompt: 'x', short: 'y' } })).be.true();
    should(pack.isLegacyModelsGuide({ models: [] })).be.true();
  });

  it('should say a file of the one routing prompt, or none, has nothing to migrate', () => {
    should(pack.isLegacyModelsGuide({})).be.false();
    should(pack.isLegacyModelsGuide({ prompt, suggested })).be.false();
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

  it('should ignore the old routing preferences: only the migration reads them', () => {
    should(pack.packConfigFromFile({ routingPreferences: 'Opus for reviews.' })).deepEqual(pack.DEFAULT_PACK_CONFIG);
  });

  it('should start from a guide file with no prompt, so the rendered one is in effect', () => {
    should(pack.DEFAULT_MODELS_GUIDE_FILE).deepEqual({});
    should(pack.PACK_REFUSAL_CODES).containEql('limit_reached');
    should(pack.PACK_REFUSAL_CODES).containEql('scratch_cwd');
  });
});
