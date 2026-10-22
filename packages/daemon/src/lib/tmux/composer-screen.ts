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
 * Measured on Claude Code 2.1.281 (the live captures under `tests/fixtures/composer/claude-*`):
 *
 *   * Text submitted mid-turn is drawn ABOVE the spinner, each message a `❯ <text>` line with its
 *     wrapped rows indented two columns, and the block closed by `  ctrl+x ctrl+s to send now`.
 *   * The composer then shows `Press up to edit queued messages`. That is a placeholder, whatever
 *     the cursor says: read as input, it made every later send refuse over "a draft" nobody typed.
 *   * Claude no longer writes a transcript `queue-operation` record for text typed into its queue,
 *     so this block is the ONLY proof a held message has. Missing it called the message lost, and
 *     the daemon typed it again — four copies in one queue, and the sender told it never arrived.
 *   * A named session (`claude -n`) draws its name inside the rule ABOVE the composer
 *     (`──── [Aime] MXO OCI Migration ─`). Nothing here reads that rule, so the title changes nothing.
 *   * An empty idle composer suggests something to type, `Try "edit <filepath> to..."`, with the
 *     cursor at its first column. That wording is a placeholder even when tmux reports no cursor.
 *   * `C-u` erases back to the start of the WRAPPED ROW the cursor is on, not the whole message:
 *     a pointer wrapped over three rows loses only its last one. A "clear and retype" therefore
 *     leaves a clipped copy behind and appends a whole new one — the pile of six pointers on one
 *     person's draft, one of them cut at `This is your `.
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

/** Claude's empty composer while messages wait in its queue. Never input, whatever the cursor says. */
const CLAUDE_QUEUED_PLACEHOLDER = /^press\s+up\s+to\s+edit\s+queued\s+messages?$/iu;
/** Claude's empty idle composer, suggesting a prompt. A placeholder by its wording when no cursor says. */
const CLAUDE_SUGGESTION_PLACEHOLDER = /^try\s+"[^"\n]*"$/iu;
/** The line that closes Claude's queued block, directly under its last message. */
const CLAUDE_QUEUE_HINT = /^\s*ctrl\+x\s+ctrl\+s\s+to\s+send\s+now\s*$/iu;
/** How far above the composer the hint may sit: the spinner, its tip and a todo list lie between. */
const CLAUDE_HINT_WINDOW_LINES = 40;
/** One queued message's first row, flush left. History drawn by the assistant starts with `⏺`. */
const CLAUDE_QUEUE_ENTRY = /^[❯>](?:[\s ](.*))?$/u;
/** A queued message's wrapped rows, and the blank rows between its paragraphs and between messages. */
const CLAUDE_QUEUE_CONTINUATION = /^\s{2,}\S/u;

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
  if (end === at && CLAUDE_QUEUED_PLACEHOLDER.test(text)) return true;
  // One row past the draft is still the composer: a draft ending in a newline — which is what a
  // swallowed Enter leaves — parks the cursor on the blank row it opened.
  if (cursor.x === undefined || cursor.y === undefined || cursor.y < at || cursor.y > end + 1)
    // With no cursor to ask, only a harness's own placeholder wording proves nobody typed it.
    return end === at && CLAUDE_SUGGESTION_PLACEHOLDER.test(text) ? true : undefined;
  const firstColumn = prompt.indexOf(match[1] as string) + GLYPH_GAP;
  return end === at && cursor.y === at && cursor.x <= firstColumn;
}

/** The composer's input, or `''` when it is empty or showing its placeholder. */
export function composerInput(reading: ComposerReading | undefined): string {
  return reading === undefined || reading.placeholder === true ? '' : reading.text;
}

/**
 * What a harness shows waiting in its own queue, and whether that is ALL of it.
 *
 * `complete` is false when the frame cannot show the whole queue — Claude's block runs off the top
 * of the pane, or its composer says messages are queued and no block could be read. A payload FOUND
 * in `entries` is held either way; one NOT found is absent only when `complete` is true.
 */
export interface HarnessQueue {
  readonly entries: readonly string[];
  readonly complete: boolean;
}

/** The messages a harness shows as waiting in its own queue: Codex's pending block, then Claude's. */
export function readPendingInputs(visible: string): readonly string[] {
  return readHarnessQueue(visible).entries;
}

/** Both harnesses' queues as one reading. Neither shape can be mistaken for the other's. */
export function readHarnessQueue(visible: string): HarnessQueue {
  const lines = visible.replaceAll('\r\n', '\n').split('\n');
  const at = lineIndexOfComposer(lines);
  const claude = readClaudeQueue(lines, at);
  return { entries: [...readCodexPending(lines, at ?? lines.length), ...claude.entries], complete: claude.complete };
}

/**
 * Codex's pending block, directly above the composer.
 *
 * Only a block contiguous with the composer is read — blank rows, headers, `↳` entries, their wrapped
 * continuation rows and the edit hint — so an arrow that scrolled up with the conversation is history,
 * not a queue.
 */
function readCodexPending(lines: readonly string[], at: number): readonly string[] {
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

/**
 * Claude's queued block: the `❯` messages directly above its `ctrl+x ctrl+s to send now` hint.
 *
 * Anchored to the hint, never to a `❯` line on its own, because the conversation above draws the
 * person's past prompts with the same glyph. Read upward from the hint through each message's
 * indented rows until a flush-left line that is not a queued message — the assistant's `⏺` output.
 * Reaching the top of the frame first means more of the queue may sit above it, so the reading is
 * incomplete; so is a composer that says messages are queued while no hint can be found.
 */
function readClaudeQueue(lines: readonly string[], at: number | undefined): HarnessQueue {
  const hint = claudeQueueHint(lines, at);
  if (hint === undefined) {
    const composer = at === undefined ? '' : (PROMPT_LINE.exec(lines[at] as string)?.[2] ?? '').trim();
    return { entries: [], complete: !CLAUDE_QUEUED_PLACEHOLDER.test(composer) };
  }
  const entries: string[] = [];
  let body: string[] = [];
  let index = hint - 1;
  for (; index >= 0; index -= 1) {
    const line = lines[index] as string;
    const entry = CLAUDE_QUEUE_ENTRY.exec(line);
    if (entry !== null) {
      entries.unshift([(entry[1] ?? '').trim(), ...body].join(' ').trim());
      body = [];
      continue;
    }
    if (line.trim() === '' || CLAUDE_QUEUE_CONTINUATION.test(line)) {
      body.unshift(line.trim());
      continue;
    }
    break;
  }
  return { entries, complete: index >= 0 };
}

function claudeQueueHint(lines: readonly string[], at: number | undefined): number | undefined {
  const from = (at ?? lines.length) - 1;
  const floor = Math.max(0, from - CLAUDE_HINT_WINDOW_LINES);
  for (let index = from; index >= floor; index -= 1) if (CLAUDE_QUEUE_HINT.test(lines[index] as string)) return index;
  return undefined;
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

/**
 * Whether the composer's text holds this payload ANYWHERE — alone, or typed beside text that is not
 * this send's: a person's draft it was appended to, or another copy of itself.
 *
 * Exact equality answered "not in the composer" for a pointer sitting after a person's draft, and
 * "not in the composer" is what licenses typing it again. A payload too short to be told from a word
 * of somebody's draft is held only when it is all the composer shows.
 */
export function composerContains(composer: string, text: string): boolean {
  if (showsPayload(composer, text)) return true;
  const wanted = squeezed(text);
  return wanted.length >= CLIPPED_MATCH_MIN && squeezed(composer).includes(wanted);
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
  const hold = paneHoldOf(visible, cursor, text, paste);
  return hold === 'composer' || hold === 'queue' ? hold : undefined;
}

/**
 * What a frame proves about `text`: held in the composer or the queue, `absent` from both, or
 * `unknown` — not found, but the harness's queue runs past what the frame shows, so it may be there.
 * Only `absent` may ever lead to typing the payload again.
 */
export type PaneHold = HeldAt | 'absent' | 'unknown';

export function paneHoldOf(visible: string, cursor: ComposerCursor, text: string, paste: boolean): PaneHold {
  const composer = readComposer(visible, cursor);
  if (composer !== undefined && composer.placeholder !== true) {
    if (composerContains(composer.text, text)) return 'composer';
    if (paste && composer.pasted) return 'composer';
  }
  const queue = readHarnessQueue(visible);
  if (queue.entries.some(entry => showsPayload(entry, text))) return 'queue';
  return queue.complete ? 'absent' : 'unknown';
}
