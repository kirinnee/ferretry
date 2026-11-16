import { COMPACTING_LINE } from '@ferretry/std/compaction-line';

/**
 * Pane-text evidence of active work, copied from today's `tmux/pane.ts` (owned by the pane reader; the liveness reflex
 * is its one reader here). The marker lists are the harnesses' own words and move with them.
 */

const INTERRUPT_HINTS = ['esc to interrupt', 'ctrl+c to interrupt'];
const CODEX_ELAPSED = /\bworking\s*\(\s*\d+[ms]/;
const CLAUDE_ELAPSED = /\(\s*(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*s\s*[·•∙]/;
const TOKEN_COUNTER = /[\d.,]+k?\s*tokens\s*[·•∙]/;
const SPINNER_PHRASE = /^[^\S\n]*[✻✳✶✽✢∗][^\n…]{1,120}…/mu;
const SPINNER_MARK = /^[^\S\n]*⏺\s*\S+…/mu;

/** How many rows, counted from the last non-blank one, the compaction status line may sit above (as the terminals plugin reads it). */
const COMPACTING_WINDOW_LINES = 12;

function paneShowsCompacting(pane: string): boolean {
  const rows = pane.replaceAll('\r\n', '\n').trimEnd().split('\n').slice(-COMPACTING_WINDOW_LINES);
  return COMPACTING_LINE.test(rows.join('\n'));
}

export function paneShowsActiveWork(pane: string): boolean {
  return paneActiveWork(pane) !== undefined;
}

/**
 * HOW the visible pane shows active work, or `undefined` when it does not.
 *
 * `status` is the harness's live status line — an interrupt hint, an elapsed clock or a token counter,
 * which both harnesses print for as long as a turn runs. `spinner` is a spinner-shaped line and nothing
 * else: a running turn shows it too, but so can something on an idle screen that merely looks like one,
 * so it is the one reading a transcript that says the turn ENDED may overrule.
 */
function paneActiveWork(pane: string): 'status' | 'spinner' | undefined {
  const lower = pane.toLowerCase();
  if (INTERRUPT_HINTS.some(marker => lower.includes(marker))) return 'status';
  if (CODEX_ELAPSED.test(lower) || CLAUDE_ELAPSED.test(lower) || TOKEN_COUNTER.test(lower)) return 'status';
  // A compaction is the harness working on any spinner tick, counter or not (&B188): the one grammar the terminals
  // plugin reads it with, in the same window above the composer.
  if (paneShowsCompacting(pane)) return 'status';
  return SPINNER_PHRASE.test(pane) || SPINNER_MARK.test(pane) ? 'spinner' : undefined;
}
