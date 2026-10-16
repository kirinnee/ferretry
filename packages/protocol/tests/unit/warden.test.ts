import { describe, it } from 'bun:test';
import should from 'should';
import { DEFAULT_WARDEN_CONFIG } from '../../src/lib/config-files.ts';
import * as warden from '../../src/lib/warden.ts';
import {
  INSTANT,
  wardenAttentionView,
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

const attentionItem = wardenAttentionView.items[0];

const wardenCases: SchemaCase[] = [
  { name: 'policy', schema: warden.WardenFailoverPolicySchema, value: 'fallback' },
  { name: 'account', schema: warden.WardenAccountSchema, value: wardenConfig.accounts[0] },
  { name: 'failover', schema: warden.WardenFailoverConfigSchema, value: wardenConfig.failover },
  { name: 'provider outage', schema: warden.ProviderOutageConfigSchema, value: wardenConfig.providerOutage },
  { name: 'triage', schema: warden.WardenTriageSchema, value: 'jev' },
  { name: 'sweep interval', schema: warden.WardenSweepIntervalSchema, value: 2 },
  { name: 'guard', schema: warden.WardenGuardConfigSchema, value: wardenConfig.guard },
  { name: 'caps', schema: warden.WardenCapsSchema, value: wardenConfig.caps },
  { name: 'may act alone', schema: warden.WardenMayActAloneSchema, value: wardenConfig.mayActAlone },
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
  { name: 'verdict kind', schema: warden.WardenVerdictKindSchema, value: 'needs_human' },
  { name: 'recommended action', schema: warden.WardenRecommendedActionSchema, value: 'nudge' },
  { name: 'recommendation', schema: warden.WardenRecommendationSchema, value: wardenVerdict.recommendation },
  { name: 'verdict spawn', schema: warden.WardenVerdictSpawnSchema, value: wardenVerdict.spawn },
  { name: 'verdict', schema: warden.WardenVerdictSchema, value: wardenVerdict },
  { name: 'verdicts', schema: warden.WardenVerdictsViewSchema, value: [wardenVerdict] },
  { name: 'triage reason', schema: warden.WardenTriageReasonSchema, value: 'jev_cap' },
  { name: 'guard failure', schema: warden.WardenGuardFailureCodeSchema, value: 'not_set' },
  {
    name: 'triage status',
    schema: warden.WardenTriageStatusSchema,
    value: {
      configured: 'jev',
      effective: 'rules',
      reason: 'jev_cap',
      guardFailure: { code: 'rate_limited', at: INSTANT },
      guardBackoffUntil: INSTANT,
    },
  },
  { name: 'spend day', schema: warden.WardenSpendDaySchema, value: '2026-10-16' },
  { name: 'spend', schema: warden.WardenSpendSchema, value: { ...wardenStatusView.spend, capHit: 'jev' } },
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
  {
    name: 'blessing',
    schema: warden.WardenBlessingViewSchema,
    value: { sessionId: 'session-1', kinds: ['sus_thinking'], expiresAt: INSTANT, by: 'jev' },
  },
  {
    name: 'status',
    schema: warden.WardenStatusViewSchema,
    value: { ...wardenStatusView, nextSweepAt: INSTANT, investigations: [investigation], actions: [action] },
  },
  { name: 'run', schema: warden.WardenRunViewSchema, value: wardenRunView },
  { name: 'run request', schema: warden.WardenRunRequestSchema, value: { spawn: true } },
  { name: 'investigate request', schema: warden.WardenInvestigateRequestSchema, value: { sessionId: 's' } },
  { name: 'investigate view', schema: warden.WardenInvestigateViewSchema, value: wardenInvestigateView },
  { name: 'judgement state', schema: warden.WardenJudgementStateSchema, value: 'pending' },
  { name: 'judge provenance', schema: warden.WardenJudgeProvenanceSchema, value: { agent: 'a', model: 'm' } },
  {
    name: 'judgement',
    schema: warden.WardenJudgementSchema,
    value: { state: 'judged', verdict: 'needs_human', reason: 'blocked', at: INSTANT, stale: false },
  },
  { name: 'attention item', schema: warden.FleetAttentionItemSchema, value: attentionItem },
  { name: 'attention outcome', schema: warden.WardenAttentionOutcomeSchema, value: 'degraded' },
  { name: 'attention view', schema: warden.WardenAttentionViewSchema, value: wardenAttentionView },
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
        value: { ...wardenConfig.guard, threshold: 0.6 },
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
    ];

    // Act + Assert
    assertRejects(cases);
  });
});

describe('mergeWardenConfig', () => {
  it('should merge each nested section so one switch never resets its siblings', () => {
    // Arrange
    const patch = { triage: 'jev', mayActAlone: { stop: true }, caps: { jevUsdPerDay: 1 } } as const;

    // Act
    const actual = warden.mergeWardenConfig(DEFAULT_WARDEN_CONFIG, patch);

    // Assert
    should(actual.triage).equal('jev');
    should(actual.mayActAlone).deepEqual({ nudge: true, resume: true, failover: true, stop: true });
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
    const patch = { guard: { threshold: 0.5 } };

    // Act
    const act = () => warden.mergeWardenConfig(DEFAULT_WARDEN_CONFIG, patch);

    // Assert
    should(act).throw();
  });
});
