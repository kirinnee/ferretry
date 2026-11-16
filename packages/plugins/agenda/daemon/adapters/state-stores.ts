import type { StatePort } from '@ferretry/kernel/contract';
import { MODES, NUDGES, REST_NUDGES, type RestNudgesFile, SEEN } from '../../contract/index.ts';
import { pruneRecords, type RestNudgeRecord, type RestNudgeStore } from '../lib/rest-nudge.ts';
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

/** The rest nudge's counters (`state/agenda/rest-nudges.json`): what caps how often a silent ferret is nudged, across a restart. */
export class StateRestNudgeStore implements RestNudgeStore {
  constructor(private readonly state: StatePort) {}

  async records(ferret: string): Promise<Readonly<Record<string, RestNudgeRecord>>> {
    const read = await this.state.read(REST_NUDGES);
    if (!read.ok) throw new Error(read.error.sentence);
    return read.value?.ferrets[ferret] ?? {};
  }

  async reserve(
    ferret: string,
    taken: Readonly<Record<string, RestNudgeRecord>>,
    live: readonly string[],
  ): Promise<void> {
    await this.write(ferret, held => ({
      ...Object.fromEntries(Object.entries(held).filter(([id]) => live.includes(id))),
      ...taken,
    }));
  }

  async release(
    ferret: string,
    sendId: string,
    prior: Readonly<Record<string, RestNudgeRecord | undefined>>,
  ): Promise<void> {
    await this.write(ferret, held => {
      const next = { ...held };
      for (const [id, before] of Object.entries(prior)) {
        if (next[id]?.sendId !== sendId) continue;
        if (before === undefined) delete next[id];
        else next[id] = before;
      }
      return next;
    });
  }

  async prune(roster: readonly string[], resting: Readonly<Record<string, readonly string[]>>): Promise<void> {
    const read = await this.state.read(REST_NUDGES);
    if (!read.ok) throw new Error(read.error.sentence);
    // Nothing to drop is no write at all: a sweep every minute must not rewrite an unchanged file.
    const held = read.value?.ferrets ?? {};
    if (pruneRecords(held, roster, resting) === held) return;
    const result = await this.state.update(REST_NUDGES, current => ({
      format: 1 as const,
      // Pruned again over what is there NOW (a reservation may have landed since the read); the instants are the file's own.
      ferrets: pruneRecords(current?.ferrets ?? {}, roster, resting) as RestNudgesFile['ferrets'],
    }));
    if (!result.ok) throw new Error(result.error.sentence);
  }

  /** Replaces one ferret's records, atomically with the read; a ferret left with none is removed from the file. */
  private async write(
    ferret: string,
    change: (held: Readonly<Record<string, RestNudgeRecord>>) => Record<string, RestNudgeRecord>,
  ): Promise<void> {
    const result = await this.state.update(REST_NUDGES, current => {
      const { [ferret]: held, ...others } = current?.ferrets ?? {};
      const next = change(held ?? {});
      return {
        format: 1 as const,
        // The instants were read from this file or from the clock; the lib holds them as plain strings.
        ferrets: (Object.keys(next).length === 0 ? others : { ...others, [ferret]: next }) as RestNudgesFile['ferrets'],
      };
    });
    if (!result.ok) throw new Error(result.error.sentence);
  }
}
