import type { StatePort } from '@ferretry/kernel/contract';
import { SystemCallsignsFile } from '../../../contract/state.ts';
import { SYSTEM_CALLSIGN_PREFIXES } from '../../lib/protocol/system-callsigns.ts';
import type { SystemCallsignCounters, SystemCallsignCounterStore } from '../../lib/names/index.ts';

/**
 * The system-callsign counters over `system-callsigns.json` (`SystemCallsignsFile`), today's
 * `FileSystemCallsignCounters`.
 *
 * READING IS TOTAL. A missing or damaged document means "nothing issued yet": the counter only decides where to start
 * looking, and the fleet's own held names (not this file) keep an issued id unique, so a lost counter costs a few
 * skipped-over ids and never a collision. WRITING IS ATOMIC (the state port), so a crash leaves no half a document.
 *
 * A damaged file is never written over (the kernel refuses), so the file alone could not advance. A per-prefix
 * HIGH-WATER MARK kept in memory covers that: `read` answers the larger of the file and the mark, and `write` moves
 * the mark BEFORE it tries the file. A refused write therefore still advances the counter for the life of the daemon,
 * and two issues never return the same id.
 */
export class StateCallsignCounters implements SystemCallsignCounterStore {
  private readonly highWater: SystemCallsignCounters = {};

  constructor(private readonly state: Pick<StatePort, 'read' | 'write'>) {}

  async read(): Promise<SystemCallsignCounters> {
    const read = await this.state.read(SystemCallsignsFile).catch(() => undefined);
    const stored = read === undefined || !read.ok || read.value === undefined ? {} : read.value;
    const counters: SystemCallsignCounters = {};
    for (const prefix of SYSTEM_CALLSIGN_PREFIXES) {
      const sequence = Math.max(stored[prefix] ?? 0, this.highWater[prefix] ?? 0);
      if (sequence > 0 || stored[prefix] !== undefined) counters[prefix] = sequence;
    }
    return counters;
  }

  async write(counters: SystemCallsignCounters): Promise<void> {
    for (const prefix of SYSTEM_CALLSIGN_PREFIXES) {
      const sequence = counters[prefix];
      if (sequence !== undefined) this.highWater[prefix] = Math.max(this.highWater[prefix] ?? 0, sequence);
    }
    try {
      await this.state.write(SystemCallsignsFile, { ...counters });
    } catch (error) {
      // The kernel never writes over a damaged file. The in-memory mark above already advanced, so the issue still moves
      // on; any other fault is real.
      if (!(error instanceof Error && error.name === 'StoreDamagedError')) throw error;
    }
  }
}
