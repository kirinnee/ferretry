/**
 * The Warden as a realistic day with both layers on — Jev, then an LLM investigation: a savings line, one question waiting on the owner,
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
  layers: { jev: true, llm: true },
  caps: { ...DEFAULT_WARDEN_CONFIG.caps, jevUsdPerDay: 0.5, investigationUsdPerDay: 2 },
  accounts: [{ agent: 'claude-default', model: 'claude-sonnet-5-5' }, { agent: 'claude-spare' }],
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
      { agent: 'claude-default', eligible: true },
      { agent: 'claude-spare', eligible: true },
      { agent: 'codex-default', eligible: false, reason: 'at limit' },
    ],
    lastSelection: { agent: 'claude-default', policy: 'fallback', at: at(30), reason: 'first eligible' },
  },
  triage: {
    jev: { configured: true, active: true, reason: 'configured' },
    llm: { configured: true, active: true, reason: 'configured' },
  },
  spend: {
    day: '2026-07-31',
    jevUsd: 0.03,
    jevCapUsd: 0.5,
    investigationUsd: 1.2,
    investigationCapUsd: 2,
    pendingInvestigations: 1,
    capsHit: [],
    investigationsLastHour: 2,
    maxInvestigationsPerHour: 6,
  },
  savings: {
    day: '2026-07-31',
    flags: 41,
    jevDecisions: 41,
    jevSkips: 37,
    investigations: 4,
    jevActions: 3,
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
      agent: 'claude-default',
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
      agent: 'claude-default',
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
      detail:
        'Jev was 96% sure it is healthy, so this flag is left alone for 1 h — cleared 3 times in a row, so it is left alone longer each time.',
      confidence: 0.96,
    },
    {
      at: at(9),
      sessionId: 'harness-jaylynn',
      action: 'restart',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'dead_monitor',
      detail:
        'Restarted its process with the conversation intact; its terminal had closed after running out of memory.',
      confidence: 0.96,
      reason: 'The process is gone and nothing is mid-edit, so a restart loses nothing.',
    },
    {
      at: at(10),
      sessionId: 'harness-marin',
      action: 'stop',
      outcome: 'held',
      by: 'jev',
      anomalyKind: 'abandoned_wreckage',
      detail: 'Jev recommends stopping it, but you have not let the Warden stop a ferret alone, so it waits for you.',
      confidence: 0.99,
      reason: 'It has repeated the same failing command for an hour with no change.',
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
  blessings: [{ sessionId: 'harness-workspace', kinds: ['sus_subprocess'], expiresAt: at(-54), by: 'jev', streak: 2 }],
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
        judgedBy: { agent: 'claude-default', model: 'claude-sonnet-5-5' },
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
        judgedBy: { agent: 'claude-default', model: 'claude-sonnet-5-5' },
      },
    },
  ],
  boardsWithParseErrors: [],
  verdictCoverage: { limit: 50, truncated: false },
};

const HARNESS_LOGINS = ['claude-default', 'claude-spare', 'codex-default'];

export const WARDEN_FIXTURE_CONFIG: WardenConfigView = {
  config,
  accounts: config.accounts,
  warnings: [],
  login: { source: 'configured', unknown: [], available: HARNESS_LOGINS },
};

/** A `warden.yaml` written on another machine: its login does not exist here, and nothing rewrites it. */
export const WARDEN_FIXTURE_CONFIG_UNKNOWN_LOGIN: WardenConfigView = {
  config: { ...config, layers: { jev: false, llm: true }, accounts: [{ agent: 'legacy-wrapper' }] },
  accounts: [{ agent: 'legacy-wrapper' }],
  warnings: [
    "unknown login 'legacy-wrapper' — choose one in Settings › Warden (it is skipped until it exists here)",
    'no investigation login exists on this machine, so LLM investigations are unavailable',
  ],
  login: { source: 'configured', unknown: ['legacy-wrapper'], available: HARNESS_LOGINS },
};

/** No login chosen and no default runtime: LLM investigations are unavailable, and say so. */
export const WARDEN_FIXTURE_CONFIG_NO_LOGIN: WardenConfigView = {
  config: { ...config, layers: { jev: false, llm: true }, accounts: [] },
  accounts: [],
  warnings: [
    'no investigation login is set and this machine has no default runtime, so LLM investigations are unavailable — choose a login in Settings › Warden',
  ],
  login: { source: 'not_set', unknown: [], available: HARNESS_LOGINS },
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
