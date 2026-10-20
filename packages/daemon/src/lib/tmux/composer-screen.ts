/**
 * Reading WHAT a harness's composer holds, rather than whether some text appears somewhere on screen.
 *
 * The first proof of delivery counted a payload's characters across the WHOLE visible frame. That
 * reads every line a TUI draws — the scrollback above the prompt, the footer, and the composer's own
 * dimmed placeholder — as if it were the composer, and Codex rotates placeholders such as
 * `Ask Codex to do anything` (which contains `hi`) and `Run /review on my current changes` (which
 * contains `review`). Typing `hi` there REMOVES one `hi` and adds one, so the count did not move,
 * the daemon decided nothing had landed, cleared and retyped three times, and gave up with the text
 * left typed in the composer — a message the person saw as "Enter did not work". The same whole-frame
 * read then reported a message as still held for as long as its words were anywhere on screen, so the
 * row sat on "Sending" or "Queued" until a two-hour ceiling.
 *
 * Measured on Codex 0.145.0, 0.156.1 and 0.163.0 (fixtures under `tests/fixtures/composer/`):
 *
 *   * The composer is the LAST prompt-glyph line (`›`), plus the indented lines a multi-line draft
 *     wraps onto, up to the first blank row. A Claude composer is the same shape with `❯` or `>`.
 *   * An empty composer draws its placeholder on that line with the cursor parked at the START of
 *     it. Typed text moves the cursor past itself, so the cursor — not the words — tells the two apart.
 *   * Text submitted while a turn runs leaves the composer for a pending block directly above it:
 *     `• Messages to be submitted after next tool call` / `• Queued follow-up inputs`, each entry a
 *     `↳ <text>` line.
 *
 * Every function here is pure; the cursor comes from tmux beside the capture.
 */

import { PASTE_PLACEHOLDER_PATTERN } from './composer.ts';

/** Where tmux says the cursor is, in the visible frame's own coordinates. */
export interface ComposerCursor {
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}

/** What the composer line(s) show. */
export interface ComposerReading {
  /** The composer's text with the prompt glyph and wrap indentation removed, lines joined by `\n`. */
  readonly text: string;
  /**
   * True when what is drawn is the harness's placeholder, not input: the composer is one line and the
   * cursor sits at its first column. False only when the cursor proves the text is typed. `undefined`
   * when tmux gave no cursor on the composer, which proves neither.
   */
  readonly placeholder: boolean | undefined;
  /** True when the composer holds a collapsed paste (`[Pasted Content …]`) rather than characters. */
  readonly pasted: boolean;
}

const PROMPT_LINE = /^\s*[│|]?\s*([>›❯»])(?:[\s ](.*))?$/u;
/** A numbered selector row (`› 1. Yes`) is a dialog, never a composer. */
const SELECTOR_ROW = /^\s*[│|]?\s*[>›❯»]\s*\d+[.)]/u;
/** Box and rule rows that close a boxed composer. */
const CLOSER = /^\s*(?:[╰└]|[─━]{3,})/u;
const BORDER = /\s*[│|]\s*$/u;
/** The first column a typed character occupies, relative to the glyph's column. */
const GLYPH_GAP = 2;

/** How far above the composer a pending block may start. */
const PENDING_WINDOW_LINES = 25;
const PENDING_ENTRY = /^\s*↳\s?(.*)$/u;
const PENDING_HEADER = /^\s*[•◦]\s*(?:messages to be submitted|queued follow-up)/iu;
const PENDING_HINT = /edit (?:the )?last queued message/iu;

function lineIndexOfComposer(lines: readonly string[]): number | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    if (PROMPT_LINE.test(line) && !SELECTOR_ROW.test(line)) return index;
  }
  return undefined;
}

/**
 * The composer as drawn, or `undefined` when the frame has no prompt line at all.
 *
 * Continuation rows are the indented lines below the prompt line up to the first blank row or box
 * closer — which is also where Codex's footer begins, one blank row below the composer.
 */
export function readComposer(visible: string, cursor: ComposerCursor = {}): ComposerReading | undefined {
  const lines = visible.replaceAll('\r\n', '\n').split('\n');
  const at = lineIndexOfComposer(lines);
  if (at === undefined) return undefined;
  const prompt = lines[at] as string;
  const match = PROMPT_LINE.exec(prompt) as RegExpExecArray;
  const parts = [(match[2] ?? '').replace(BORDER, '').trim()];
  let end = at;
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === '' || CLOSER.test(line)) break;
    parts.push(
      line
        .replace(/^\s*[│|]?/u, '')
        .replace(BORDER, '')
        .trim(),
    );
    end = index;
  }
  const text = parts.join('\n').trim();
  const pasted = new RegExp(PASTE_PLACEHOLDER_PATTERN, 'iu').test(text);
  return { text, placeholder: placeholderOf(prompt, match, at, end, text, cursor), pasted };
}

function placeholderOf(
  prompt: string,
  match: RegExpExecArray,
  at: number,
  end: number,
  text: string,
  cursor: ComposerCursor,
): boolean | undefined {
  if (text === '') return false;
  // One row past the draft is still the composer: a draft ending in a newline — which is what a
  // swallowed Enter leaves — parks the cursor on the blank row it opened.
  if (cursor.x === undefined || cursor.y === undefined || cursor.y < at || cursor.y > end + 1) return undefined;
  const firstColumn = prompt.indexOf(match[1] as string) + GLYPH_GAP;
  return end === at && cursor.y === at && cursor.x <= firstColumn;
}

/** The composer's input, or `''` when it is empty or showing its placeholder. */
export function composerInput(reading: ComposerReading | undefined): string {
  return reading === undefined || reading.placeholder === true ? '' : reading.text;
}

/**
 * The messages a harness shows as waiting in its own queue, directly above the composer.
 *
 * Only a block contiguous with the composer is read — blank rows, headers, `↳` entries, their wrapped
 * continuation rows and the edit hint — so an arrow that scrolled up with the conversation is history,
 * not a queue.
 */
export function readPendingInputs(visible: string): readonly string[] {
  const lines = visible.replaceAll('\r\n', '\n').split('\n');
  const at = lineIndexOfComposer(lines) ?? lines.length;
  const entries: string[][] = [];
  let continuation: string[] = [];
  const floor = Math.max(0, at - PENDING_WINDOW_LINES);
  for (let index = at - 1; index >= floor; index -= 1) {
    const line = lines[index] as string;
    const entry = PENDING_ENTRY.exec(line);
    if (entry !== null) {
      entries.unshift([(entry[1] ?? '').trim(), ...continuation]);
      continuation = [];
      continue;
    }
    if (line.trim() === '' || PENDING_HEADER.test(line) || PENDING_HINT.test(line)) {
      continuation = [];
      continue;
    }
    // A wrapped entry continues on rows indented past its arrow; anything else ends the block.
    if (/^\s{4,}\S/u.test(line)) {
      continuation.unshift(line.trim());
      continue;
    }
    break;
  }
  return entries.map(parts => parts.join(' '));
}

function squeezed(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, '');
}

/** Below this length a clipped entry proves nothing: `ok…` is the start of too many messages. */
const CLIPPED_MATCH_MIN = 12;

/**
 * Whether one drawn entry IS this payload — equal once whitespace is ignored, because a TUI re-wraps
 * text wherever it likes. A long entry the harness clipped with `…` matches the payload it begins.
 */
export function showsPayload(drawn: string, text: string): boolean {
  const shown = squeezed(drawn);
  const wanted = squeezed(text);
  if (wanted === '' || shown === '') return false;
  if (shown === wanted) return true;
  if (!shown.endsWith('…')) return false;
  const prefix = shown.slice(0, -1);
  return prefix.length >= CLIPPED_MATCH_MIN && wanted.startsWith(prefix);
}

/** Where a frame shows a payload being held, if anywhere. */
export type HeldAt = 'composer' | 'queue';

/**
 * Where the pane is holding `text`: typed in the composer, or waiting in the harness's own queue.
 *
 * `paste` says the payload travelled as a bracketed paste, which a harness may draw as a placeholder;
 * then a placeholder in the composer is how it shows, and its characters never are.
 */
export function heldAt(visible: string, cursor: ComposerCursor, text: string, paste: boolean): HeldAt | undefined {
  const composer = readComposer(visible, cursor);
  if (composer !== undefined && composer.placeholder !== true) {
    if (showsPayload(composer.text, text)) return 'composer';
    if (paste && composer.pasted) return 'composer';
  }
  return readPendingInputs(visible).some(entry => showsPayload(entry, text)) ? 'queue' : undefined;
}
