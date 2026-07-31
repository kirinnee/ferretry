import type { ResumeMonitorControl } from '../../../lib/session/resume/types.ts';

/**
 * Monitor control for a daemon that runs no per-session monitors yet.
 *
 * Both methods are genuine no-ops rather than pretences: there is no monitor to disarm before a
 * revive, and none to arm afterwards. That is a real (and stated) gap in supervision, not a claim
 * that supervision happened — the resume slice's ordering guarantees still hold, and the unit that
 * lands the monitor subsystem replaces this class with the real one.
 */
export class NoMonitorSupervision implements ResumeMonitorControl {
  async stop(): Promise<void> {}

  async start(): Promise<void> {}
}
