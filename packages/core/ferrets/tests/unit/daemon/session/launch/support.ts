import {
  type SessionConfig,
  SessionConfigSchema,
  type SessionState,
  SessionStateSchema,
} from '../../../../../daemon/lib/protocol/session.ts';

/** When every fixture session was created. */
const CREATED = '2027-01-15T08:00:00.000Z';

/** One session document, through the protocol schema so a fixture cannot drift from the wire. */
export function launchConfig(overrides: Readonly<Record<string, unknown>> = {}): SessionConfig {
  return SessionConfigSchema.parse({
    id: 's1',
    incarnation: 's1-1',
    runtimeGeneration: 1,
    name: 'Keep Settings Current',
    agent: 'claude-auto-boot',
    harness: 'claude',
    modelHint: 'claude-opus-5',
    model: 'claude-opus-5',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/work/ferretry',
    createdAt: CREATED,
    updatedAt: CREATED,
    turn: 1,
    intervalSeconds: 30,
    timeoutSeconds: 0,
    nudgeAfterSeconds: 0,
    killAfterSeconds: 0,
    directSendMaxChars: 4_096,
    resumeMenuChoice: 'full',
    maxSnapshots: 10,
    retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    ...overrides,
  });
}

/** One session state, through the protocol schema. */
export function launchState(overrides: Readonly<Record<string, unknown>> = {}): SessionState {
  return SessionStateSchema.parse({ id: 's1', status: 'running', turn: 1, lastActivityAt: CREATED, ...overrides });
}
