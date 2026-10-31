import { INPUT_QUARANTINE_SECONDS } from '@ferretry/protocol';
import type { InputClock } from './ports.ts';

/**
 * THE TERMINALS A SECRET WAS JUST TYPED INTO, kept out of an agent's reach for a window.
 *
 * Masking a screen can only hide a value it can recognise. A terminal that was just handed a secret is
 * therefore not read by the agent at all until the window ends or the owner ends it: the quarantine is the
 * confidentiality boundary, and masking stays behind it as defence in depth.
 *
 * A terminal can carry several holds at once, each owned by one delivery attempt (or one replayed journal
 * entry). An attempt that fails lets go of ITS hold only: it never lifts the hold of a value that was
 * delivered before it. A hold taken for a delivery in flight cannot expire before the write is done: it
 * reads as a full window from now until it is settled or released.
 *
 * A hold names the terminal by every name a reader may use (its key and its id) and holds an end time, or is
 * unresolved (a write may be in flight, or may have landed before a restart) and then has none: it holds until
 * it is settled. It has no value, no digest and no length. Nothing here is written to disk: the daemon
 * journals each hold by its id, its names and its end time or unresolved state (`InputQuarantineEvent`) and
 * replays them with {@link restore}.
 *
 * Until the journal has been replayed after a restart the registry is {@link lock locked}: every terminal is
 * held. A session whose replay failed is locked on its own for a window.
 */

/** Stands for every terminal of a session. */
export const EVERY_TERMINAL = '*';

interface Entry {
  readonly id: string;
  readonly names: readonly string[];
  /** A settled hold ends here; an in-flight one is open until it is settled or released. */
  until: number | 'in-flight';
}

/** What a delivery attempt holds until it settles or lets go. */
export interface QuarantineHold {
  readonly id: string;
  readonly sessionId: string;
  readonly names: readonly string[];
}

export class QuarantineRegistry {
  private readonly held = new Map<string, Entry[]>();
  private next = 0;
  /** Every id this process minted since boot: a replay never owns those, whatever the journal says of them. */
  private readonly minted = new Set<string>();
  private locked: number | true | undefined;

  constructor(
    private readonly clock: InputClock,
    private readonly window = INPUT_QUARANTINE_SECONDS * 1000,
  ) {}

  /** Hold the terminal known by `names` for a delivery that is about to happen. It cannot expire until settled or released. */
  begin(sessionId: string, names: readonly string[], owner: string): QuarantineHold {
    const hold: QuarantineHold = { id: this.mint(owner), sessionId, names: [...new Set(names)] };
    this.held.set(sessionId, [
      ...(this.held.get(sessionId) ?? []),
      { id: hold.id, names: hold.names, until: 'in-flight' },
    ]);
    return hold;
  }

  /** The write is done: the hold now runs for a full window from this moment. Returns its end time. */
  settle(hold: QuarantineHold): number {
    const until = this.clock.now() + this.window;
    const entry = this.entry(hold);
    if (entry === undefined) this.add(hold.sessionId, hold.names, until);
    else entry.until = until;
    return until;
  }

  /** Nothing was typed: let go of this hold alone. The latest end time still holding the terminal, or nothing. */
  release(hold: QuarantineHold): number | undefined {
    const rest = (this.held.get(hold.sessionId) ?? []).filter(entry => entry.id !== hold.id);
    this.store(hold.sessionId, rest);
    return this.until(hold.sessionId, hold.names);
  }

  /**
   * Bring a hold back as the journal had it (a restart): with its end time, or still unresolved. It adds
   * the hold, keeping its id, and never replaces another. Nothing comes back for an end time that has passed,
   * or for an id this process minted: that hold is live (a delivery admitted while the replay ran) and keeps
   * its own state until its owner settles or releases it.
   */
  restore(
    sessionId: string,
    names: readonly string[],
    until: number | 'in-flight',
    id: string,
  ): QuarantineHold | undefined {
    this.purge();
    if ((until !== 'in-flight' && until <= this.clock.now()) || names.length === 0) return undefined;
    if (this.minted.has(id) || this.entryById(sessionId, id) !== undefined) return undefined;
    const hold: QuarantineHold = { id, sessionId, names: [...new Set(names)] };
    this.held.set(sessionId, [...(this.held.get(sessionId) ?? []), { id, names: hold.names, until }]);
    return hold;
  }

  /** Every terminal is held until {@link unlock}, or until `until` when given. */
  lock(until?: number): void {
    this.locked = until ?? true;
  }

  unlock(): void {
    this.locked = undefined;
    this.minted.clear();
  }

  /** Every terminal of one session is held for a window from now: its journal could not be replayed. */
  lockSession(sessionId: string): void {
    this.add(sessionId, [EVERY_TERMINAL], this.clock.now() + this.window);
  }

  /** The holds that are unresolved: a write may have landed under them, and nothing has settled them yet. */
  unresolved(sessionId: string): readonly QuarantineHold[] {
    return (this.held.get(sessionId) ?? [])
      .filter(entry => entry.until === 'in-flight')
      .map(entry => ({ id: entry.id, sessionId, names: entry.names }));
  }

  /** When the quarantine on a terminal ends, or nothing when it is not quarantined. `names` are all the ways it is known. */
  until(sessionId: string, names: readonly (string | undefined)[]): number | undefined {
    this.purge();
    const now = this.clock.now();
    const wanted = names.filter((name): name is string => name !== undefined);
    const ends = (this.held.get(sessionId) ?? [])
      .filter(entry => entry.names.includes(EVERY_TERMINAL) || overlaps(entry.names, wanted))
      .map(entry => (entry.until === 'in-flight' ? now + this.window : entry.until));
    if (this.locked === true || (this.locked !== undefined && this.locked > now)) ends.push(now + this.window);
    return ends.length === 0 ? undefined : Math.max(...ends);
  }

  /**
   * The owner ends the quarantine on a terminal. A hold that is unresolved keeps holding. The holds actually
   * released, each by its id, or nothing when there was none to end.
   */
  end(sessionId: string, name: string): readonly QuarantineHold[] | undefined {
    this.purge();
    const entries = this.held.get(sessionId) ?? [];
    const target = entries.find(entry => entry.until !== 'in-flight' && entry.names.includes(name));
    if (target === undefined) return undefined;
    const gone = entries.filter(entry => entry.until !== 'in-flight' && overlaps(entry.names, target.names));
    this.store(
      sessionId,
      entries.filter(entry => !gone.includes(entry)),
    );
    return gone.map(entry => ({ id: entry.id, sessionId, names: entry.names }));
  }

  /** Every quarantine in a session: its first name and the end time. */
  list(sessionId: string): readonly { readonly key: string; readonly until: number }[] {
    this.purge();
    const now = this.clock.now();
    return (this.held.get(sessionId) ?? []).flatMap(entry => {
      const [key] = entry.names;
      return key === undefined || key === EVERY_TERMINAL
        ? []
        : [{ key, until: entry.until === 'in-flight' ? now + this.window : entry.until }];
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
      this.store(
        sessionId,
        entries.filter(entry => entry.until === 'in-flight' || entry.until > now),
      );
    }
  }

  /** The sessions with a quarantine now. */
  sessions(): readonly string[] {
    this.purge();
    return [...this.held.keys()];
  }

  private entryById(sessionId: string, id: string): Entry | undefined {
    return (this.held.get(sessionId) ?? []).find(entry => entry.id === id);
  }

  private entry(hold: QuarantineHold): Entry | undefined {
    return (this.held.get(hold.sessionId) ?? []).find(entry => entry.id === hold.id);
  }

  private add(sessionId: string, names: readonly string[], until: number): void {
    this.held.set(sessionId, [
      ...(this.held.get(sessionId) ?? []),
      { id: this.mint('hold'), names: [...new Set(names)], until },
    ]);
  }

  private mint(owner: string): string {
    const taken = new Set([...this.held.values()].flat().map(entry => entry.id));
    let id: string;
    do {
      this.next += 1;
      id = `${owner}/${String(this.next)}`;
    } while (taken.has(id));
    this.minted.add(id);
    return id;
  }

  private store(sessionId: string, entries: Entry[]): void {
    if (entries.length === 0) this.held.delete(sessionId);
    else this.held.set(sessionId, entries);
  }
}

const overlaps = (left: readonly string[], right: readonly string[]): boolean =>
  left.some(name => right.includes(name));
