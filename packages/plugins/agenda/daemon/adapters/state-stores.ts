import type { StatePort } from '@ferretry/kernel/contract';
import { MODES, NUDGES, SEEN } from '../../contract/index.ts';
import type { NudgeMark, NudgeStore } from '../lib/turn-nudge.ts';
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

/** The turn-end nudge each ferret holds (`state/agenda/nudges.json`): what stops a nudge from starting a chain of nudges. */
export class StateNudgeStore implements NudgeStore {
  constructor(private readonly state: StatePort) {}

  async mark(ferret: string): Promise<NudgeMark | undefined> {
    const read = await this.state.read(NUDGES);
    if (!read.ok) throw new Error(read.error.sentence);
    return read.value?.nudged[ferret];
  }

  async reserve(ferret: string, taken: NudgeMark, replacing: string | undefined): Promise<boolean> {
    let won = false;
    const result = await this.state.update(NUDGES, current => {
      const held = current?.nudged[ferret];
      won = held?.sendId === replacing;
      return {
        format: 1 as const,
        nudged: won
          ? { ...(current?.nudged ?? {}), [ferret]: { sendId: taken.sendId, at: taken.at as never } }
          : (current?.nudged ?? {}),
      };
    });
    if (!result.ok) throw new Error(result.error.sentence);
    return won;
  }

  async release(ferret: string, sendId: string): Promise<void> {
    const result = await this.state.update(NUDGES, current => {
      const { [ferret]: held, ...rest } = current?.nudged ?? {};
      return { format: 1 as const, nudged: held?.sendId === sendId ? rest : (current?.nudged ?? {}) };
    });
    if (!result.ok) throw new Error(result.error.sentence);
  }
}
