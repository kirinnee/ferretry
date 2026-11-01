import { describe, it } from 'bun:test';
import should from 'should';
import { DEFAULT_WARDEN_CONFIG } from '../../src/lib/config-files.ts';
import { displaySystemCallsign, isSystemCallsign } from '../../src/lib/system-callsigns.ts';
import * as warden from '../../src/lib/warden.ts';
import {
  INSTANT,
  wardenAgendaView,
  wardenConfig,
  wardenConfigView,
  wardenInvestigateView,
  wardenRunView,
  wardenStatusView,
} from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const anomaly = {
  kind: 'sus_thinking',
  sessionId: 'session-1',
  status: 'thinking',
  detail: 'tokens stopped',
};

const dayStats = {
  day: '2026-10-16',
  flags: 12,
  jevDecisions: 9,
  investigations: 2,
  jevUsd: 0.12,
  investigationUsd: 0.6,
  moved: { auto: 1, jev: 3, llm: 1 },
  cleared: { auto: 0, jev: 4, llm: 1, owner: 1 },
  stopped: { auto: 0, jev: 0, llm: 1 },
  asked: { auto: 1, jev: 0, llm: 0 },
};

const actionTally = { action: 'revive', outcome: 'done', auto: 2, jev: 1, llm: 0 };
const reviveResults = { progressed: { auto: 2, jev: 1, llm: 0 }, stalled: { auto: 0, jev: 0, llm: 1 } };

const jevCheck = {
  at: INSTANT,
  sessionId: 'session-1',
  anomalyKind: 'sus_thinking',
  verdict: 'handed_on',
  act: 'restart',
  why: 'not_sure_enough',
  route: 'investigation',
  confidence: 0.21,
  costUsd: 0.0004,
};

/** The decision tree's path to a hand-on: two facts, then Jev's one answer below the bar. */
const jevPath = [
  { node: 'running', kind: 'fact', answer: 'yes' },
  { node: 'output_changed', kind: 'fact', answer: 'no' },
  { node: 'waiting_on_real', kind: 'judgement', answer: 'no', confidence: 0.21 },
  { node: 'dialog_on_screen', kind: 'fact', answer: 'no' },
];

const jevBefore = {
  verdict: 'handed_on',
  why: 'not_sure_enough',
  act: 'restart',
  at: INSTANT,
  confidence: 0.21,
  costUsd: 0.0004,
};

const jevDay = { checks: 9, healthy: 4, acted: 3, handedOn: 2, skippedForCap: 5 };

const wardenVerdict = {
  at: INSTANT,
  verdict: 'needs_human',
  reportPath: '/state/reports/warden-1.md',
  recommendation: { action: 'nudge', reason: 'The session has stalled.', agent: 'warden' },
  spawn: {
    agent: 'warden',
    model: 'gpt-5',
    modelSource: 'configured',
    harness: 'codex',
    failedOver: false,
    policy: 'fallback',
    selection: 'preferred',
    configuredFirst: 'warden',
    skipped: {},
  },
};

const investigation = {
  id: 'warden-7',
  state: 'done',
  scope: 'session',
  origin: 'jev',
  targetSession: 'session-1',
  anomalyKind: 'sus_thinking',
  wardenSession: 'warden-7',
  startedAt: INSTANT,
  finishedAt: INSTANT,
  reportPath: '/state/reports/warden-1.md',
  verdict: 'revived',
  costUsd: 0.31,
  agent: 'claude-default',
  model: 'opus',
};

const action = {
  at: INSTANT,
  sessionId: 'session-1',
  action: 'bless',
  outcome: 'done',
  by: 'jev',
  anomalyKind: 'sus_thinking',
  detail: 'Jev was 96% sure it is healthy: long think blessed for 15 min.',
  confidence: 0.96,
};

const agendaItem = wardenAgendaView.items[0];

const wardenCases: SchemaCase[] = [
  { name: 'policy', schema: warden.WardenFailoverPolicySchema, value: 'fallback' },
  { name: 'account', schema: warden.WardenAccountSchema, value: wardenConfig.accounts[0] },
  { name: 'failover', schema: warden.WardenFailoverConfigSchema, value: wardenConfig.failover },
  { name: 'provider outage', schema: warden.ProviderOutageConfigSchema, value: wardenConfig.providerOutage },
  { name: 'layers', schema: warden.WardenLayersSchema, value: wardenConfig.layers },
  { name: 'legacy triage', schema: warden.LegacyWardenTriageSchema, value: 'jev' },
  { name: 'sweep interval', schema: warden.WardenSweepIntervalSchema, value: 2 },
  { name: 'guard', schema: warden.WardenGuardConfigSchema, value: wardenConfig.guard },
  { name: 'caps', schema: warden.WardenCapsSchema, value: wardenConfig.caps },
  { name: 'may act alone', schema: warden.WardenMayActAloneSchema, value: wardenConfig.mayActAlone },
  { name: 'jev acts', schema: warden.WardenJevActsSchema, value: wardenConfig.jevActs },
  { name: 'revive', schema: warden.WardenReviveConfigSchema, value: wardenConfig.revive },
  { name: 'auto migrate', schema: warden.WardenAutoMigrateConfigSchema, value: wardenConfig.autoMigrate },
  { name: 'auto migrate trigger', schema: warden.WardenAutoMigrateTriggerSchema, value: 'budget_exceeded' },
  { name: 'events', schema: warden.WardenEventTriggersSchema, value: wardenConfig.events },
  { name: 'effort', schema: warden.WardenEffortSchema, value: 'medium' },
  { name: 'investigation', schema: warden.WardenInvestigationConfigSchema, value: wardenConfig.investigation },
  { name: 'config', schema: warden.WardenConfigSchema, value: wardenConfig },
  { name: 'patch', schema: warden.WardenConfigPatchSchema, value: { enabled: false, caps: { jevUsdPerDay: 1 } } },
  { name: 'anomaly kind', schema: warden.WardenAnomalyKindSchema, value: 'owner_request' },
  { name: 'liveness ledger', schema: warden.LivenessLedgerSchema, value: { lastTranscriptAt: INSTANT } },
  { name: 'anomaly', schema: warden.WardenAnomalySchema, value: anomaly },
  {
    name: 'failover account view',
    schema: warden.WardenFailoverAccountViewSchema,
    value: { agent: 'agent', eligible: true },
  },
  {
    name: 'failover status',
    schema: warden.WardenFailoverStatusSchema,
    value: { policy: 'fallback', failureThreshold: 2, cooldownMinutes: 5, accounts: [] },
  },
  { name: 'config view', schema: warden.WardenConfigViewSchema, value: wardenConfigView },
  { name: 'login source', schema: warden.WardenLoginSourceSchema, value: 'machine_default' },
  {
    name: 'login',
    schema: warden.WardenLoginSchema,
    value: { source: 'configured', unknown: ['legacy-wrapper'], available: ['claude-default'] },
  },
  { name: 'verdict kind', schema: warden.WardenVerdictKindSchema, value: 'needs_human' },
  { name: 'recommended action', schema: warden.WardenRecommendedActionSchema, value: 'nudge' },
  { name: 'recommendation', schema: warden.WardenRecommendationSchema, value: wardenVerdict.recommendation },
  { name: 'verdict spawn', schema: warden.WardenVerdictSpawnSchema, value: wardenVerdict.spawn },
  { name: 'verdict', schema: warden.WardenVerdictSchema, value: wardenVerdict },
  { name: 'verdicts', schema: warden.WardenVerdictsViewSchema, value: [wardenVerdict] },
  { name: 'triage reason', schema: warden.WardenTriageReasonSchema, value: 'jev_cap' },
  { name: 'guard failure', schema: warden.WardenGuardFailureCodeSchema, value: 'not_set' },
  {
    name: 'layer status',
    schema: warden.WardenLayerStatusSchema,
    value: { configured: true, active: false, reason: 'investigation_cap' },
  },
  { name: 'cap', schema: warden.WardenCapSchema, value: 'investigation' },
  {
    name: 'triage status',
    schema: warden.WardenTriageStatusSchema,
    value: {
      jev: { configured: true, active: false, reason: 'jev_cap' },
      llm: { configured: true, active: true, reason: 'configured' },
      guardFailure: { code: 'rate_limited', at: INSTANT },
      guardBackoffUntil: INSTANT,
    },
  },
  { name: 'spend day', schema: warden.WardenSpendDaySchema, value: '2026-10-16' },
  {
    name: 'spend',
    schema: warden.WardenSpendSchema,
    value: { ...wardenStatusView.spend, capsHit: ['jev', 'investigation'] },
  },
  {
    name: 'savings',
    schema: warden.WardenSavingsSchema,
    value: { ...wardenStatusView.savings, averageInvestigationUsd: 0.3, savedUsd: 11 },
  },
  { name: 'investigation state', schema: warden.WardenInvestigationStateSchema, value: 'queued' },
  { name: 'investigation origin', schema: warden.WardenInvestigationOriginSchema, value: 'owner' },
  { name: 'investigation record', schema: warden.WardenInvestigationSchema, value: investigation },
  { name: 'action kind', schema: warden.WardenActionKindSchema, value: 'failover' },
  { name: 'action outcome', schema: warden.WardenActionOutcomeSchema, value: 'held' },
  { name: 'action', schema: warden.WardenActionSchema, value: action },
  { name: 'cleared by', schema: warden.WardenClearedBySchema, value: 'owner' },
  { name: 'actor', schema: warden.WardenActorSchema, value: 'llm' },
  { name: 'outcome', schema: warden.WardenOutcomeSchema, value: 'moved' },
  { name: 'actor counts', schema: warden.WardenActorCountsSchema, value: dayStats.moved },
  { name: 'day stats', schema: warden.WardenDayStatsSchema, value: dayStats },
  { name: 'day stats with Jev checks', schema: warden.WardenDayStatsSchema, value: { ...dayStats, jev: jevDay } },
  { name: 'stat action', schema: warden.WardenStatActionSchema, value: 'escalate' },
  { name: 'action tally', schema: warden.WardenActionTallySchema, value: actionTally },
  { name: 'revive results', schema: warden.WardenReviveResultsSchema, value: reviveResults },
  {
    name: 'day stats with action tallies',
    schema: warden.WardenDayStatsSchema,
    value: { ...dayStats, acts: [actionTally], reviveResults },
  },
  { name: 'jev day stats', schema: warden.WardenJevDayStatsSchema, value: jevDay },
  { name: 'jev check verdict', schema: warden.WardenJevCheckVerdictSchema, value: 'skipped' },
  { name: 'jev check why', schema: warden.WardenJevCheckWhySchema, value: 'jev_cap' },
  { name: 'jev check route', schema: warden.WardenJevCheckRouteSchema, value: 'owner' },
  { name: 'jev check', schema: warden.WardenJevCheckSchema, value: jevCheck },
  {
    name: 'jev check with its tree path',
    schema: warden.WardenJevCheckSchema,
    value: { ...jevCheck, path: jevPath, node: 'waiting_on_real' },
  },
  { name: 'jev path step', schema: warden.WardenJevPathStepSchema, value: jevPath[2] },
  { name: 'jev path', schema: warden.WardenJevPathSchema, value: jevPath },
  { name: 'jev before why', schema: warden.WardenJevBeforeWhySchema, value: 'owner_request' },
  { name: 'jev before', schema: warden.WardenJevBeforeSchema, value: jevBefore },
  {
    name: 'jev before with its tree path',
    schema: warden.WardenJevBeforeSchema,
    value: { ...jevBefore, path: jevPath, node: 'waiting_on_real' },
  },
  {
    name: 'blessing',
    schema: warden.WardenBlessingViewSchema,
    value: {
      sessionId: 'session-1',
      kinds: ['sus_thinking'],
      expiresAt: INSTANT,
      by: 'owner',
      streak: 2,
      untilChange: true,
    },
  },
  {
    name: 'status',
    schema: warden.WardenStatusViewSchema,
    value: {
      ...wardenStatusView,
      nextSweepAt: INSTANT,
      investigations: [{ ...investigation, wardenName: 'warden-00002a', jev: jevBefore }],
      actions: [action, { ...action, actor: 'llm', investigator: 'warden-00002a', jev: { verdict: 'off' } }],
      history: [dayStats],
      jevChecks: [jevCheck],
    },
  },
  { name: 'run', schema: warden.WardenRunViewSchema, value: wardenRunView },
  { name: 'run request', schema: warden.WardenRunRequestSchema, value: { spawn: true } },
  { name: 'investigate request', schema: warden.WardenInvestigateRequestSchema, value: { sessionId: 's' } },
  { name: 'investigate view', schema: warden.WardenInvestigateViewSchema, value: wardenInvestigateView },
  { name: 'leave duration', schema: warden.WardenLeaveDurationSchema, value: 'until_change' },
  { name: 'leave request', schema: warden.WardenLeaveRequestSchema, value: { sessionId: 's', duration: '4h' } },
  {
    name: 'leave view',
    schema: warden.WardenLeaveViewSchema,
    value: {
      blessing: { sessionId: 's', kinds: ['sus_thinking'], expiresAt: INSTANT, by: 'owner' },
      message: 'Left alone for 4 h.',
    },
  },
  { name: 'judgement state', schema: warden.WardenJudgementStateSchema, value: 'pending' },
  { name: 'judge provenance', schema: warden.WardenJudgeProvenanceSchema, value: { agent: 'a', model: 'm' } },
  {
    name: 'judgement',
    schema: warden.WardenJudgementSchema,
    value: { state: 'judged', verdict: 'needs_human', reason: 'blocked', at: INSTANT, stale: false },
  },
  { name: 'attention item', schema: warden.FleetAgendaItemSchema, value: agendaItem },
  { name: 'attention outcome', schema: warden.WardenAgendaOutcomeSchema, value: 'degraded' },
  { name: 'attention view', schema: warden.WardenAgendaViewSchema, value: wardenAgendaView },
];

describe('warden schemas', () => {
  it('should round-trip every public warden schema', () => {
    // Arrange
    const cases = wardenCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(warden, cases);
  });

  it('should refuse settings that would spend or act outside their bounds', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'threshold too low',
        schema: warden.WardenGuardConfigSchema,
        value: { ...wardenConfig.guard, threshold: 0.29 },
      },
      {
        name: 'threshold too high',
        schema: warden.WardenGuardConfigSchema,
        value: { ...wardenConfig.guard, threshold: 0.99 },
      },
      {
        name: 'plain http endpoint',
        schema: warden.WardenGuardConfigSchema,
        value: { ...wardenConfig.guard, endpoint: 'http://api.typesafe.ai/v1/systemone' },
      },
      { name: 'zero cap', schema: warden.WardenCapsSchema, value: { ...wardenConfig.caps, jevUsdPerDay: 0 } },
      {
        name: 'huge cap',
        schema: warden.WardenCapsSchema,
        value: { ...wardenConfig.caps, investigationUsdPerDay: 101 },
      },
      {
        name: 'no hourly limit',
        schema: warden.WardenCapsSchema,
        value: { ...wardenConfig.caps, maxInvestigationsPerHour: 0 },
      },
      { name: 'odd interval', schema: warden.WardenSweepIntervalSchema, value: 3 },
      { name: 'unknown patch key', schema: warden.WardenConfigPatchSchema, value: { stopAlways: true } },
      { name: 'unknown nested patch key', schema: warden.WardenConfigPatchSchema, value: { caps: { usd: 1 } } },
      { name: 'blank investigate', schema: warden.WardenInvestigateRequestSchema, value: { sessionId: '  ' } },
      {
        name: 'long note',
        schema: warden.WardenInvestigateRequestSchema,
        value: { sessionId: 's', note: 'x'.repeat(501) },
      },
      { name: 'malformed day', schema: warden.WardenSpendDaySchema, value: '16/10/2026' },
      {
        name: 'a path answer that is not yes or no',
        schema: warden.WardenJevPathStepSchema,
        value: { node: 'running', kind: 'fact', answer: 'maybe' },
      },
      {
        name: 'a confidence beyond certain',
        schema: warden.WardenJevPathStepSchema,
        value: { node: 'waiting_on_real', kind: 'judgement', answer: 'yes', confidence: 1.2 },
      },
      {
        name: 'a path deeper than any tree',
        schema: warden.WardenJevPathSchema,
        value: Array.from({ length: warden.WARDEN_JEV_PATH_MAX + 1 }, () => jevPath[0]),
      },
      { name: 'legacy triage in a patch', schema: warden.WardenConfigPatchSchema, value: { triage: 'jev' } },
      { name: 'unknown layer', schema: warden.WardenConfigPatchSchema, value: { layers: { rules: false } } },
      {
        name: 'unknown leave duration',
        schema: warden.WardenLeaveRequestSchema,
        value: { sessionId: 's', duration: '1d' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});

describe('mergeWardenConfig', () => {
  it('should merge each nested section so one switch never resets its siblings', () => {
    // Arrange
    const patch = { layers: { jev: true }, mayActAlone: { stop: true }, caps: { jevUsdPerDay: 1 } } as const;

    // Act
    const actual = warden.mergeWardenConfig(DEFAULT_WARDEN_CONFIG, patch);

    // Assert
    should(actual.layers).deepEqual({ jev: true, llm: false });
    should(actual.mayActAlone).deepEqual({
      nudge: true,
      resume: true,
      restart: true,
      failover: true,
      stop: true,
      closeLeftovers: true,
    });
    should(actual.caps).deepEqual({ jevUsdPerDay: 1, investigationUsdPerDay: 2, maxInvestigationsPerHour: 6 });
    should(actual.guard).deepEqual(DEFAULT_WARDEN_CONFIG.guard);
  });

  it('should keep a section whose patch entry is absent or not an object', () => {
    // Arrange
    const patch = { events: null, guard: undefined };

    // Act
    const actual = warden.mergeWardenConfig(DEFAULT_WARDEN_CONFIG, patch);

    // Assert
    should(actual.events).deepEqual(DEFAULT_WARDEN_CONFIG.events);
    should(actual.guard).deepEqual(DEFAULT_WARDEN_CONFIG.guard);
  });

  it('should refuse a merge that produces settings the loader would refuse', () => {
    // Arrange
    const patch = { guard: { threshold: 0.29 } };

    // Act
    const act = () => warden.mergeWardenConfig(DEFAULT_WARDEN_CONFIG, patch);

    // Assert
    should(act).throw();
  });
});

describe('legacy triage', () => {
  it('should read each legacy triage as the layers it meant', () => {
    // Arrange
    const { layers: _layers, ...rest } = wardenConfig;
    const cases = [
      ['rules', { jev: false, llm: false }],
      ['llm', { jev: false, llm: true }],
      ['jev', { jev: true, llm: true }],
    ] as const;

    // Act
    const actual = cases.map(([triage]) => warden.WardenConfigSchema.parse({ ...rest, triage }).layers);

    // Assert
    should(actual).deepEqual(cases.map(([, layers]) => layers));
  });

  it('should let an explicit layer win over a legacy triage, field by field', () => {
    // Arrange
    const value = { triage: 'jev', layers: { llm: false } };

    // Act
    const actual = warden.migrateLegacyWardenSettings(value);

    // Assert
    should(actual).deepEqual({ layers: { jev: true, llm: false } });
  });

  it('should leave a value with no recognisable legacy triage untouched', () => {
    // Arrange
    const values = [undefined, 'jev', [1], { layers: { jev: true } }, { triage: 'ai' }];

    // Act
    const actual = values.map(warden.migrateLegacyWardenSettings);

    // Assert
    should(actual).deepEqual(values);
  });

  it('should read an older daemon’s single triage status as its two layers', () => {
    // Arrange
    const legacy = { configured: 'jev', effective: 'rules', reason: 'jev_cap', guardBackoffUntil: INSTANT };

    // Act
    const actual = warden.WardenTriageStatusSchema.parse(legacy);

    // Assert
    should(actual).deepEqual({
      jev: { configured: true, active: false, reason: 'jev_cap' },
      llm: { configured: true, active: false, reason: 'jev_cap' },
      guardBackoffUntil: INSTANT,
    });
  });

  it('should refuse an older triage status it cannot read', () => {
    // Arrange
    const legacy = { configured: 'ai', effective: 'rules', reason: 'configured' };

    // Act
    const actual = warden.WardenTriageStatusSchema.safeParse(legacy);

    // Assert
    should(actual.success).be.false();
  });

  it('should read an older daemon’s single cap as the list of caps hit', () => {
    // Arrange
    const { capsHit: _caps, ...spend } = wardenStatusView.spend;

    // Act
    const actual = [
      warden.WardenSpendSchema.parse({ ...spend, capHit: 'investigation' }).capsHit,
      warden.WardenSpendSchema.parse(spend).capsHit,
    ];

    // Assert
    should(actual).deepEqual([['investigation'], []]);
  });
});

describe('settings from before restart', () => {
  it('should give restart the owner’s answer for resume, and keep one already stated', () => {
    // Arrange
    const { mayActAlone, ...rest } = wardenConfig;
    const { restart: _restart, ...older } = mayActAlone;

    // Act
    const off = warden.WardenConfigSchema.parse({ ...rest, mayActAlone: { ...older, resume: false } });
    const stated = warden.migrateLegacyWardenSettings({ mayActAlone: { resume: false, restart: true } });
    const absent = warden.migrateLegacyWardenSettings({ mayActAlone: { nudge: true } });

    // Assert
    should(off.mayActAlone).match({ resume: false, restart: false });
    should(stated).deepEqual({ mayActAlone: { resume: false, restart: true } });
    should(absent).deepEqual({ mayActAlone: { nudge: true } });
  });
});

describe('settings from before leftover cleanup', () => {
  it('should give a whole older mayActAlone the default — on — and keep an answer already stated', () => {
    // Arrange
    const { mayActAlone, ...rest } = wardenConfig;
    const { closeLeftovers: _close, ...older } = mayActAlone;

    // Act
    const migrated = warden.WardenConfigSchema.parse({ ...rest, mayActAlone: older });
    const stated = warden.migrateLegacyWardenSettings({ mayActAlone: { ...older, closeLeftovers: false } });
    const partial = warden.migrateLegacyWardenSettings({ mayActAlone: { nudge: true } });

    // Assert
    should(migrated.mayActAlone.closeLeftovers).be.true();
    should(stated).match({ mayActAlone: { closeLeftovers: false } });
    should(partial).deepEqual({ mayActAlone: { nudge: true } });
  });

  it('should default to the stuck-command time of ten minutes', () => {
    // Act / Assert
    should(DEFAULT_WARDEN_CONFIG.susSubprocessSeconds).equal(600);
    should(DEFAULT_WARDEN_CONFIG.mayActAlone.closeLeftovers).be.true();
  });
});

describe('settings from before Jev could act', () => {
  it('should give a whole older document the default bars and keep bars already stated', () => {
    // Arrange
    const { jevActs: _acts, ...older } = wardenConfig;

    // Act
    const migrated = warden.WardenConfigSchema.parse(older);
    const stated = warden.WardenConfigSchema.parse({
      ...older,
      jevActs: { ...warden.DEFAULT_WARDEN_JEV_ACTS, stop: 1 },
    });
    const partial = warden.migrateLegacyWardenSettings({ guard: { threshold: 0.9 } });

    // Assert
    should(migrated.jevActs).deepEqual(warden.DEFAULT_WARDEN_JEV_ACTS);
    should(stated.jevActs.stop).equal(1);
    should(partial).deepEqual({ guard: { threshold: 0.9 } });
  });

  it('should default every bar to the leave bar, with a stop a notch higher', () => {
    // Arrange
    const acts = DEFAULT_WARDEN_CONFIG.jevActs;

    // Assert
    should(DEFAULT_WARDEN_CONFIG.guard.threshold).equal(0.7);
    should(acts).deepEqual({ nudge: 0.7, resume: 0.7, restart: 0.7, stop: 0.8 });
    should(acts.stop).be.above(acts.restart);
  });

  it('should let the leave bar go down to 30% and no lower', () => {
    // Act
    const at = warden.WardenGuardConfigSchema.safeParse({ ...wardenConfig.guard, threshold: 0.3 });
    const under = warden.WardenGuardConfigSchema.safeParse({ ...wardenConfig.guard, threshold: 0.29 });

    // Assert
    should(at.success).be.true();
    should(under.success).be.false();
  });

  it('should refuse a bar under the floor and a patch naming an act Jev cannot do alone', () => {
    // Act
    const low = warden.WardenJevActsSchema.safeParse({ ...warden.DEFAULT_WARDEN_JEV_ACTS, nudge: 0.29 });
    const failover = warden.WardenConfigPatchSchema.safeParse({ jevActs: { failover: 0.9 } });
    const merged = warden.mergeWardenConfig(DEFAULT_WARDEN_CONFIG, { jevActs: { stop: 1 } });

    // Assert
    should(low.success).be.false();
    should(warden.WardenJevActsSchema.safeParse({ ...warden.DEFAULT_WARDEN_JEV_ACTS, nudge: 0.3 }).success).be.true();
    should(failover.success).be.false();
    should(merged.jevActs).deepEqual({ ...warden.DEFAULT_WARDEN_JEV_ACTS, stop: 1 });
  });
});

describe('warden actors and outcomes', () => {
  it('should believe a recorded actor and read an older action from what it recorded', () => {
    // Arrange
    const base = { by: 'warden' as const };

    // Act + Assert
    should(warden.wardenActionActor({ ...base, actor: 'auto', reportPath: '/r.md' })).equal('auto');
    should(warden.wardenActionActor({ by: 'jev' })).equal('jev');
    should(warden.wardenActionActor({ by: 'owner' })).equal('owner');
    should(warden.wardenActionActor({ ...base, reportPath: '/r.md' })).equal('llm');
    should(warden.wardenActionActor(base)).equal('auto');
  });

  it('should count what an action did, held as asked, and failures and housekeeping as nothing', () => {
    // Act + Assert
    should(warden.wardenActionOutcome({ action: 'bless', outcome: 'done' })).equal('cleared');
    for (const action of ['nudge', 'resume', 'restart', 'failover'] as const)
      should(warden.wardenActionOutcome({ action, outcome: 'done' })).equal('moved');
    should(warden.wardenActionOutcome({ action: 'stop', outcome: 'done' })).equal('stopped');
    should(warden.wardenActionOutcome({ action: 'stop', outcome: 'held' })).equal('asked');
    should(warden.wardenActionOutcome({ action: 'restart', outcome: 'failed' })).be.undefined();
    should(warden.wardenActionOutcome({ action: 'close_leftover', outcome: 'done' })).be.undefined();
  });
});

describe('warden investigator names', () => {
  it('should name an investigator with six hex digits, stored lowercase and shown uppercase', () => {
    // Act
    const name = warden.wardenInvestigatorName(42);

    // Assert
    should(name).equal('warden-00002a');
    should(displaySystemCallsign(name)).equal('warden-00002A');
    should(warden.wardenInvestigatorName(warden.WARDEN_INVESTIGATOR_MAX_SEQUENCE)).equal('warden-ffffff');
    should(warden.wardenInvestigatorSequence('Warden-00002A')).equal(42);
    should(displaySystemCallsign('hadi')).equal('hadi');
  });

  it('should recognise only its own shape, never a pool name', () => {
    // Act + Assert
    should(isSystemCallsign('warden-000001')).be.true();
    for (const other of ['warden', 'hadi', 'warden-1', 'warden-0000001', 'warden-00000g', 'warden-000000', undefined])
      should(isSystemCallsign(other)).be.false();
  });

  it('should count on, wrap after FFFFFF to 1, and step past ids still in use', () => {
    // Act + Assert
    should(warden.nextWardenInvestigatorSequence(0, new Set())).equal(1);
    should(warden.nextWardenInvestigatorSequence(41, new Set())).equal(42);
    should(warden.nextWardenInvestigatorSequence(41, new Set([42, 43]))).equal(44);
    should(warden.nextWardenInvestigatorSequence(warden.WARDEN_INVESTIGATOR_MAX_SEQUENCE, new Set())).equal(1);
    should(
      warden.nextWardenInvestigatorSequence(warden.WARDEN_INVESTIGATOR_MAX_SEQUENCE - 1, new Set([0xff_ff_ff, 1])),
    ).equal(2);
    should(warden.nextWardenInvestigatorSequence(-5, new Set())).equal(1);
  });
});
