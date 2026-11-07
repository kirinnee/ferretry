/**
 * WHAT EACH KEY-BAR KEY SENDS, as the bytes a terminal expects.
 *
 * A phone keyboard has no Escape, Tab, Control or arrow keys, and a terminal is
 * unusable without them. The key bar sends these sequences straight to the
 * terminal stream, the same as a desktop keyboard would through xterm.
 *
 * Control is STICKY: tapping it arms it, and the very next key — from the bar or
 * typed on the phone keyboard — goes as its control form, then it disarms.
 */

export type TerminalBarKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right';

const ESC = '\x1b';

const ARROW_FINAL: Readonly<Record<'up' | 'down' | 'right' | 'left', string>> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
};

/**
 * The bytes for one key-bar key. Ctrl changes the arrows to the xterm
 * "modifier 5" form (`ESC [ 1 ; 5 A`), which shells read as word-jump; esc and
 * tab have no control form a terminal distinguishes, so ctrl leaves them alone.
 */
export const terminalKeySequence = (key: TerminalBarKey, ctrl = false): string => {
  if (key === 'esc') return ESC;
  if (key === 'tab') return '\t';
  return ctrl ? `${ESC}[1;5${ARROW_FINAL[key]}` : `${ESC}[${ARROW_FINAL[key]}`;
};

/**
 * The control character for one typed character, or `null` when it has none.
 * Letters and `@ [ \ ] ^ _` map by masking to the low five bits (Ctrl+C is
 * 0x03); Ctrl+Space is NUL and Ctrl+? is DEL, as on every terminal.
 */
export const controlCharacter = (character: string): string | null => {
  if (character.length !== 1) return null;
  if (character === ' ') return '\x00';
  if (character === '?') return '\x7f';
  const code = character.toUpperCase().charCodeAt(0);
  // '@' (0x40) through '_' (0x5f): the letters plus @ [ \ ] ^ _.
  if (code < 0x40 || code > 0x5f) return null;
  return String.fromCharCode(code & 0x1f);
};

/**
 * Typed input with sticky ctrl applied. Only a single character is a key press;
 * a longer chunk is a paste or an autocorrect replacement and goes through
 * untouched, and a character with no control form is sent as typed. Either way
 * the armed ctrl is spent — it was meant for this key.
 */
export const applyStickyCtrl = (data: string, armed: boolean): string => {
  if (!armed) return data;
  return controlCharacter(data) ?? data;
};
