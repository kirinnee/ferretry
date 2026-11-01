import type {
  AnalyticsResponse,
  AttachmentView,
  CgroupConfigView,
  FyEvent,
  FyEventStreamFrame,
  HealthView,
  PwaConfigView,
  ScratchPlanView,
  ScratchSweepView,
  SendRecord,
  SendResult,
  SessionAttachTarget,
  SessionView,
  UsageFeedView,
  WardenAgendaView,
  WardenConfig,
  WardenConfigView,
  WardenInvestigateView,
  WardenLeaveView,
  WardenRunView,
  WardenStatusView,
} from '../src/lib/index.ts';

export const INSTANT = '2026-07-30T12:00:00Z';
export const LATER_INSTANT = '2026-07-30T12:01:00Z';

export const sessionView = {
  config: {
    id: 'session-1',
    incarnation: 'incarnation-1',
    runtimeGeneration: 1,
    name: 'Session One',
    agent: 'codex-auto-loge',
    harness: 'codex',
    modelHint: 'gpt-5.6-sol',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/workspace',
    createdAt: INSTANT,
    updatedAt: LATER_INSTANT,
    turn: 1,
    intervalSeconds: 30,
    timeoutSeconds: 120,
    nudgeAfterSeconds: 180,
    killAfterSeconds: 300,
    directSendMaxChars: 4_096,
    resumeMenuChoice: 'full',
    maxSnapshots: 10,
    retry: {
      transientAttempts: 1,
      stalledAttempts: 0,
      waitForQuotaReset: true,
      allowAccountFailover: false,
    },
  },
  state: {
    id: 'session-1',
    status: 'running',
    turn: 1,
  },
  directory: '/state/session-1',
} satisfies SessionView;

export const sendResult = {
  ...sessionView,
  disposition: 'delivered',
} satisfies SendResult;

export const sendRecord = {
  v: 1,
  sendId: 'send-1',
  acceptedAt: INSTANT,
  acceptedTurn: 1,
  path: 'direct',
  message: 'hello',
  attachmentIds: [],
  fate: 'timed_out',
  unaccountedReason: 'not_delivered',
  retryable: true,
} satisfies SendRecord;

export const fyEvent = {
  sequence: 1,
  time: INSTANT,
  sessionId: sessionView.config.id,
  turn: 1,
  type: 'session.started',
  source: 'daemon',
  data: { ok: true },
} satisfies FyEvent;

/** One wrapped event frame, as `/v1/events` emits it. */
export const fyEventFrame = { kind: 'event', event: fyEvent } satisfies FyEventStreamFrame;

/** The scoped heartbeat: quiet, but naming the cursor it is quiet at. */
export const sessionIdleFrame = {
  kind: 'idle',
  idleSeconds: 30,
  scope: { kind: 'session', sessionId: sessionView.config.id, after: 1 },
} satisfies FyEventStreamFrame;

/** A working turn's live readout, as a `?live=1` session stream emits it. */
export const liveFrame = {
  kind: 'live',
  live: {
    sessionId: sessionView.config.id,
    at: '2026-10-18T07:00:05.000Z',
    turnStartedAt: '2026-10-18T07:00:00.000Z',
    verb: 'Pontificating…',
    outputTokens: 3_100,
    inputTokens: 48_000,
    outputSource: 'transcript',
  },
} satisfies FyEventStreamFrame;

/** The fleet heartbeat, which invents no global cursor. */
export const fleetIdleFrame = {
  kind: 'idle',
  idleSeconds: 45,
  scope: { kind: 'fleet', followedSessions: 3 },
} satisfies FyEventStreamFrame;

/** Short-lived process evidence: never derived from a session view. */
export const sessionAttachTarget = {
  socketPath: '/run/user/1000/fy/tmux.sock',
  tmuxSession: 'fy-session-1',
  paneId: '%7',
  pid: 4_242,
  processStartTicks: 987_654,
} satisfies SessionAttachTarget;

export const healthView = {
  ok: true,
  bootstrapping: false,
  bootstrapState: 'complete',
  bootstrapDegraded: false,
  version: '1.2.3',
  pid: 123,
  sessions: 1,
  running: 1,
  monitors: 1,
  unmonitoredRunning: 0,
  wardenLastSweepSeconds: 5,
  wardenTimerArmed: true,
  eventLoopLagMs: 1,
  lastSelfCheckAt: INSTANT,
  wedgeCount: 0,
  scratchGcEnabled: true,
  scratchReclaimedSessions: 0,
  scratchReclaimedBytes: 0,
  bootstrapErrors: 0,
  time: INSTANT,
} satisfies HealthView;

export const wardenConfig = {
  enabled: true,
  layers: { jev: true, llm: true },
  guard: { threshold: 0.85, model: 'jev-latest', usdPerMillionInputTokens: 0.042 },
  caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2, maxInvestigationsPerHour: 6 },
  mayActAlone: { nudge: true, resume: true, restart: true, failover: true, stop: false, closeLeftovers: true },
  jevActs: { nudge: 0.9, resume: 0.93, restart: 0.95, stop: 0.98 },
  events: { turnEnd: true, question: true, paneDied: true },
  investigation: { effort: 'low' },
  accounts: [{ agent: 'codex-auto-loge', model: 'gpt-5.6-sol' }],
  revive: {
    enabled: true,
    windowMinutes: 15,
    cooldownMinutes: 30,
    waveSize: 3,
    waveGapSeconds: 10,
    breakerMinutes: 30,
  },
  autoMigrate: {
    enabled: true,
    when: ['rate_limited'],
    targets: ['claude-b'],
    forceStopBackground: false,
    waitMinutes: 10,
    maxMovesPerHour: 1,
    minHeadroomPercent: 20,
  },
  failover: { policy: 'fallback', failureThreshold: 2, cooldownMinutes: 10 },
  providerOutage: { minDistinctSessions: 2, persistenceSweeps: 2, tailLines: 20 },
  intervalMinutes: 5,
  unattendedMinutes: 10,
  minSpawnGapMinutes: 0,
  susThinkingSeconds: 900,
  susSubprocessSeconds: 900,
  maxAssignedWardens: 2,
  assignedCooldownMinutes: 5,
  blessMinutes: 5,
} satisfies WardenConfig;

export const wardenStatusView = {
  config: wardenConfig,
  anomalies: [],
  fingerprint: 'none',
  triage: {
    jev: { configured: true, active: true, reason: 'configured' },
    llm: { configured: true, active: true, reason: 'configured' },
  },
  spend: {
    day: '2026-10-16',
    jevUsd: 0.03,
    jevCapUsd: 0.5,
    investigationUsd: 1.2,
    investigationCapUsd: 2,
    pendingInvestigations: 0,
    capsHit: [],
    investigationsLastHour: 1,
    maxInvestigationsPerHour: 6,
  },
  savings: { day: '2026-10-16', flags: 41, jevDecisions: 37, jevSkips: 37, investigations: 4 },
  investigations: [],
  actions: [],
  blessings: [],
} satisfies WardenStatusView;

export const wardenAgendaView = {
  generatedAt: INSTANT,
  lastSweepAt: INSTANT,
  outcome: 'items',
  items: [
    {
      sessionId: 'session-1',
      id: 'anomaly:unattended_question:session-1',
      source: 'warden-anomaly',
      subject: 'Question unanswered',
      why: 'waiting 18 minutes',
      waitingSince: INSTANT,
      howToResolve: 'Open the session and decide what to do.',
      fromAnomaly: true,
      anomalyKind: 'unattended_question',
      judgement: { state: 'none', reason: 'No matching warden judgement yet.' },
    },
  ],
  boardsWithParseErrors: [],
  verdictCoverage: { limit: 100, truncated: false },
} satisfies WardenAgendaView;

export const wardenInvestigateView = {
  sessionId: 'session-1',
  state: 'queued',
  position: 1,
  message: 'Queued: one investigation runs at a time.',
} satisfies WardenInvestigateView;

export const wardenRunView = {
  sweptAt: INSTANT,
  anomalies: [],
} satisfies WardenRunView;

export const wardenConfigView = {
  config: wardenConfig,
  accounts: wardenConfig.accounts,
  warnings: [],
} satisfies WardenConfigView;

export const cgroupConfigView = {
  config: {
    enabled: true,
    fleet: { cpuPercent: 80, memoryPercent: 80 },
    perAgent: { cpuPercent: 40, memoryPercent: 40 },
  },
  supported: true,
  fleetSlice: 'ferretry-fleet.slice',
  // The values a host manager is actually given: a percentage of the WHOLE machine for CPU — 80% of
  // eight CPUs is `640%` — and decimal bytes for memory. This fixture used to carry the unified
  // hierarchy's raw `cpu.max` pair (`"640000 100000"`), which is a second spelling of the same fact
  // and one no `set-property` would accept. `packages/daemon/src/lib/cgroups/limits.ts` owns the
  // conversion; every fixture, wire value and written property comes from it.
  effective: {
    cpus: 8,
    memoryBytes: 8_000_000,
    fleet: { cpuQuota: '640%', memoryMax: '6400000' },
    perAgent: { cpuQuota: '320%', memoryMax: '3200000' },
  },
  restartRequiredSessions: [],
  warnings: [],
} satisfies CgroupConfigView;

export const pwaConfigView = {
  config: { version: 1, name: 'F controls', icon: 'F' },
} satisfies PwaConfigView;

export const usageFeedView = {
  at: INSTANT,
  stale: false,
  accounts: [
    {
      agent: 'codex-auto-loge',
      usageBased: true,
      provider: 'openai',
      availability: 'available',
      unavailable: false,
      fiveHourPercent: 25,
      weeklyPercent: 10,
      atLimit: false,
      authOk: true,
    },
  ],
} satisfies UsageFeedView;

export const analyticsResponse = {
  query: '',
  parsed: { groupBy: [], matchers: [] },
  scope: { allSessions: true, indexed: 1, matched: 1 },
  index: {
    schemaVersion: 1,
    sessions: 1,
    tokenSessions: 1,
    transcriptSources: 1,
    indexedTranscriptSources: 1,
    pendingTranscriptSources: 0,
    sourceErrors: 0,
    refreshing: false,
  },
  kind: 'raw',
  limit: 10,
  truncated: false,
  results: [],
} satisfies AnalyticsResponse;

export const scratchPlanView = {
  sessionId: sessionView.config.id,
  directory: '/state/session-1/scratch',
  bytes: 12,
  entries: [{ name: 'result.txt', bytes: 12, kind: 'file' }],
  eligible: true,
} satisfies ScratchPlanView;

export const scratchSweepView = {
  sessions: 1,
  bytes: 12,
  failures: 0,
} satisfies ScratchSweepView;

export const attachmentView = {
  id: 'attachment-1',
  filename: 'note.txt',
  mime: 'text/plain',
  size: 4,
  sha256: 'a'.repeat(64),
  createdAt: INSTANT,
} satisfies AttachmentView;

export const daemonUpdateView = {
  current: '4.28.0',
  method: { kind: 'homebrew', cask: 'ferretry' },
  plan: {
    kind: 'self',
    steps: [{ command: 'brew upgrade --cask ferretry' }, { command: 'fy daemon restart' }],
    rollback: 'none',
  },
  check: {
    state: 'ok',
    checkedAt: '2026-10-18T09:00:00.000Z',
    latest: { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' },
  },
  available: true,
  midTurn: 0,
  autoInstall: false,
  job: null,
} as const;

export const wardenLeaveView = {
  blessing: { sessionId: 'session-1', kinds: ['sus_thinking'], expiresAt: INSTANT, by: 'owner' },
  message: 'Left alone for 4 h: a new kind of trouble or a change of status still raises a flag.',
} satisfies WardenLeaveView;

export const harnessUpdateView = {
  harnesses: [
    {
      harness: 'claude',
      location: {
        state: 'located',
        path: '/opt/homebrew/bin/claude',
        rule: 'inherited environment',
        declaredBy: 'PATH',
      },
      installed: { state: 'ok', version: '2.1.200' },
      method: { kind: 'homebrew', type: 'cask', package: 'claude-code' },
      plan: {
        kind: 'self',
        steps: [{ command: 'brew update' }, { command: 'brew upgrade --cask claude-code' }],
        rollback: 'none',
        pinsVersion: false,
      },
      check: {
        state: 'ok',
        checkedAt: '2026-10-18T09:00:00.000Z',
        latest: { version: '2.1.230', url: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md' },
      },
      verified: {
        version: '2.1.220',
        url: 'https://github.com/kirinnee/ferretry/blob/main/packages/fleet/tests/contract/README.md',
      },
      verification: 'older',
      available: true,
      job: null,
    },
  ],
} as const;
