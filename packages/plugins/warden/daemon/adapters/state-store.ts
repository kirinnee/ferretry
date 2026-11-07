import type { StatePort } from '@ferretry/kernel/contract';
import { WARDEN_STATE } from '../../contract/index.ts';
import type { AutoMoveMemory, WardenRuntimeState, WardenStateStore } from '../lib/index.ts';

const AUTO_MOVE_KEY = 'autoMoveMemory';

/** A file the kernel found damaged is never read as empty: the sweep fails and says so. */
export class WardenStateDamaged extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'WardenStateDamaged';
  }
}

/**
 * The sweep's memory (`state/warden/state.json`). The sweep writes its whole document each time; the move ledger lives in
 * the same file under its own key, so a sweep write keeps it and a ledger write keeps the sweep's.
 */
export class StateWardenStateStore implements WardenStateStore {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<unknown> {
    const read = await this.state.read(WARDEN_STATE);
    if (!read.ok) throw new WardenStateDamaged(read.error.sentence);
    if (read.value === undefined) return undefined;
    const { format: _format, [AUTO_MOVE_KEY]: _ledger, ...sweep } = read.value as Record<string, unknown>;
    return sweep;
  }

  async write(state: WardenRuntimeState): Promise<void> {
    const written = await this.state.update(WARDEN_STATE, current => {
      const ledger = (current as Record<string, unknown> | undefined)?.[AUTO_MOVE_KEY];
      return { ...state, ...(ledger === undefined ? {} : { [AUTO_MOVE_KEY]: ledger }), format: 1 as const };
    });
    if (!written.ok) throw new WardenStateDamaged(written.error.sentence);
  }
}

/** The move's own ledger: what it moved and when, kept in the same file. */
export class StateAutoMoveLedger {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<unknown> {
    const read = await this.state.read(WARDEN_STATE);
    if (!read.ok) throw new WardenStateDamaged(read.error.sentence);
    return (read.value as Record<string, unknown> | undefined)?.[AUTO_MOVE_KEY];
  }

  async write(memory: AutoMoveMemory): Promise<void> {
    const written = await this.state.update(WARDEN_STATE, current => ({
      ...(current as Record<string, unknown> | undefined),
      [AUTO_MOVE_KEY]: memory,
      format: 1 as const,
    }));
    if (!written.ok) throw new WardenStateDamaged(written.error.sentence);
  }
}
