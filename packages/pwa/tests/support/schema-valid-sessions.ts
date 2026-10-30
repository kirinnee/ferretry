/**
 * A `SessionView` that PASSES `SessionViewSchema`, for the suites whose subject re-validates what it
 * stored (the session cache). `sessionView` in `./sessions.ts` is deliberately shaped for what the
 * shell renders and omits the launch fields the schema requires.
 */

import type { SessionView } from '@ferretry/protocol';
import { sessionView } from './sessions.ts';

export const schemaValidSessionView = (id: string): SessionView =>
  sessionView(id, {
    config: {
      incarnation: `incarnation-${id}`,
      runtimeGeneration: 1,
      remoteControl: false,
      harnessFlags: [],
      turn: 4,
      intervalSeconds: 30,
      timeoutSeconds: 120,
      nudgeAfterSeconds: 180,
      killAfterSeconds: 300,
      directSendMaxChars: 4_096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 1, stalledAttempts: 0, waitForQuotaReset: true, allowAccountFailover: true },
    } as never,
  });
