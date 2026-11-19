/**
 * A read a person PRESSED for (A555 r7, PR 2057): a "Try again" / "Retry" that runs a governed read again is the
 * person's own act, so it is sent with `quiet: false` and asks for its passkey at once, even after a Cancel. The page's
 * own reads (a panel opening, a poll) stay unmarked and never open the prompt. Every retry button marks its read with
 * this one helper: `client.call(route, { ...readPress(pressed) })`.
 */

/** The call init a press adds to a read; nothing for the page's own read. */
export interface ReadPress {
  readonly quiet?: false;
}

/** `{ quiet: false }` for a read a person pressed for, `{}` for one the page made by itself. */
export const readPress = (pressed: boolean): ReadPress => (pressed ? { quiet: false } : {});
