import type { SessionConfig, SessionState, SessionView } from '@ferretry/protocol';

const CONFIG: SessionConfig = {
  id: 'ses-1',
  incarnation: 'inc-1',
  runtimeGeneration: 1,
  name: 'Fix Transcript Scrolling',
  boardAccess: 'none',
  agent: 'claude-alpha',
  harness: 'claude',
  modelHint: 'opus',
  mode: 'auto',
  remoteControl: false,
  harnessFlags: [],
  cwd: '/work/repo',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  turn: 3,
  intervalSeconds: 30,
  timeoutSeconds: 0,
  nudgeAfterSeconds: 180,
  killAfterSeconds: 300,
  directSendMaxChars: 500,
  resumeMenuChoice: 'full',
  maxSnapshots: 5,
  retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
};

const STATE: SessionState = { id: 'ses-1', status: 'running', turn: 3 };

/** A session view with the fields a test cares about overridden. */
export function sessionView(
  config: Partial<SessionConfig> = {},
  state: Partial<SessionState> = {},
  directory = '/state/sessions/ses-1',
): SessionView {
  return { config: { ...CONFIG, ...config }, state: { ...STATE, ...state }, directory };
}
