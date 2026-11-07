import type { IPasskeyLocalTime } from '../../lib/passkey/ports.ts';

/**
 * `HH:MM` on this machine's own clock, 24-hour.
 *
 * Fixed to `en-GB` and `h23` rather than the ambient locale: the sentence is an instruction to read a
 * time off a wall clock, and a locale that renders `2:32 PM` in one terminal and `14:32` in another is
 * not the same instruction. The ZONE is still the machine's, which is the point.
 */
export class IntlLocalTime implements IPasskeyLocalTime {
  readonly #format = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  clockTime(instant: string): string {
    return this.#format.format(new Date(instant));
  }
}
