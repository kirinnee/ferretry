import type { PaneMetadata } from './contracts.ts';

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

export function promptIsReady(pane: string, cursorY?: number, cursorX?: number): boolean {
  const lower = pane.toLowerCase();
  if (STARTUP_BLOCKERS.some(marker => lower.includes(marker)) || paneShowsActiveWork(pane)) return false;
  if (lower.includes(INTERRUPTED_BANNER)) return true;
  const lines = pane.split('\n');
  if (cursorY !== undefined && cursorY >= 0 && cursorY < lines.length) {
    const line = lines[cursorY]!;
    return (cursorX === undefined || cursorX <= 2) && PROMPT.test(line) && !/^\s*[│|]?\s*[>›❯»]\s*\d+[.)]/u.test(line);
  }
  return lines.slice(-30).some(line => PROMPT.test(line));
}
