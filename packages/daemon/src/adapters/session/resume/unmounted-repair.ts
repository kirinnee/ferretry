import type { SessionHealthRepairPort } from '../../../lib/session/health/service.ts';

/**
 * The repair port for a daemon that does not yet run monitors or a warden.
 *
 * It refuses loudly rather than succeeding silently. Nothing calls it while the matching
 * `supervises*` flag is false, so a call reaching here means a capability was declared that was
 * never mounted — and a repair that pretends to work is how a fleet ends up unsupervised with a
 * green health check. Deleting this class is part of mounting either subsystem.
 */
export class UnmountedSupervisionRepair implements SessionHealthRepairPort {
  async startMonitor(id: string): Promise<void> {
    throw new Error(`no session monitor subsystem is mounted; cannot start a monitor for ${id}`);
  }

  async rearmWarden(): Promise<void> {
    throw new Error('no warden sweep timer is mounted; cannot re-arm it');
  }
}
