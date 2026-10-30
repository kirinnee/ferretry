import { INPUT_DEFAULT_REDACTION_SECONDS, INPUT_MAX_REDACTION_SECONDS } from '@ferretry/protocol';
import type { InputClock } from './ports.ts';

/**
 * THE VALUES THE DAEMON HAS JUST TYPED, held in RAM and masked from every read for a window.
 *
 * A password the owner typed into a terminal is echoed by nothing, but a `private` code or a `plain` word
 * shows on the screen, and the agent reads that screen. For `window` after a delivery, any read of that
 * session's surfaces replaces the value with `[redacted:input !A7]`. The map is per session, never written
 * to disk or a log, dropped when it lapses or the daemon stops, and has no accessor that returns a value:
 * the only question it answers is "scrub this text".
 */

const MIN_MASKED_LENGTH = 1;

interface Held {
  readonly value: string;
  readonly label: string;
  readonly until: number;
}

export class EphemeralValues {
  private readonly held = new Map<string, Held[]>();

  constructor(private readonly clock: InputClock) {}

  /** Mask `value` from `sessionId`'s reads for `seconds` (the default, capped), as `[redacted:input <label>]`. */
  hold(sessionId: string, value: string, label: string, seconds = INPUT_DEFAULT_REDACTION_SECONDS): void {
    if (value.length < MIN_MASKED_LENGTH) return;
    const lasting = Math.min(Math.max(seconds, 1), INPUT_MAX_REDACTION_SECONDS);
    const entries = this.live(sessionId);
    entries.push({ value, label, until: this.clock.now() + lasting * 1000 });
    this.held.set(sessionId, entries);
  }

  /** `text` with every held value of this session replaced, longest first so a value containing another is whole-masked. */
  scrub(sessionId: string, text: string): string {
    const entries = this.live(sessionId);
    if (entries.length === 0) return text;
    return [...entries]
      .sort((a, b) => b.value.length - a.value.length)
      .reduce((result, entry) => result.replaceAll(entry.value, `[redacted:input ${entry.label}]`), text);
  }

  private live(sessionId: string): Held[] {
    const now = this.clock.now();
    const entries = (this.held.get(sessionId) ?? []).filter(entry => entry.until > now);
    if (entries.length === 0) this.held.delete(sessionId);
    return entries;
  }
}
