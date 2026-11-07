import type {
  FyEvent,
  FyEventStreamFrame,
  SessionAttachTarget,
  SessionView,
} from '../../../../daemon/lib/protocol/session.ts';

/** The session cut of today's protocol test fixtures (packages/protocol/tests/fixtures.ts), verbatim. */
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
