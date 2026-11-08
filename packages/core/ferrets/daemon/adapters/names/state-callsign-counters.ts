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
 * skipped-over ids and never a collision. WRITING IS ATOMIC (the state port), so a crash leaves no half a document. A damaged file is never written over (the
 * kernel refuses), so the next issue starts again from what the fleet holds.
 */
export class StateCallsignCounters implements SystemCallsignCounterStore {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write'>) {}

  async read(): Promise<SystemCallsignCounters> {
    const read = await this.state.read(SystemCallsignsFile).catch(() => undefined);
    if (read === undefined || !read.ok || read.value === undefined) return {};
    const counters: SystemCallsignCounters = {};
    for (const prefix of SYSTEM_CALLSIGN_PREFIXES) {
      const sequence = read.value[prefix];
      if (sequence !== undefined) counters[prefix] = sequence;
    }
    return counters;
  }

  async write(counters: SystemCallsignCounters): Promise<void> {
    try {
      await this.state.write(SystemCallsignsFile, { ...counters });
    } catch (error) {
      // The kernel never writes over a damaged file. The counter is a hint, so a refused write costs a few skipped ids
      // on the next issue and never a collision; any other fault is real.
      if (!(error instanceof Error && error.name === 'StoreDamagedError')) throw error;
    }
  }
}
