import {
  SessionConfigSchema,
  SessionStateSchema,
  type SessionView,
} from '../../../daemon/lib/protocol/session.ts';

/**
 * TEST FIXTURE: today's `sessionView` from `packages/daemon/tests/unit/runtime/mounts/support.ts` (placed kernel), cut
 * verbatim so the Ferrets session tests that only need one view do not depend on the kernel's mount support file.
 */
export const AT = '2024-05-01T10:00:00.000Z';

/**
 * One session view, with only the fields a case cares about spelled out.
 *
 * Every document goes through the PROTOCOL schemas, so a fixture cannot drift from what the wire
 * demands: a view the schema would reject cannot be handed to a route here and pass.
 */
export function sessionView(
  id: string,
  config: Readonly<Record<string, unknown>> = {},
  state: Readonly<Record<string, unknown>> = {},
): SessionView {
  return {
    config: SessionConfigSchema.parse({
      id,
      incarnation: `${id}-1`,
      runtimeGeneration: 1,
      name: 'Wire Subsystems',
      agent: 'claude-auto',
      harness: 'claude',
      modelHint: 'opus',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: '/work/ferretry',
      createdAt: AT,
      updatedAt: AT,
      turn: 1,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4_096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
      ...config,
    }),
    state: SessionStateSchema.parse({ id, status: 'running', turn: 1, lastActivityAt: AT, ...state }),
    directory: `/state/sessions/${id}`,
  };
}
