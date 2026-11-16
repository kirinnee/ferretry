import type { StateFileDef } from '@ferretry/kernel/contract';
import type { StatePort } from '@ferretry/kernel/contract';
import type { SweepFile } from '../../../contract/index.ts';
import {
  type BoardDiagnostics,
  EMPTY_SWEEP_MEMORY,
  type SweepMemory,
  type SweepMemoryStore,
} from '../../lib/board/index.ts';

/**
 * The board sweep's memory (`state/board/sweep.json`): what the last tick saw and when each card was nudged. Damage reads
 * as a fresh start — every card a baseline again, no nudge remembered — and is reported once per read: losing it costs
 * at most one early nudge per stale card.
 */
export class KernelSweepMemory implements SweepMemoryStore {
  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef<string, SweepFile>,
    private readonly diagnostics: BoardDiagnostics,
  ) {}

  async read(): Promise<SweepMemory> {
    const read = await this.state.read(this.file);
    if (!read.ok) {
      this.diagnostics.warn('the board sweep memory is damaged; starting it again');
      return EMPTY_SWEEP_MEMORY;
    }
    return read.value ?? EMPTY_SWEEP_MEMORY;
  }

  async write(memory: SweepMemory): Promise<void> {
    await this.state.write(this.file, memory);
  }
}
