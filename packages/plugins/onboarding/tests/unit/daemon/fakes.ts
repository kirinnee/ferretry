import type { Clock, EventsPort, StateDamage, StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { err, instantFromEpochMs, ok } from '@ferretry/std';

/**
 * A StatePort for the one declared file, with the real store's rule that a schema may name `format` itself
 * (`packages/core/kernel/host/state/format.ts`). The kernel's in-memory test store does not retry with it yet.
 */
export class FakeProgressState {
  stored: unknown;
  damage: StateDamage | undefined;
  writes = 0;

  readonly port: StatePort = {
    read: async (file: StateFileDef) => {
      if (this.damage !== undefined) return err(this.damage);
      return ok(this.stored) as never;
    },
    write: async (file: StateFileDef, value: unknown) => {
      file.schema?.parse(value);
      this.stored = structuredClone(value);
      this.writes += 1;
    },
    update: async (file: StateFileDef, fn: (current: never) => unknown) => {
      if (this.damage !== undefined) return err(this.damage);
      const next = fn(this.stored as never);
      file.schema?.parse(next);
      this.stored = structuredClone(next);
      this.writes += 1;
      return ok(next) as never;
    },
    append: async () => {},
    lines: async function* () {},
    list: async () => [],
    remove: async () => {},
    sqlite: () => {
      throw new Error('no sqlite');
    },
    damaged: () => (this.damage === undefined ? [] : [this.damage]),
  } as unknown as StatePort;
}

export function damagedFile(): StateDamage {
  return {
    file: 'progress.json',
    reason: 'unparsable',
    sentence: 'state/onboarding/progress.json cannot be read, so Ferretry will not use it.',
  };
}

export class TickingClock implements Pick<Clock, 'now' | 'nowMs'> {
  constructor(private at = Date.parse('2026-11-06T09:00:00.000Z')) {}
  now = () => instantFromEpochMs(this.at);
  nowMs = () => this.at;
  advance(ms: number): void {
    this.at += ms;
  }
}

export class RecordingEvents implements EventsPort {
  readonly published: { event: string; payload: unknown }[] = [];
  publish<Name extends string, Payload>(event: { readonly name: Name }, payload: Payload): void {
    this.published.push({ event: event.name, payload });
  }
}
