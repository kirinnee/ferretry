/**
 * The Warden as a realistic day with Jev triage on: a savings line, one question waiting on the owner,
 * two sessions being watched, one investigation running and one finished, and recent actions including
 * a stop the owner has not let the Warden take alone. Session ids are the harness fleet's own, so rows
 * resolve to real names and status marks.
 */

import {
  DEFAULT_WARDEN_CONFIG,
  SPEEDUPS_PATH,
  type SpeedupsView,
  type WardenAttentionView,
  type WardenConfigView,
  type WardenStatusView,
} from '@ferretry/protocol';

export const WARDEN_FIXTURE_NOW = Date.parse('2026-07-31T12:00:00.000Z');

const at = (minutesAgo: number): string => new Date(WARDEN_FIXTURE_NOW - minutesAgo * 60_000).toISOString();

const config = {
  ...DEFAULT_WARDEN_CONFIG,
  triage: 'jev' as const,
  caps: { ...DEFAULT_WARDEN_CONFIG.caps, jevUsdPerDay: 0.5, investigationUsdPerDay: 2 },
  accounts: [{ agent: 'claude-auto-loge', model: 'claude-sonnet-5-5' }, { agent: 'claude-auto-loge2' }],
};

export const WARDEN_FIXTURE_STATUS: WardenStatusView = {
  config,
  lastSweepAt: at(1),
  nextSweepAt: new Date(WARDEN_FIXTURE_NOW + 60_000).toISOString(),
  anomalies: [
    {
      kind: 'sus_thinking',
      sessionId: 'harness-marin',
      teammate: 'marin',
      status: 'running',
      detail: 'Thinking for 14 minutes with no new output. Nudged at 11:48; asked to report its blocker.',
      since: at(14),
    },
    {
      kind: 'dead_monitor',
      sessionId: 'harness-jaylynn',
      teammate: 'jaylynn',
      status: 'running',
      detail: 'Its terminal closed after running out of memory.',
      since: at(9),
    },
    {
      kind: 'unattended_question',
      sessionId: 'harness-maryah',
      teammate: 'maryah',
      status: 'awaiting_user',
      detail: 'Asked which relay fallback to use and is waiting for your answer.',
      since: at(41),
    },
  ],
  fingerprint: 'harness-warden',
  failover: {
    policy: 'fallback',
    failureThreshold: 2,
    cooldownMinutes: 30,
    accounts: [
      { agent: 'claude-auto-loge', eligible: true },
      { agent: 'claude-auto-loge2', eligible: true },
      { agent: 'codex-auto-terra', eligible: false, reason: 'at limit' },
    ],
    lastSelection: { agent: 'claude-auto-loge', policy: 'fallback', at: at(30), reason: 'first eligible' },
  },
  triage: { configured: 'jev', effective: 'jev', reason: 'configured' },
  spend: {
    day: '2026-07-31',
    jevUsd: 0.03,
    jevCapUsd: 0.5,
    investigationUsd: 1.2,
    investigationCapUsd: 2,
    pendingInvestigations: 1,
    investigationsLastHour: 2,
    maxInvestigationsPerHour: 6,
  },
  savings: {
    day: '2026-07-31',
    flags: 41,
    jevDecisions: 41,
    jevSkips: 37,
    investigations: 4,
    averageInvestigationUsd: 0.3,
    savedUsd: 11.07,
  },
  investigations: [
    {
      id: 'warden-jaylynn',
      state: 'running',
      scope: 'session',
      origin: 'jev',
      targetSession: 'harness-jaylynn',
      anomalyKind: 'dead_monitor',
      startedAt: at(3),
      agent: 'claude-auto-loge',
      model: 'claude-sonnet-5-5',
    },
    {
      id: 'warden-kamila',
      state: 'done',
      scope: 'session',
      origin: 'sweep',
      targetSession: 'harness-kamila',
      anomalyKind: 'abandoned_wreckage',
      startedAt: at(52),
      finishedAt: at(47),
      reportPath: 'warden/reports/harness-kamila.md',
      verdict: 'killed',
      costUsd: 0.31,
      agent: 'claude-auto-loge',
      model: 'claude-sonnet-5-5',
    },
  ],
  actions: [
    {
      at: at(6),
      sessionId: 'harness-workspace',
      action: 'bless',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'sus_subprocess',
      detail: 'A long `bun test` is still advancing; Jev judged it healthy.',
      confidence: 0.96,
    },
    {
      at: at(12),
      sessionId: 'harness-marin',
      action: 'nudge',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'sus_thinking',
      detail: 'Asked Marin to report its blocker after 12 minutes of silent thinking.',
    },
    {
      at: at(47),
      sessionId: 'harness-kamila',
      action: 'stop',
      outcome: 'held',
      by: 'warden',
      anomalyKind: 'abandoned_wreckage',
      detail: 'Looping on the same failing treefmt hook for 40 minutes. The verdict says stop; it waits for you.',
      reportPath: 'warden/reports/harness-kamila.md',
    },
  ],
  blessings: [{ sessionId: 'harness-workspace', kinds: ['sus_subprocess'], expiresAt: at(-9), by: 'jev' }],
};

export const WARDEN_FIXTURE_ATTENTION: WardenAttentionView = {
  generatedAt: at(1),
  lastSweepAt: at(1),
  outcome: 'items',
  items: [
    {
      sessionId: 'harness-maryah',
      teammate: 'maryah',
      sessionStatus: 'awaiting_user',
      id: 'question-1',
      source: 'question',
      subject: '',
      why: 'Asked which relay fallback to use and is waiting for your answer.',
      waitingSince: at(41),
      howToResolve: 'Answer the question in the session.',
      judgement: {
        state: 'judged',
        verdict: 'needs_human',
        reason: 'Only you can choose the fallback.',
        judgedBy: { agent: 'claude-auto-loge', model: 'claude-sonnet-5-5' },
      },
    },
    {
      sessionId: 'harness-kamila',
      teammate: 'kamila',
      id: 'action-stop',
      source: 'warden-action',
      subject: '',
      why: 'Looping on the same failing treefmt hook for 40 minutes. The verdict says stop; it waits for you.',
      waitingSince: at(47),
      howToResolve: 'Stop the session, or leave it running.',
      judgement: {
        state: 'judged',
        verdict: 'killed',
        reason: 'Looping on a failing hook.',
        reportPath: 'warden/reports/harness-kamila.md',
        judgedBy: { agent: 'claude-auto-loge', model: 'claude-sonnet-5-5' },
      },
    },
  ],
  boardsWithParseErrors: [],
  verdictCoverage: { limit: 50, truncated: false },
};

export const WARDEN_FIXTURE_CONFIG: WardenConfigView = {
  config,
  accounts: config.accounts,
  warnings: [],
};

const WARDEN_FIXTURE_SPEEDUPS: SpeedupsView = {
  vault: 'ok',
  providers: [
    {
      provider: 'jev',
      label: 'Jev',
      purpose: 'Cheap Warden triage.',
      costNote: 'Fractions of a cent per flag.',
      privacyNote: 'A redacted summary of a flagged ferret.',
      keyUrl: 'https://typesafe.ai/keys',
      testNote: 'One tiny decision.',
      secretName: 'JEV_API_KEY',
      set: true,
      testStale: false,
    },
  ],
};

/** Answers the Speed-ups read; any other path is a harness bug and says so. */
export const wardenFixtureRequest = async <T>(path: string): Promise<T> => {
  if (path !== SPEEDUPS_PATH) throw new Error(`harness: no fixture for ${path}`);
  return WARDEN_FIXTURE_SPEEDUPS as T;
};
