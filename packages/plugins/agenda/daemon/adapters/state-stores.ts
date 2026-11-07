import type { StatePort } from '@ferretry/kernel/contract';
import { MODES, SEEN } from '../../contract/index.ts';
import type { SeenStore } from '../lib/seen.ts';
import { emptySeen } from '../lib/seen.ts';

/** `state/agenda/seen.json` over the kernel's state folder. A damaged file refuses rather than reading as empty. */
export class StateSeenStore implements SeenStore {
  constructor(private readonly state: StatePort) {}

  async read() {
    const read = await this.state.read(SEEN);
    if (!read.ok) throw new Error(read.error.sentence);
    return read.value ?? emptySeen();
  }

  async update(change: Parameters<SeenStore['update']>[0]): Promise<void> {
    const result = await this.state.update(SEEN, current => change(current ?? emptySeen()));
    if (!result.ok) throw new Error(result.error.sentence);
  }
}

/** Each ferret's own recorded agenda mode (`state/agenda/modes.json`). */
export class StateModeStore {
  constructor(private readonly state: StatePort) {}

  async recorded(ferret: string): Promise<boolean | undefined> {
    const read = await this.state.read(MODES);
    if (!read.ok) throw new Error(read.error.sentence);
    return read.value?.modes[ferret]?.enabled;
  }

  async write(ferret: string, enabled: boolean, at: string): Promise<void> {
    const result = await this.state.update(MODES, current => ({
      format: 1 as const,
      modes: { ...(current?.modes ?? {}), [ferret]: { enabled, at: at as never } },
    }));
    if (!result.ok) throw new Error(result.error.sentence);
  }
}
