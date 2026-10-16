/**
 * WHAT THE HARNESS SAYS IT IS DOING, read off its own screen.
 *
 * Claude Code paints a spinner line while a turn runs — `✽ Pontificating… (42s · ↓ 3.1k tokens · esc
 * to interrupt)` — and Codex paints its own — `• Working (6m52s • Esc to interrupt)`. That line is the
 * most honest live signal either harness gives: its verb is the harness's own word, and its clock and
 * token counter are the harness's own numbers. The transcript cannot say any of it, because nothing
 * reaches the transcript until a message or a tool call is finished.
 *
 * PURE AND TOTAL. A frame is captured text, so this takes a string and answers `null` for anything it
 * does not recognise. Recognition is deliberately narrow: a line must START with a spinner glyph (or
 * Codex's bullet) and carry the ellipsis or the interrupt hint, so prose an agent printed that merely
 * contains a `…` never reads as activity. Only the bottom of the frame is read, where both harnesses
 * keep their status line — a spinner line that has scrolled up is history, not the present.
 */

export type PaneActivityHarness = 'claude' | 'codex';

export interface PaneActivity {
  readonly harness: PaneActivityHarness;
  /** The harness's own verb, with its ellipsis: `Pontificating…`, `Working…`. */
  readonly verb: string;
  /** The harness's elapsed clock as it printed it: `42s`, `5m 45s`. */
  readonly elapsed?: string;
  /** The harness's token counter as it printed it: `↓ 3.1k tokens`. */
  readonly tokens?: string;
}

/** How far up from the bottom of the frame a status line may sit. */
const STATUS_WINDOW_LINES = 25;

/** Claude's spinner glyphs; the shape cycles, the position does not. */
const CLAUDE_LINE = /^\s*[✻✳✶✽✢∗·✦✧]\s+([^\s(…][^(…\n]{0,80}…)\s*(?:\(([^)\n]*)\)?)?\s*$/u;

/** Codex's `• Working (6m52s • Esc to interrupt)`; the hint can be clipped on a narrow pane. */
const CODEX_LINE = /^\s*[•◦]\s+([A-Za-z][A-Za-z ]{0,40}?)\s*\(\s*(\d[^•)\n]*?)\s*(?:•[^)\n]*)?\)?\s*$/u;

const ELAPSED = /^(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*[sm]$/u;

/** One parenthetical, split on the separators both harnesses use. */
const parts = (parenthetical: string | undefined): readonly string[] =>
  (parenthetical ?? '')
    .split(/[·•∙]/u)
    .map(part => part.trim())
    .filter(part => part !== '');

const claudeActivity = (line: string): PaneActivity | null => {
  const match = CLAUDE_LINE.exec(line);
  if (match === null) return null;
  const details = parts(match[2]);
  const elapsed = details.find(part => ELAPSED.test(part));
  const tokens = details.find(part => /tokens?$/u.test(part));
  return {
    harness: 'claude',
    verb: (match[1] as string).trim(),
    ...(elapsed === undefined ? {} : { elapsed }),
    ...(tokens === undefined ? {} : { tokens }),
  };
};

const codexActivity = (line: string): PaneActivity | null => {
  const match = CODEX_LINE.exec(line);
  if (match === null) return null;
  const elapsed = (match[2] as string).trim();
  if (!/^\d+[hms]/u.test(elapsed)) return null;
  return { harness: 'codex', verb: `${(match[1] as string).trim()}…`, elapsed };
};

/** The live status line in a captured frame, or `null` when the harness shows none. */
export const parsePaneActivity = (frame: string): PaneActivity | null => {
  const lines = frame.replaceAll('\r\n', '\n').split('\n').slice(-STATUS_WINDOW_LINES);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    const found = claudeActivity(line) ?? codexActivity(line);
    if (found !== null) return found;
  }
  return null;
};

/** The one-line reading the activity line prints after the verb: `42s · ↓ 3.1k tokens`. */
export const paneActivityDetail = (activity: PaneActivity): string =>
  [activity.elapsed, activity.tokens].filter((part): part is string => part !== undefined).join(' · ');
