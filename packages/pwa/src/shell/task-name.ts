/**
 * A session's task, parsed out of `config.name`. Ported from the parsing half of
 * kteam `ui/src/components/TaskName.tsx` — the rendered chip belongs to whoever
 * ports the session row; every surface that merely needs the words takes this.
 *
 * `--name` is documented to the CLI's callers as "a succinct summary of what
 * this session is supposed to do", so it is the single most useful string about
 * a session. The core writes `[Hayden] Fix the transcript scroller`-shaped
 * values: a bracketed TEAMMATE prefix followed by the actual task.
 *
 * The parse is deliberately conservative — ONE leading `[…]` group, no nesting,
 * nothing anywhere else in the string:
 *
 *   "[Hayden] Fix the scroller"  → prefix "Hayden" + task "Fix the scroller"
 *   "Fix the scroller"           → task only (the overwhelmingly common case for
 *                                  hand-launched sessions)
 *   "[Hayden]"                   → the bracket content IS the task; a prefix
 *                                  with nothing beside it says less than the one
 *                                  fact we have
 *   "fix [Hayden] later"         → left ALONE. A bracket mid-string is prose, and
 *                                  a regex greedy enough to find it would mangle
 *                                  markdown-ish task names.
 */

const BRACKET_PREFIX = /^\[([^[\]]+)\]\s*(.*)$/s;

export interface ParsedTask {
  /** Bracketed prefix, when the value had one AND had a task after it. */
  readonly prefix: string | null;
  /** The task text. Empty only when the name itself was empty. */
  readonly task: string;
}

/** Splits a session name into its teammate prefix and its task. */
export const parseTaskName = (name?: string | null): ParsedTask => {
  const raw = (name ?? '').trim();
  if (!raw) return { prefix: null, task: '' };
  const matched = BRACKET_PREFIX.exec(raw);
  if (!matched) return { prefix: null, task: raw };
  const prefix = (matched[1] ?? '').trim();
  const rest = (matched[2] ?? '').trim();
  // `[Hayden]` on its own: promote the bracket content to the task rather than
  // showing a prefix with nothing beside it.
  if (!rest) return { prefix: null, task: prefix || raw };
  return { prefix: prefix || null, task: rest };
};

/**
 * True when the task string says nothing the teammate callsign did not already
 * say — used by callers that render both and want to skip the duplicate.
 */
export const taskIsRedundant = (name: string | undefined, teammate: string | undefined): boolean => {
  const { task } = parseTaskName(name);
  if (!task) return true;
  return Boolean(teammate) && task.toLowerCase() === (teammate ?? '').trim().toLowerCase();
};
