import { parseTaskRef, type TaskRef } from '@ferretry/protocol';

/**
 * `fy agenda add --task`, which means two things for one release (board-design.md §2.1, §2.6):
 *
 * - `--task F18` (also `&F18`, `#F18`) names the board CARD the item belongs to;
 * - a bare `--task` is the older spelling of `--todo`: the owner does something, nothing to choose.
 *
 * The option takes an optional value, so a word after a bare `--task` arrives as its value. A value that is
 * not a card reference is therefore the first word of the ask, put back where it came from, and the flag
 * keeps its to-do meaning — `fy agenda add --task Rotate the key` still raises a to-do.
 */
export interface CardFlag {
  /** `--task <card>` or `--task` (true) as parsed; absent when not given. */
  readonly task?: boolean | string;
  /** `--todo`: the to-do spelling that replaces a bare `--task`. */
  readonly todo?: boolean;
}

export interface ResolvedCardFlag {
  /** The ask's words, with a word a bare `--task` swallowed put back first. */
  readonly words: readonly string[];
  /** Whether the item is a to-do. */
  readonly todo: boolean;
  /** The card the item belongs to, when `--task` named one. */
  readonly card?: TaskRef;
}

export function resolveCardFlag(words: readonly string[], flags: CardFlag): ResolvedCardFlag {
  const task = flags.task;
  const todo = flags.todo === true;
  if (typeof task !== 'string') return { words, todo: todo || task === true };
  const card = parseTaskRef(task);
  return card.ok ? { words, todo, card: card.value } : { words: [task, ...words], todo: true };
}
