import { INPUT_QUARANTINE_SECONDS } from '@ferretry/protocol';
import type { InputClock } from './ports.ts';

/**
 * THE TERMINALS A SECRET WAS JUST TYPED INTO, kept out of an agent's reach for a window.
 *
 * Masking a screen can only hide a value it can recognise. A terminal that was just handed a secret is
 * therefore not read by the agent at all until the window ends or the owner ends it: the quarantine is the
 * confidentiality boundary, and masking stays behind it as defence in depth.
 *
 * An entry names the terminal by every name a reader may use (its key and its id) and holds an end time.
 * It has no value, no digest and no length. Nothing here is written to disk: the daemon journals the
 * names and the end time (`InputQuarantineEvent`) and replays them with {@link restore}.
 */

interface Entry {
  readonly names: readonly string[];
  readonly until: number;
}

export class QuarantineRegistry {
  private readonly held = new Map<string, readonly Entry[]>();

  constructor(
    private readonly clock: InputClock,
    private readonly window = INPUT_QUARANTINE_SECONDS * 1000,
  ) {}

  /** Quarantine the terminal known by `names` in `sessionId` from now for the window; the end time. */
  start(sessionId: string, names: readonly string[]): number {
    const until = this.clock.now() + this.window;
    this.restore(sessionId, names, until);
    return until;
  }

  /** Bring a quarantine back with the end time it had (a restart, or a window being extended). */
  restore(sessionId: string, names: readonly string[], until: number): void {
    this.purge();
    if (until <= this.clock.now() || names.length === 0) return;
    const others = (this.held.get(sessionId) ?? []).filter(entry => !overlaps(entry.names, names));
    this.held.set(sessionId, [...others, { names: [...new Set(names)], until }]);
  }

  /** When the quarantine on a terminal ends, or nothing when it is not quarantined. `names` are all the ways it is known. */
  until(sessionId: string, names: readonly (string | undefined)[]): number | undefined {
    this.purge();
    const wanted = names.filter((name): name is string => name !== undefined);
    return (this.held.get(sessionId) ?? []).find(entry => overlaps(entry.names, wanted))?.until;
  }

  /** Ends the quarantine on a terminal; the names it was known by when it ended, or nothing if there was none. */
  end(sessionId: string, name: string): readonly string[] | undefined {
    this.purge();
    const entry = (this.held.get(sessionId) ?? []).find(candidate => candidate.names.includes(name));
    if (entry === undefined) return undefined;
    const rest = (this.held.get(sessionId) ?? []).filter(candidate => candidate !== entry);
    if (rest.length === 0) this.held.delete(sessionId);
    else this.held.set(sessionId, rest);
    return entry.names;
  }

  /** Every quarantine in a session: its first name and the end time. */
  list(sessionId: string): readonly { readonly key: string; readonly until: number }[] {
    this.purge();
    return (this.held.get(sessionId) ?? []).flatMap(entry => {
      const [key] = entry.names;
      return key === undefined ? [] : [{ key, until: entry.until }];
    });
  }

  /** Lets go of everything for a session that ended. */
  drop(sessionId: string): void {
    this.held.delete(sessionId);
  }

  /** Lets go of every quarantine whose window has ended. */
  purge(): void {
    const now = this.clock.now();
    for (const [sessionId, entries] of this.held) {
      const live = entries.filter(entry => entry.until > now);
      if (live.length === 0) this.held.delete(sessionId);
      else if (live.length !== entries.length) this.held.set(sessionId, live);
    }
  }

  /** The sessions with a quarantine now. */
  sessions(): readonly string[] {
    this.purge();
    return [...this.held.keys()];
  }
}

const overlaps = (left: readonly string[], right: readonly string[]): boolean =>
  left.some(name => right.includes(name));
