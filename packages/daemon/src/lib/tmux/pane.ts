import type { PaneMetadata } from './contracts.ts';
import { parseHarnessDialog } from './harness-dialog.ts';
import { parsePermissionPrompt } from './permission-prompt.ts';

/**
 * Screens a harness shows BEFORE it will accept any input.
 *
 * Every entry is a modal the pane sits on until somebody answers it, and a pane sitting on one is
 * not ready no matter where its cursor is. The list arrived here narrowed to three markers, and the
 * three that survived were the three that happen not to render a prompt-shaped line — so a pane
 * parked on a theme picker or a sign-in screen read as READY and the daemon typed a turn brief into
 * it.
 *
 * `startup.ts` answers the subset whose affirmative path is known; the rest still belong here,
 * because "cannot be answered automatically" and "is not ready" are different facts.
 */
const STARTUP_BLOCKERS = [
  'do you trust the contents of this directory',
  'trust this folder? codex can',
  'opening will not change saved trust',
  'do you trust the files',
  'quick safety check: is this a project you created or one you trust',
  'yes, i trust this folder',
  'press enter to continue',
  'choose the text style',
  'select theme',
  'yes, i accept',
  'no, exit',
  'invalid api key',
  'detected a custom api key',
  'do you want to use this api key',
  'sign in',
  'log in',
  // One-shot dialogs Claude can raise once it is up. Each draws a `❯ <choice>` row that reads as a
  // prompt line, so without these the daemon typed a message straight into the dialog.
  'make auto mode your default permission mode?',
  'switch your default effort to',
  'try the new fullscreen renderer?',
];

/**
 * The harness dialogs a session can sit on with NOBODY told why, each with the words a person is
 * shown for it. Every marker is the dialog's own title or question, never a word that ordinary agent
 * output could contain — this is read on every turn-watch tick, and a false match would turn a
 * working agent into "needs input".
 */
const BLOCKING_PROMPTS: readonly { readonly marker: string; readonly says: string }[] = [
  { marker: 'make auto mode your default permission mode?', says: 'Make auto mode your default permission mode?' },
  { marker: 'switch your default effort to', says: 'Switch your default effort level?' },
  { marker: 'try the new fullscreen renderer?', says: 'Try the new fullscreen renderer?' },
  { marker: 'quick safety check: is this a project you created or one you trust', says: 'Do you trust this folder?' },
  { marker: 'do you trust the files', says: 'Do you trust this folder?' },
  { marker: 'do you trust the contents of this directory', says: 'Do you trust this folder?' },
  { marker: 'trust this folder? codex can', says: 'Do you trust this folder?' },
  { marker: 'opening will not change saved trust', says: 'Open this untrusted folder restricted?' },
  { marker: 'choose the text style', says: 'Choose a text style (first-run setup)' },
  { marker: 'do you want to use this api key', says: 'Use the custom API key it detected?' },
  { marker: 'resume full session as-is', says: 'Resume from a summary, or the full session?' },
];

/**
 * Interrupt hints — the only literal strings both harnesses print while a turn runs.
 *
 * Deliberately NOT here: `background terminal running`. Codex prints that footer permanently while
 * IDLE whenever a background terminal exists, so treating it as busy makes such a session look like
 * it is working forever.
 */
const INTERRUPT_HINTS = ['esc to interrupt', 'ctrl+c to interrupt'];

/** Codex's `Working (6m52s • Esc to interrupt)`. The hint is clipped on a narrow pane, so the
 *  elapsed form has to stand on its own. */
const CODEX_ELAPSED = /\bworking\s*\(\s*\d+[ms]/;

/** Claude-family elapsed counters — `(12s · ⚒ 3.4k tokens`, `(5m 45s · ↓ 17.2k tokens`. Minutes and
 *  seconds may be space-separated, and the trailing separator dot is what stops a parenthesised
 *  number elsewhere on screen from matching. */
const CLAUDE_ELAPSED = /\(\s*(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*s\s*[·•∙]/;

/** The same counter line seen by its token half, for frames whose elapsed clock has scrolled off. */
const TOKEN_COUNTER = /[\d.,]+k?\s*tokens\s*[·•∙]/;

/** Spinner glyph plus an animated verb ellipsis — `✻ Lollygagging…`, `✢ Fixing stall detection…`.
 *  The verb phrase can run to several words, so the bound is on length, not on word count. */
const SPINNER_PHRASE = /[✻✳✶✽✢∗][^\n…]{1,120}…/u;

/** `⏺` also prefixes tool-RESULT lines whose truncation ellipsis must not read as busy, so it keeps
 *  the strict single-word form only the spinner produces. */
const SPINNER_MARK = /⏺\s*\S+…/u;

/** Codex's post-interrupt banner. The turn is stopped and the composer is editable, so this screen
 *  is READY — and another interrupt keystroke sent into it would quit the TUI entirely. */
const INTERRUPTED_BANNER = 'tell the model what to do differently';

const PROMPT = /^\s*[│|]?\s*[>›❯»](?:[\s ].*)?$/u;

export function parsePaneMetadata(value: string): PaneMetadata {
  const [dead, exitCode, cursorX, cursorY, height, width] = value.trimEnd().split('|');
  const number = (field: string | undefined): number | undefined => {
    const parsed = Number(field);
    return field === undefined || field === '' || !Number.isFinite(parsed) ? undefined : parsed;
  };
  return {
    dead: dead === '1',
    exitCode: number(exitCode),
    cursorX: number(cursorX),
    cursorY: number(cursorY),
    height: number(height),
    width: number(width),
  };
}

/**
 * Active-turn evidence in the VISIBLE pane: interrupt hints, elapsed clocks, token counters and
 * spinner phrases.
 *
 * Ground truth for "the harness is working". A pane showing this must never be treated as idle,
 * finished, or failed — every caller that is about to send a key asks this first.
 */
export function paneShowsActiveWork(pane: string): boolean {
  const lower = pane.toLowerCase();
  if (INTERRUPT_HINTS.some(marker => lower.includes(marker))) return true;
  if (CODEX_ELAPSED.test(lower) || CLAUDE_ELAPSED.test(lower) || TOKEN_COUNTER.test(lower)) return true;
  return SPINNER_PHRASE.test(pane) || SPINNER_MARK.test(pane);
}

/**
 * The questions both harnesses ask before a tool runs — Claude's `Do you want to proceed?` /
 * `Do you want to make this edit to …`, Codex's `Would you like to run the following command?` /
 * `Allow command?`. Only ever read together with a numbered choice list, so prose that merely
 * contains one of these words never reads as a prompt.
 */
const PERMISSION_QUESTIONS = ['do you want to', 'would you like to', 'allow command', 'approve this'];

/** One numbered choice of a selector, cursor or not: `❯ 1. Yes`, `  2. No`, `› 1. Yes, proceed`. */
const NUMBERED_CHOICE = /^\s*[│|]?\s*(?:[>›❯»▌]\s*)?[1-9][.)]\s+\S/u;

/** How far up from the bottom of the frame a live permission prompt may sit. */
const PERMISSION_WINDOW_LINES = 25;

/**
 * A permission (or other choice) prompt the harness is blocked on, in the VISIBLE pane.
 *
 * The agent is not working and it is not the person's ordinary turn either: nothing moves until
 * somebody picks a choice. Recognition needs both halves — a permission question and at least two
 * numbered choices — within the bottom of the frame, because a choice list that has scrolled up is
 * history.
 */
export function paneShowsPermissionPrompt(pane: string): boolean {
  // Trailing blank rows first: a tall pane draws its prompt near the top and pads the rest, and those
  // rows would otherwise push the live prompt out of the window.
  const lines = pane.replaceAll('\r\n', '\n').trimEnd().split('\n').slice(-PERMISSION_WINDOW_LINES);
  const choices = lines.filter(line => NUMBERED_CHOICE.test(line)).length;
  if (choices < 2) return false;
  const lower = lines.join('\n').toLowerCase();
  return PERMISSION_QUESTIONS.some(question => lower.includes(question));
}

/**
 * The harness dialog the VISIBLE pane is parked on, as the words a person is shown for it, or
 * `undefined` when it shows none this module knows.
 *
 * Read from the bottom of the frame only, like {@link paneShowsPermissionPrompt}: a dialog that has
 * scrolled up was answered.
 */
export function paneBlockingPrompt(pane: string): string | undefined {
  const lower = pane
    .replaceAll('\r\n', '\n')
    .trimEnd()
    .split('\n')
    .slice(-PERMISSION_WINDOW_LINES)
    .join('\n')
    .toLowerCase();
  return BLOCKING_PROMPTS.find(({ marker }) => lower.includes(marker))?.says;
}

export function promptIsReady(pane: string, cursorY?: number, cursorX?: number): boolean {
  const lower = pane.toLowerCase();
  if (STARTUP_BLOCKERS.some(marker => lower.includes(marker)) || paneShowsActiveWork(pane)) return false;
  // A permission prompt's cursor row reads as a prompt line, and a message typed into it picks a row.
  if (parsePermissionPrompt(pane) !== undefined) return false;
  // So does a harness dialog's: Codex's `› 1. Review hooks` is shaped like a composer line.
  if (parseHarnessDialog(pane) !== undefined) return false;
  if (lower.includes(INTERRUPTED_BANNER)) return true;
  const lines = pane.split('\n');
  if (cursorY !== undefined && cursorY >= 0 && cursorY < lines.length) {
    const line = lines[cursorY]!;
    return (cursorX === undefined || cursorX <= 2) && PROMPT.test(line) && !/^\s*[│|]?\s*[>›❯»]\s*\d+[.)]/u.test(line);
  }
  return lines.slice(-30).some(line => PROMPT.test(line));
}

/** A pane's tmux id and the pid of the process it runs. */
export interface PaneIdentity {
  readonly paneId: string;
  readonly pid: number;
}

/**
 * Parse `#{pane_id} #{pane_pid}`, whatever the locale tmux printed it under.
 *
 * Neither field can hold a space, a tab or an underscore, so any one of the three separates them.
 * That matters because the separator is the one character tmux may rewrite: a tmux client with no
 * UTF-8 locale prints a tab as `_`, and a parser that split on the tab alone read `%0_2475105` as a
 * pane with no pid — which failed every session a daemon without a locale ever launched.
 */
export function parsePaneIdentity(output: string): PaneIdentity | undefined {
  const match = /^(%(?:0|[1-9][0-9]*))[\t _]([1-9][0-9]*)$/u.exec(output.trim());
  if (match === null) return undefined;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid) && pid > 1 ? { paneId: match[1] as string, pid } : undefined;
}
