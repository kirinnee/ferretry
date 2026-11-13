/**
 * WHAT A KEY PRESS IN THE CONSOLE SENDS, as the bytes a terminal expects.
 *
 * The Console's input is a plain text field, not an emulator, so the keys a text field would swallow
 * or act on itself — Enter, Backspace, Tab, Escape, the arrows, Ctrl+letter — are translated here and
 * sent at keydown. Everything printable is left to the field's own `input` event instead, which is
 * what makes a phone keyboard, autocorrect and an IME composition work: none of them produce a
 * keydown that says which character they meant.
 */

import { controlCharacter } from './phone/terminal-keys.ts';

/** The four fields of a keyboard event this reads, so a test can describe a press without a DOM. */
export interface ConsoleKeyPress {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

const ESC = '\x1b';

const NAMED: Readonly<Record<string, string>> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: ESC,
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  Delete: `${ESC}[3~`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
};

/**
 * The bytes one key press sends, or `null` to let the field have it.
 *
 * `null` for anything with Meta held: Cmd+C, Cmd+V and Cmd+R are the browser's, and a Console that ate
 * them would make copying out of the page impossible. Ctrl+V is likewise left as a paste. Alt+key is
 * the terminal convention, ESC then the key, so the agent's line editor sees word motions.
 */
export function consoleKeyInput(press: ConsoleKeyPress): string | null {
  if (press.metaKey) return null;
  const named = NAMED[press.key];
  if (named !== undefined) return press.altKey ? `${ESC}${named}` : named;
  if (press.key.length !== 1) return null;
  if (press.ctrlKey) return press.key.toLowerCase() === 'v' ? null : controlCharacter(press.key);
  return press.altKey ? `${ESC}${press.key}` : null;
}
