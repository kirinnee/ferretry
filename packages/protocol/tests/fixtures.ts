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
  SendResult,
  SessionAttachTarget,
  SessionView,
  TaskBoardGrantRequestView,
  UsageFeedView,
  WardenConfig,
  WardenConfigView,
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
    boardAccess: 'none',
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

export const taskBoardGrantRequestView = {
  requestId: 'grant-1',
  targetSessionId: 'session-2',
  requestedRole: 'worker',
  createdAt: INSTANT,
  expiresAt: LATER_INSTANT,
  status: 'pending',
} satisfies TaskBoardGrantRequestView;

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
  accounts: [{ agent: 'codex-auto-loge', model: 'gpt-5.6-sol' }],
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
} satisfies WardenStatusView;

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
  fleetSlice: 'fy.slice',
  effective: {
    cpus: 8,
    memoryBytes: 8_000_000,
    fleet: { cpuQuota: '640000 100000', memoryMax: '6400000' },
    perAgent: { cpuQuota: '320000 100000', memoryMax: '3200000' },
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
