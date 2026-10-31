/**
 * The Warden as a realistic week with both layers on — Jev, then an LLM investigation: three weeks of
 * stats (a quiet day, a busy day, one day with no record), each with Jev's checks, Jev paused for the day
 * with its cap spent, Jev's hand-ons and cap skips in the list, two sessions being
 * watched, investigations running, queued and finished, and ~30 recent actions covering every outcome
 * by every actor, a run of identical repeats, and a stop the owner has not let the Warden take alone. Session ids are the harness fleet's own, so rows
 * resolve to real names and status marks.
 */

import {
  DEFAULT_WARDEN_CONFIG,
  SPEEDUPS_PATH,
  type SpeedupsView,
  type WardenActionTally,
  type WardenAgendaView,
  type WardenConfigView,
  type WardenDayStats,
  type WardenJevBefore,
  type WardenJevCheck,
  type WardenReviveResults,
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

type ActorTriple = readonly [auto: number, jev: number, llm: number];

const counts = ([auto, jev, llm]: ActorTriple) => ({ auto, jev, llm });

const day = (
  date: string,
  flags: number,
  jevDecisions: number,
  investigations: number,
  jevUsd: number,
  investigationUsd: number,
  outcomes: Readonly<Record<'moved' | 'cleared' | 'stopped' | 'asked', ActorTriple>>,
  skippedForCap = 0,
): WardenDayStats => {
  // Jev checked every flag it decided: what it cleared was healthy, what it moved or stopped it acted on,
  // and the rest it handed on — the part a day without these counters could not show.
  const healthy = outcomes.cleared[1];
  const acted = outcomes.moved[1] + outcomes.stopped[1];
  return {
    day: date,
    flags,
    jevDecisions,
    investigations,
    jevUsd,
    investigationUsd,
    moved: counts(outcomes.moved),
    cleared: counts(outcomes.cleared),
    stopped: counts(outcomes.stopped),
    asked: counts(outcomes.asked),
    jev: { checks: jevDecisions, healthy, acted, handedOn: jevDecisions - healthy - acted, skippedForCap },
  };
};

const tally = (
  action: WardenActionTally['action'],
  outcome: WardenActionTally['outcome'],
  triple: ActorTriple,
): WardenActionTally => ({ action, outcome, ...counts(triple) });

const results = (progressed: ActorTriple, stalled: ActorTriple): WardenReviveResults => ({
  progressed: counts(progressed),
  stalled: counts(stalled),
});

/** What the Warden did on each day, by action and who decided it: revives are the story, the rest is context. */
const ACTIONS: Readonly<
  Record<string, { readonly acts: readonly WardenActionTally[]; readonly revived?: WardenReviveResults }>
> = {
  '2026-07-18': {
    acts: [tally('revive', 'done', [2, 0, 0]), tally('nudge', 'done', [0, 3, 0])],
    revived: results([2, 0, 0], [0, 0, 0]),
  },
  '2026-07-19': { acts: [tally('nudge', 'done', [0, 2, 0])] },
  '2026-07-20': {
    acts: [tally('revive', 'done', [1, 1, 0]), tally('stop', 'done', [0, 0, 1])],
    revived: results([1, 1, 0], [0, 0, 0]),
  },
  // 2026-07-21 has no record, and 2026-07-22 was a day the daemon did not yet tally: both draw a "?".
  '2026-07-23': {
    acts: [
      tally('revive', 'done', [3, 2, 1]),
      tally('revive', 'failed', [1, 0, 0]),
      tally('failover', 'done', [1, 0, 0]),
    ],
    revived: results([3, 2, 1], [1, 0, 0]),
  },
  '2026-07-24': {
    acts: [tally('resume', 'done', [0, 1, 2]), tally('nudge', 'done', [1, 4, 0])],
    revived: results([0, 1, 1], [0, 0, 1]),
  },
  '2026-07-25': {
    acts: [tally('revive', 'done', [4, 3, 1]), tally('stop', 'done', [0, 0, 1]), tally('escalate', 'done', [0, 1, 0])],
    revived: results([3, 2, 1], [1, 1, 0]),
  },
  '2026-07-26': { acts: [tally('revive', 'done', [1, 0, 0])], revived: results([1, 0, 0], [0, 0, 0]) },
  '2026-07-28': {
    acts: [
      tally('revive', 'done', [5, 6, 1]),
      tally('resume', 'done', [0, 3, 1]),
      tally('restart', 'done', [1, 0, 1]),
      tally('stop', 'done', [1, 0, 2]),
      tally('revive', 'held', [0, 0, 1]),
    ],
    revived: results([4, 7, 2], [1, 2, 0]),
  },
  '2026-07-29': {
    acts: [tally('revive', 'done', [3, 5, 0]), tally('bless', 'done', [0, 4, 1]), tally('stop', 'done', [0, 0, 1])],
    revived: results([3, 4, 0], [0, 1, 0]),
  },
  '2026-07-30': {
    acts: [
      tally('revive', 'done', [5, 4, 1]),
      tally('resume', 'done', [0, 0, 1]),
      tally('failover', 'done', [0, 1, 0]),
      tally('stop', 'done', [1, 0, 1]),
    ],
    revived: results([5, 3, 2], [0, 1, 0]),
  },
  '2026-07-31': {
    acts: [
      tally('revive', 'done', [3, 5, 1]),
      tally('revive', 'failed', [1, 0, 0]),
      tally('nudge', 'done', [0, 2, 0]),
      tally('stop', 'done', [1, 0, 1]),
      tally('escalate', 'done', [0, 2, 1]),
    ],
    revived: results([2, 4, 1], [0, 1, 0]),
  },
};

const withActions = (entry: WardenDayStats): WardenDayStats => {
  const recorded = ACTIONS[entry.day];
  if (recorded === undefined) return entry;
  return {
    ...entry,
    acts: [...recorded.acts],
    ...(recorded.revived === undefined ? {} : { reviveResults: recorded.revived }),
  };
};

/** Earlier days of the month: enough to draw fourteen bars and a month's count. */
const EARLIER_DAYS: readonly WardenDayStats[] = [
  day('2026-07-18', 9, 9, 1, 0.06, 0.3, { moved: [2, 3, 0], cleared: [0, 5, 0], stopped: [0, 0, 0], asked: [0, 0, 0] }),
  day('2026-07-19', 3, 3, 0, 0.02, 0, { moved: [0, 2, 0], cleared: [0, 1, 0], stopped: [0, 0, 0], asked: [0, 0, 0] }),
  day('2026-07-20', 12, 11, 2, 0.08, 0.6, {
    moved: [1, 1, 0],
    cleared: [0, 8, 1],
    stopped: [0, 0, 1],
    asked: [0, 0, 0],
  }),
  // 2026-07-21 is missing on purpose, like 2026-07-27.
  day('2026-07-22', 5, 5, 0, 0.03, 0, { moved: [0, 0, 0], cleared: [0, 4, 0], stopped: [0, 0, 0], asked: [0, 0, 0] }),
  day('2026-07-23', 22, 21, 3, 0.15, 0.9, {
    moved: [4, 2, 1],
    cleared: [0, 12, 1],
    stopped: [0, 0, 0],
    asked: [0, 0, 0],
  }),
  day('2026-07-24', 17, 16, 2, 0.11, 0.6, {
    moved: [1, 5, 2],
    cleared: [0, 9, 0],
    stopped: [0, 0, 0],
    asked: [0, 0, 0],
  }),
].map(withActions);

/** Jev's checks that settled nothing: what Recent actions lists for Jev beside its actions. */
const JEV_CHECKS: readonly WardenJevCheck[] = [
  {
    at: at(2),
    sessionId: 'harness-marin',
    anomalyKind: 'sus_thinking',
    verdict: 'skipped',
    why: 'jev_cap',
    route: 'investigation',
    confidence: 0,
    costUsd: 0,
  },
  {
    at: at(4),
    sessionId: 'harness-maryah',
    anomalyKind: 'unattended_question',
    verdict: 'handed_on',
    why: 'unsure',
    route: 'investigation',
    confidence: 0.21,
    costUsd: 0.0041,
  },
  {
    at: at(12),
    sessionId: 'harness-jaylynn',
    anomalyKind: 'sus_subprocess',
    verdict: 'handed_on',
    why: 'never_alone',
    act: 'stop',
    route: 'investigation',
    confidence: 0.99,
    costUsd: 0.0038,
  },
];

const STATUS_WITHOUT_JEV: WardenStatusView = {
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
    jev: { configured: true, active: false, reason: 'jev_cap' },
    llm: { configured: true, active: true, reason: 'configured' },
  },
  spend: {
    day: '2026-07-31',
    jevUsd: 0.51,
    jevCapUsd: 0.5,
    investigationUsd: 1.2,
    investigationCapUsd: 2,
    pendingInvestigations: 1,
    capsHit: ['jev'],
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
  history: [
    ...EARLIER_DAYS,
    day('2026-07-25', 28, 26, 3, 0.21, 0.88, {
      moved: [4, 3, 1],
      cleared: [0, 14, 1],
      stopped: [0, 0, 1],
      asked: [0, 1, 0],
    }),
    day('2026-07-26', 4, 4, 0, 0.03, 0, { moved: [1, 0, 0], cleared: [0, 3, 0], stopped: [0, 0, 0], asked: [0, 0, 0] }),
    // 2026-07-27 is missing on purpose: the daemon kept no record of it, which is not the same as a quiet day.
    day('2026-07-28', 63, 60, 9, 0.46, 2.7, {
      moved: [6, 9, 2],
      cleared: [0, 31, 3],
      stopped: [1, 0, 2],
      asked: [0, 3, 1],
    }),
    day('2026-07-29', 37, 35, 5, 0.28, 1.5, {
      moved: [3, 5, 1],
      cleared: [0, 19, 2],
      stopped: [0, 0, 1],
      asked: [0, 2, 1],
    }),
    day('2026-07-30', 45, 44, 6, 0.34, 1.8, {
      moved: [5, 4, 2],
      cleared: [0, 24, 2],
      stopped: [1, 0, 1],
      asked: [0, 2, 0],
    }),
    day(
      '2026-07-31',
      41,
      41,
      4,
      0.51,
      1.2,
      {
        moved: [3, 5, 1],
        cleared: [0, 26, 2],
        stopped: [1, 0, 1],
        asked: [0, 2, 1],
      },
      6,
    ),
  ].map(withActions),
  jevChecks: [...JEV_CHECKS],
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
      wardenName: 'warden-00002a',
    },
    {
      id: 'queued:harness-maryah',
      state: 'queued',
      scope: 'session',
      origin: 'sweep',
      targetSession: 'harness-maryah',
      anomalyKind: 'unattended_question',
      queuedAt: at(2),
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
      wardenName: 'warden-000029',
    },
    {
      id: 'warden-marin',
      state: 'done',
      scope: 'session',
      origin: 'jev',
      targetSession: 'harness-marin',
      anomalyKind: 'sus_thinking',
      startedAt: at(190),
      finishedAt: at(180),
      reportPath: 'warden/reports/harness-marin.md',
      verdict: 'killed',
      costUsd: 0.42,
      agent: 'claude-default',
      model: 'claude-sonnet-5-5',
      wardenName: 'warden-000027',
    },
    {
      id: 'warden-jaylynn-2',
      state: 'done',
      scope: 'session',
      origin: 'owner',
      targetSession: 'harness-jaylynn',
      anomalyKind: 'dead_monitor',
      startedAt: at(715),
      finishedAt: at(700),
      reportPath: 'warden/reports/harness-jaylynn.md',
      verdict: 'cleared',
      costUsd: 0.18,
      agent: 'claude-spare',
      wardenName: 'warden-000026',
    },
    {
      id: 'warden-fleet',
      state: 'done',
      scope: 'fleet',
      origin: 'sweep',
      startedAt: at(1530),
      finishedAt: at(1500),
      reportPath: 'warden/reports/fleet.md',
      verdict: 'needs_human',
      costUsd: 0.55,
      agent: 'claude-default',
      model: 'claude-sonnet-5-5',
      wardenName: 'warden-000023',
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
    ...[12, 13, 14].map((minutes): WardenStatusView['actions'][number] => ({
      at: at(minutes),
      sessionId: 'harness-marin',
      action: 'nudge',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'sus_thinking',
      detail: 'Asked Marin to report its blocker after 12 minutes of silent thinking.',
    })),
    {
      at: at(20),
      sessionId: 'harness-jaylynn',
      action: 'resume',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'dead_monitor',
      detail: 'Resumed it from its last checkpoint; the investigation found its monitor had only lost its connection.',
      reportPath: 'warden/reports/harness-jaylynn.md',
      investigator: 'warden-00002b',
    },
    {
      at: at(30),
      sessionId: 'harness-marin',
      action: 'failover',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'sus_thinking',
      detail: 'Moved it to another account because claude-default hit its usage limit.',
      confidence: 0.91,
      agent: 'claude-spare',
      reason: 'The account is rate-limited; the same task will run on the spare one.',
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
      investigator: 'warden-000029',
    },
    {
      at: at(60),
      sessionId: 'harness-workspace',
      action: 'close_leftover',
      outcome: 'done',
      by: 'warden',
      detail: 'Closed a browser a finished ferret left running.',
    },
    {
      at: at(75),
      sessionId: 'harness-maryah',
      action: 'restart',
      outcome: 'failed',
      by: 'warden',
      anomalyKind: 'dead_monitor',
      detail: 'Tried to restart it, but its process would not start.',
    },
    {
      at: at(95),
      sessionId: 'harness-workspace',
      action: 'bless',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'sus_subprocess',
      detail: 'Jev was 93% sure it is healthy, so this flag is left alone for 30 min.',
      confidence: 0.93,
    },
    {
      at: at(130),
      sessionId: 'harness-kamila',
      action: 'bless',
      outcome: 'done',
      by: 'owner',
      anomalyKind: 'sus_thinking',
      detail: 'You asked the Warden to leave it alone for 4 h.',
    },
    {
      at: at(180),
      sessionId: 'harness-marin',
      action: 'stop',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'abandoned_wreckage',
      detail: 'Stopped it: it had repeated one failing command for over an hour and the report found nothing to save.',
      reportPath: 'warden/reports/harness-marin.md',
      investigator: 'warden-000027',
    },
    {
      at: at(240),
      sessionId: 'harness-jaylynn',
      action: 'nudge',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'sus_thinking',
      detail: 'Asked Jaylynn to report its blocker after 15 minutes of silent thinking.',
    },
    {
      at: at(300),
      sessionId: 'harness-maryah',
      action: 'bless',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'unattended_question',
      detail: 'Jev was 88% sure it is only waiting on a slow tool, so this flag is left alone for 30 min.',
      confidence: 0.88,
    },
    {
      at: at(360),
      sessionId: 'harness-kamila',
      action: 'resume',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'dead_monitor',
      detail: 'Resumed it; its monitor had only lost its connection.',
      confidence: 0.9,
      reason: 'Nothing was lost; a resume picks up where it stopped.',
    },
    {
      at: at(420),
      sessionId: 'harness-workspace',
      action: 'bless',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'sus_subprocess',
      detail: 'Jev was 97% sure it is healthy, so this flag is left alone for 30 min.',
      confidence: 0.97,
    },
    {
      at: at(430),
      sessionId: 'harness-workspace',
      action: 'bless',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'sus_subprocess',
      detail: 'Jev was 97% sure it is healthy, so this flag is left alone for 30 min.',
      confidence: 0.97,
    },
    {
      at: at(600),
      sessionId: 'harness-marin',
      action: 'restart',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'dead_monitor',
      detail: 'Restarted its process with the conversation intact; its terminal had closed.',
    },
    {
      at: at(700),
      sessionId: 'harness-jaylynn',
      action: 'bless',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'dead_monitor',
      detail: 'The investigation found it healthy, so this flag is left alone for 4 h.',
      reportPath: 'warden/reports/harness-jaylynn.md',
      investigator: 'warden-000026',
    },
    {
      at: at(900),
      sessionId: 'harness-kamila',
      action: 'nudge',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'sus_thinking',
      detail: 'Asked Kamila to report its blocker after 12 minutes of silent thinking.',
    },
    {
      at: at(1500),
      sessionId: 'harness-maryah',
      action: 'failover',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'sus_thinking',
      detail: 'Moved it to another account because claude-default hit its usage limit.',
      reportPath: 'warden/reports/fleet.md',
      investigator: 'warden-000024',
      agent: 'claude-spare',
    },
    {
      at: at(1600),
      sessionId: 'harness-marin',
      action: 'bless',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'sus_thinking',
      detail: 'Jev was 92% sure it is only thinking hard, so this flag is left alone for 30 min.',
      confidence: 0.92,
    },
    {
      at: at(2000),
      sessionId: 'harness-jaylynn',
      action: 'stop',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'dead_monitor',
      detail: 'Stopped it: its process had been dead for over an hour.',
    },
    {
      at: at(3000),
      sessionId: 'harness-workspace',
      action: 'nudge',
      outcome: 'done',
      by: 'jev',
      anomalyKind: 'sus_thinking',
      detail: 'Asked it to report its blocker.',
      confidence: 0.85,
      reason: 'It has been silent for a while but its last tool call succeeded.',
    },
    {
      at: at(4000),
      sessionId: 'harness-kamila',
      action: 'restart',
      outcome: 'done',
      by: 'warden',
      anomalyKind: 'abandoned_wreckage',
      detail: 'Restarted it after the investigation found a stuck hook.',
      reportPath: 'warden/reports/harness-kamila.md',
      investigator: 'warden-000022',
    },
  ],
  blessings: [{ sessionId: 'harness-workspace', kinds: ['sus_subprocess'], expiresAt: at(-54), by: 'jev', streak: 2 }],
};

/** What Jev did before each investigation, by its report: every case the page has words for, one each. */
const JEV_BY_REPORT: Readonly<Record<string, WardenJevBefore>> = {
  'warden/reports/harness-kamila.md': {
    verdict: 'handed_on',
    why: 'unsure',
    at: at(48),
    confidence: 0.21,
    costUsd: 0.0041,
  },
  'warden/reports/harness-marin.md': { verdict: 'skipped', why: 'jev_cap', at: at(181), confidence: 0, costUsd: 0 },
  'warden/reports/harness-jaylynn.md': { verdict: 'not_asked', why: 'not_judgeable' },
  'warden/reports/fleet.md': { verdict: 'off' },
};

const withJev = <T extends { readonly reportPath?: string }>(entry: T): T => {
  const jev = entry.reportPath === undefined ? undefined : JEV_BY_REPORT[entry.reportPath];
  return jev === undefined ? entry : { ...entry, jev };
};

export const WARDEN_FIXTURE_STATUS: WardenStatusView = {
  ...STATUS_WITHOUT_JEV,
  investigations: STATUS_WITHOUT_JEV.investigations.map(entry =>
    entry.state === 'done'
      ? withJev(entry)
      : {
          ...entry,
          jev:
            entry.state === 'queued'
              ? {
                  verdict: 'handed_on',
                  why: 'not_sure_enough',
                  act: 'restart',
                  at: at(2),
                  confidence: 0.62,
                  costUsd: 0.0038,
                }
              : { verdict: 'not_asked', why: 'not_judgeable' },
        },
  ),
  actions: STATUS_WITHOUT_JEV.actions.map(action =>
    action.actor === 'llm' || action.by === 'warden' ? withJev(action) : action,
  ),
};

export const WARDEN_FIXTURE_AGENDA: WardenAgendaView = {
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
