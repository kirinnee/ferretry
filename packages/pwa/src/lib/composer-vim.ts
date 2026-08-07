/**
 * Modal editing over a controlled native textarea.
 *
 * The engine is a pure function of text, caret and key. It holds no state of its own, never touches
 * the DOM, never moves focus and never decides `preventDefault`. It answers one question — *given
 * this mode, this key and this text, what should the text, the caret and the mode become?* — and
 * says whether it claimed the key at all.
 *
 * A native textarea is kept deliberately: the caret, the selection, the on-screen text metrics and
 * the soft keyboard stay the platform's, so an editing mode cannot take them away from every reader
 * who does not want one.
 *
 * ## The seam: what the host still owns
 *
 * `handled: false` is the whole compatibility story — the composer's existing key arbitration
 * continues untouched, which is what keeps the Enter policy, dictation and the reference
 * autocomplete working by default rather than by patching. Four decisions are the host's, and this
 * module cannot see any of them:
 *
 * - **Composition suppression.** A key delivered while an input method is composing must never
 *   reach {@link vimReduce}. The host drops it on `isComposing` first, exactly as it already does
 *   for Enter. An engine that saw those keys would execute a reader's Japanese, Chinese or Korean
 *   text as commands.
 * - **Priority.** An open autocomplete list outranks this engine: `Escape` closes the list before
 *   it leaves insert mode, and a candidate is accepted before a key reaches here.
 * - **Default arbitration.** `handled: true` is the *evidence* for `preventDefault`, not a request
 *   for it; the engine never claims a key it did not act on, so the host never suppresses a
 *   browser or system shortcut on its behalf.
 * - **Applying the outcome.** Writing `value` back to the draft and the caret back to the element
 *   is the host's, through whatever pending-selection path it already uses. Dictation, which
 *   inserts spoken words at the caret, must therefore put the engine back in insert mode before it
 *   applies a transcript.
 *
 * ## What this build understands, stated so nothing is silently wrong
 *
 * Modes `insert` and `normal`. `Escape` leaves insert; `i a I A o O` enter it; `h j k l 0 $ w b e`
 * move; `x` deletes the character under the caret; `dd` deletes the line. Everything else a reader
 * can type in normal mode is claimed and inert, so a stray letter is never typed into the draft —
 * but keys with no printable character (Enter, Tab, Backspace, Delete, the arrows) are left to the
 * host, and so is every key held with Ctrl, Meta or Alt.
 */

/**
 * Insert types characters; normal reads them as commands.
 *
 * Reached from outside as `VimState['mode']` rather than exported, so there is one spelling of the
 * mode a host can read and no second one to drift from it.
 */
type VimMode = 'insert' | 'normal';

/** The only operator here. It exists so `dd` can be two keys rather than one. */
type VimOperator = 'd';

export interface VimState {
  readonly mode: VimMode;
  /** An operator waiting for its second key, or `null` when nothing is pending. */
  readonly operator: VimOperator | null;
  /**
   * The column `j` and `k` are trying to hold while travelling across shorter lines, in UTF-16
   * offsets from the line start. `null` outside vertical movement, which is what makes every other
   * command reset it.
   */
  readonly column: number | null;
}

/**
 * The text and caret of the controlled element, in its own units.
 *
 * A range collapses to `selectionStart`: there is no visual mode here, so every outcome this
 * engine returns is a collapsed caret.
 */
export interface VimDocument {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * A key as the platform reported it.
 *
 * Shift is deliberately absent. The browser already reports the shifted character in `key` — `$`
 * rather than `4`, `A` rather than `a` — so a second reading of "was Shift down" would be one fact
 * with two definitions, and the two would disagree on the first keyboard layout that moved `$`.
 */
export interface VimKey {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

interface VimClaimed extends VimDocument {
  readonly handled: true;
  readonly state: VimState;
}

/**
 * `handled: false` carries no text or caret on purpose: the host must fall through to its own
 * arbitration rather than write back an unchanged document it never asked for.
 */
export type VimOutcome = VimClaimed | { readonly handled: false };

/** A composer opens as an ordinary text field; modal editing starts only once a reader asks. */
export const initialVimState: VimState = { mode: 'insert', operator: null, column: null };

const ignored: VimOutcome = { handled: false };

const BLANK = /\s/u;
const WORD = /[\p{L}\p{N}_]/u;

type CharClass = 'blank' | 'word' | 'symbol';

/** Off either end of the text reads as blank, which is what stops every scan below at the edge. */
const classAt = (value: string, index: number): CharClass => {
  const code = value.codePointAt(index);
  if (code === undefined) return 'blank';
  const character = String.fromCodePoint(code);
  if (BLANK.test(character)) return 'blank';
  return WORD.test(character) ? 'word' : 'symbol';
};

/** The next code-point boundary, so a caret never lands between the halves of a surrogate pair. */
const forwardFrom = (value: string, index: number): number => {
  const code = value.codePointAt(index);
  return index + (code !== undefined && code > 0xffff ? 2 : 1);
};

/** The previous code-point boundary. */
const backFrom = (value: string, index: number): number => {
  if (index <= 1) return Math.max(index - 1, 0);
  const code = value.codePointAt(index - 2);
  return code !== undefined && code > 0xffff ? index - 2 : index - 1;
};

const lineStartAt = (value: string, index: number): number =>
  index === 0 ? 0 : value.lastIndexOf('\n', index - 1) + 1;

/** Where the line's terminator sits, or the end of the text on the final line. */
const lineEndAt = (value: string, index: number): number => {
  const at = value.indexOf('\n', index);
  return at === -1 ? value.length : at;
};

/**
 * Where the line's *text* ends. A carriage return immediately before the newline belongs to the
 * terminator rather than to the line, so `$` lands on the last visible character and `x` can never
 * split a CRLF pair.
 */
const lineTextEndAt = (value: string, index: number): number => {
  const end = lineEndAt(value, index);
  return end > 0 && value.charAt(end - 1) === '\r' ? end - 1 : end;
};

/**
 * Normal mode's caret sits *on* a character, so it may not rest past the last one. An empty line
 * has nowhere to sit and keeps the caret at its start.
 */
const restOnCharacter = (value: string, index: number): number => {
  const textEnd = lineTextEndAt(value, index);
  if (index < textEnd) return index;
  return Math.max(lineStartAt(value, index), backFrom(value, textEnd));
};

const firstNonBlank = (value: string, index: number): number => {
  const textEnd = lineTextEndAt(value, index);
  let at = lineStartAt(value, index);
  while (at < textEnd && classAt(value, at) === 'blank') at = forwardFrom(value, at);
  return at;
};

/** True exactly where a line has no characters at all, which is where `w` and `b` stop. */
const onEmptyLine = (value: string, index: number): boolean =>
  lineStartAt(value, index) === index && lineTextEndAt(value, index) === index;

const wordForward = (value: string, index: number): number => {
  let at = index;
  const from = classAt(value, at);
  while (at < value.length && classAt(value, at) === from && from !== 'blank') at = forwardFrom(value, at);
  while (at < value.length && classAt(value, at) === 'blank' && !onEmptyLine(value, at)) at = forwardFrom(value, at);
  return restOnCharacter(value, at);
};

const wordBackward = (value: string, index: number): number => {
  let at = backFrom(value, index);
  while (at > 0 && classAt(value, at) === 'blank' && !onEmptyLine(value, at)) at = backFrom(value, at);
  if (classAt(value, at) === 'blank') return at;
  const from = classAt(value, at);
  while (at > 0 && classAt(value, backFrom(value, at)) === from) at = backFrom(value, at);
  return at;
};

const wordEnd = (value: string, index: number): number => {
  let at = forwardFrom(value, index);
  while (at < value.length && classAt(value, at) === 'blank') at = forwardFrom(value, at);
  if (at >= value.length) return restOnCharacter(value, value.length);
  const from = classAt(value, at);
  while (forwardFrom(value, at) < value.length && classAt(value, forwardFrom(value, at)) === from)
    at = forwardFrom(value, at);
  return at;
};

/** The line above or below at the held column, or the same caret when there is no such line. */
const verticalCaret = (value: string, index: number, column: number, delta: -1 | 1): number => {
  const start = lineStartAt(value, index);
  if (delta === 1) {
    const end = lineEndAt(value, index);
    if (end === value.length) return index;
    return restOnCharacter(value, Math.min(end + 1 + column, lineTextEndAt(value, end + 1)));
  }
  if (start === 0) return index;
  const above = lineStartAt(value, start - 1);
  return restOnCharacter(value, Math.min(above + column, lineTextEndAt(value, above)));
};

/** Deletes the line under the caret with its terminator, and lands on the new line's first word. */
const deleteLine = (value: string, index: number): { readonly value: string; readonly caret: number } => {
  const start = lineStartAt(value, index);
  const end = lineEndAt(value, index);
  if (end < value.length) {
    const next = value.slice(0, start) + value.slice(end + 1);
    return { value: next, caret: restOnCharacter(next, firstNonBlank(next, Math.min(start, next.length))) };
  }
  const from = start === 0 ? 0 : value.charAt(start - 2) === '\r' ? start - 2 : start - 1;
  const next = value.slice(0, from);
  return { value: next, caret: restOnCharacter(next, firstNonBlank(next, next.length)) };
};

const claim =
  (mode: VimMode, operator: VimOperator | null, column: number | null) =>
  (value: string, caret: number): VimClaimed => ({
    handled: true,
    state: { mode, operator, column },
    value,
    selectionStart: caret,
    selectionEnd: caret,
  });

const enterInsert = claim('insert', null, null);
const stayNormal = claim('normal', null, null);
const awaitMotion = claim('normal', 'd', null);

/** A key with no printable character — Enter, Tab, the arrows, Escape — belongs to the host. */
const isPrintable = (key: string): boolean => [...key].length === 1;

const deleteUnderCaret = (value: string, caret: number): VimClaimed => {
  const textEnd = lineTextEndAt(value, caret);
  if (caret >= textEnd) return stayNormal(value, caret);
  const next = value.slice(0, caret) + value.slice(forwardFrom(value, caret));
  return stayNormal(next, restOnCharacter(next, caret));
};

const normalKey = (state: VimState, key: string, value: string, caret: number): VimOutcome => {
  if (state.operator !== null) {
    if (key !== 'd') return stayNormal(value, caret);
    const cut = deleteLine(value, caret);
    return stayNormal(cut.value, cut.caret);
  }
  if (!isPrintable(key)) return ignored;
  const column = state.column ?? caret - lineStartAt(value, caret);
  switch (key) {
    case 'i':
      return enterInsert(value, caret);
    case 'a':
      return enterInsert(value, Math.min(forwardFrom(value, caret), lineTextEndAt(value, caret)));
    case 'I':
      return enterInsert(value, firstNonBlank(value, caret));
    case 'A':
      return enterInsert(value, lineTextEndAt(value, caret));
    case 'o': {
      const at = lineEndAt(value, caret);
      return enterInsert(`${value.slice(0, at)}\n${value.slice(at)}`, at + 1);
    }
    case 'O': {
      const at = lineStartAt(value, caret);
      return enterInsert(`${value.slice(0, at)}\n${value.slice(at)}`, at);
    }
    case 'h':
      return stayNormal(value, Math.max(lineStartAt(value, caret), backFrom(value, caret)));
    case 'l':
      return stayNormal(value, restOnCharacter(value, forwardFrom(value, caret)));
    case '0':
      return stayNormal(value, lineStartAt(value, caret));
    case '$':
      return stayNormal(value, restOnCharacter(value, lineTextEndAt(value, caret)));
    case 'w':
      return stayNormal(value, wordForward(value, caret));
    case 'b':
      return stayNormal(value, wordBackward(value, caret));
    case 'e':
      return stayNormal(value, wordEnd(value, caret));
    case 'j':
      return claim('normal', null, column)(value, verticalCaret(value, caret, column, 1));
    case 'k':
      return claim('normal', null, column)(value, verticalCaret(value, caret, column, -1));
    case 'x':
      return deleteUnderCaret(value, caret);
    case 'd':
      return awaitMotion(value, caret);
    default:
      return stayNormal(value, caret);
  }
};

/**
 * The one entry point: a mode, a key and a document in; a claimed outcome or `handled: false` out.
 *
 * Total by construction — every key, every mode and every position in any text returns an answer,
 * including the empty document, the end of the final line and a caret the host placed past the
 * text.
 */
export const vimReduce = (state: VimState, key: VimKey, current: VimDocument): VimOutcome => {
  if (key.ctrlKey || key.metaKey || key.altKey) return ignored;
  const value = current.value;
  const caret = Math.min(Math.max(current.selectionStart, 0), value.length);
  if (state.mode === 'insert') {
    if (key.key !== 'Escape') return ignored;
    return stayNormal(value, restOnCharacter(value, Math.max(lineStartAt(value, caret), backFrom(value, caret))));
  }
  return normalKey(state, key.key, value, restOnCharacter(value, caret));
};
