import {
  COPY_AFTER_MASK_SECONDS,
  COPY_MAX_LIFETIME_SECONDS,
  INPUT_DEFAULT_REDACTION_SECONDS,
  INPUT_MAX_REDACTION_SECONDS,
} from '@ferretry/protocol';
import { coverageOf, type TextRange } from '../secrets/policy.ts';
import type { InputClock } from './ports.ts';

/**
 * THE VALUES THE DAEMON HAS JUST TYPED, held in RAM and masked from every read for a window.
 *
 * A password the owner typed into a terminal is echoed by nothing, but a `private` code or a `plain` word
 * shows on the screen, and the agent reads that screen. For `window` after a delivery, any read of that
 * session's surfaces replaces the value with `[redacted:input !A7]`. The map is per session, never written
 * to disk or a log, has no accessor that returns a value, and lets go of an entry the moment its window ends:
 * every call prunes the whole map, {@link purge} is the clock-driven sweep for a session nobody reads, and
 * {@link drop} empties a session that ended.
 */

const MIN_MASKED_LENGTH = 1;
const MAX_FRAGMENT_FLOOR = 3;

/** The shortest piece of a value that counts as the value: three characters, fewer for a value too short to have three. */
/** The longest a secure copy is masked for: its longest life, then the time it may still sit on a screen. */
const MAX_COPY_MASK_MS = (COPY_MAX_LIFETIME_SECONDS + COPY_AFTER_MASK_SECONDS) * 1000;

const fragmentFloor = (length: number): number => Math.min(MAX_FRAGMENT_FLOOR, Math.ceil(length / 2));

interface Held {
  readonly value: string;
  readonly label: string;
  readonly until: number;
  /** The whole replacement text, when it is not `[redacted:input <label>]` (a secure copy's `[sealed:<name>]`). */
  readonly marker?: string;
}

export class EphemeralValues {
  private readonly held = new Map<string, readonly Held[]>();

  constructor(private readonly clock: InputClock) {}

  /** Mask `value` from `sessionId`'s reads for `seconds` (the default, capped), as `[redacted:input <label>]`. */
  hold(sessionId: string, value: string, label: string, seconds = INPUT_DEFAULT_REDACTION_SECONDS): void {
    if (value.length < MIN_MASKED_LENGTH) return;
    this.purge();
    const lasting = Math.min(Math.max(seconds, 1), INPUT_MAX_REDACTION_SECONDS);
    this.held.set(sessionId, [
      ...(this.held.get(sessionId) ?? []),
      { value, label, until: this.clock.now() + lasting * 1000 },
    ]);
  }

  /**
   * Mask `value` from `sessionId`'s reads until `until` (epoch milliseconds) as `marker`: a secure copy, which
   * lives longer than a typed value's window (docs/secure-copy.md). Capped at a copy's longest life and after-mask.
   */
  holdUntil(sessionId: string, value: string, marker: string, until: number): void {
    if (value.length < MIN_MASKED_LENGTH) return;
    this.purge();
    const latest = this.clock.now() + MAX_COPY_MASK_MS;
    this.held.set(sessionId, [
      ...(this.held.get(sessionId) ?? []),
      { value, label: marker, marker, until: Math.min(until, latest) },
    ]);
  }

  /** Brings forward the end of every hold of `sessionId` masked as `marker` to `until`, never later than it was. */
  retime(sessionId: string, marker: string, until: number): void {
    const entries = this.held.get(sessionId);
    if (entries === undefined) return;
    this.held.set(
      sessionId,
      entries.map(entry => (entry.marker === marker ? { ...entry, until: Math.min(entry.until, until) } : entry)),
    );
    this.purge();
  }

  /** `text` with every held value of this session replaced, longest first so a value containing another is whole-masked. */
  scrub(sessionId: string, text: string): string {
    this.purge();
    return mask(this.held.get(sessionId) ?? [], text);
  }

  /** `text` with every held value of EVERY session replaced: for a read that is not one session's, so it fails closed. */
  scrubAll(text: string): string {
    this.purge();
    return mask([...this.held.values()].flat(), text);
  }

  /** WHERE `text` holds a value of ANY session: positions only, for masking a screen by cell. */
  coverAll(text: string): readonly TextRange[] {
    this.purge();
    return coverageOf(
      text,
      [...this.held.values()].flat().map(entry => entry.value),
    );
  }

  /** Lets go of every value whose window has ended, in every session. */
  purge(): void {
    const now = this.clock.now();
    for (const [sessionId, entries] of this.held) {
      const live = entries.filter(entry => entry.until > now);
      if (live.length === 0) this.held.delete(sessionId);
      else if (live.length !== entries.length) this.held.set(sessionId, live);
    }
  }

  /**
   * Lets go of everything typed for a session that ended. A secure copy's mask stays for its after-mask window
   * (docs/secure-copy.md): the value may still be on a screen it was pasted to, and other sessions read screens too.
   */
  drop(sessionId: string): void {
    const latest = this.clock.now() + COPY_AFTER_MASK_SECONDS * 1000;
    const copies = (this.held.get(sessionId) ?? [])
      .filter(entry => entry.marker !== undefined)
      .map(entry => ({ ...entry, until: Math.min(entry.until, latest) }));
    if (copies.length === 0) this.held.delete(sessionId);
    else this.held.set(sessionId, copies);
  }

  /** How many values are held, for one session or all: a count, never a value, so a test can prove one was let go. */
  heldCount(sessionId?: string): number {
    return sessionId === undefined
      ? [...this.held.values()].reduce((total, entries) => total + entries.length, 0)
      : (this.held.get(sessionId)?.length ?? 0);
  }

  /**
   * Whether `text` ends with the START of a value this session holds, or starts with the END of one (three
   * characters or more, or half of a shorter value): the piece of a value that wrapped over a row boundary, which no whole-value match can
   * find. A yes/no for the daemon's own projection, never a position or a character: nothing returns a value.
   */
  fragments(sessionId: string, text: string): boolean {
    this.purge();
    return (this.held.get(sessionId) ?? []).some(({ value }) => {
      for (let size = fragmentFloor(value.length); size < value.length; size += 1) {
        if (text.endsWith(value.slice(0, size)) || text.startsWith(value.slice(value.length - size))) return true;
      }
      return false;
    });
  }

  /** The sessions that hold a value now. */
  sessions(): readonly string[] {
    return [...this.held.keys()];
  }
}

function mask(entries: readonly Held[], text: string): string {
  return [...entries]
    .sort((a, b) => b.value.length - a.value.length)
    .reduce((result, entry) => result.replaceAll(entry.value, entry.marker ?? `[redacted:input ${entry.label}]`), text);
}
