import { INPUT_DEFAULT_REDACTION_SECONDS, INPUT_MAX_REDACTION_SECONDS } from '@ferretry/protocol';
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

interface Held {
  readonly value: string;
  readonly label: string;
  readonly until: number;
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

  /** Lets go of every value whose window has ended, in every session. */
  purge(): void {
    const now = this.clock.now();
    for (const [sessionId, entries] of this.held) {
      const live = entries.filter(entry => entry.until > now);
      if (live.length === 0) this.held.delete(sessionId);
      else if (live.length !== entries.length) this.held.set(sessionId, live);
    }
  }

  /** Lets go of everything held for a session that ended. */
  drop(sessionId: string): void {
    this.held.delete(sessionId);
  }

  /** How many values are held, for one session or all: a count, never a value, so a test can prove one was let go. */
  heldCount(sessionId?: string): number {
    return sessionId === undefined
      ? [...this.held.values()].reduce((total, entries) => total + entries.length, 0)
      : (this.held.get(sessionId)?.length ?? 0);
  }

  /** The sessions that hold a value now. */
  sessions(): readonly string[] {
    return [...this.held.keys()];
  }
}

function mask(entries: readonly Held[], text: string): string {
  return [...entries]
    .sort((a, b) => b.value.length - a.value.length)
    .reduce((result, entry) => result.replaceAll(entry.value, `[redacted:input ${entry.label}]`), text);
}
