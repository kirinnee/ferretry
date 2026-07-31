import type { SessionStatus, SessionView } from '@ferretry/protocol';

export interface SessionSeed {
  readonly id: string;
  readonly name?: string;
  readonly parent?: string;
  readonly label?: string;
  readonly teammate?: string;
  readonly status?: SessionStatus;
}

/** A complete `SessionView` so the plan logic is exercised against the real wire shape. */
export function session(seed: SessionSeed): SessionView {
  return {
    config: {
      id: seed.id,
      incarnation: `${seed.id}-1`,
      runtimeGeneration: 1,
      name: seed.name ?? seed.id,
      ...(seed.teammate ? { teammate: seed.teammate } : {}),
      ...(seed.label === undefined ? {} : { label: seed.label }),
      ...(seed.parent === undefined ? {} : { parent: seed.parent }),
      boardAccess: 'none',
      agent: 'claude-test',
      harness: 'claude',
      modelHint: 'default',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: '/workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      turn: 0,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 0,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    },
    state: { id: seed.id, status: seed.status ?? 'running', turn: 0 },
    directory: `/state/${seed.id}`,
  };
}

export const ids = (targets: readonly { id: string }[]): string[] => targets.map(target => target.id);
