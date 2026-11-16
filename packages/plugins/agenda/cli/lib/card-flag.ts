import { parseTaskRef, type TaskRef } from '@ferretry/core-asks/contract';

/**
 * `fy agenda add --task <card>` (board-design.md §2.1, §2.6): `--task F18` (also `&F18`, `#F18`) names the board
 * CARD the item belongs to; leave `--task` out and the card is the focus card. A to-do is `--todo`, never `--task`.
 *
 * The option takes a required card reference. Anything else is refused, never read as part of the ask: a
 * typo'd card must not land the item on the focus card, and `--task Rotate the key` (the retired spelling of a
 * to-do) must not quietly raise a different kind of item.
 */
export interface CardFlag {
  /** `--task <card>` as typed; absent when not given. */
  readonly task?: string;
  /** `--todo`: the human does something; nothing to choose. */
  readonly todo?: boolean;
}

export interface ResolvedCardFlag {
  /** The ask's words, untouched. */
  readonly words: readonly string[];
  /** Whether the item is a to-do. */
  readonly todo: boolean;
  /** The card the item belongs to, when `--task` named one. */
  readonly card?: TaskRef;
}

export function resolveCardFlag(words: readonly string[], flags: CardFlag): ResolvedCardFlag {
  const todo = flags.todo === true;
  if (flags.task === undefined) return { words, todo };
  const card = parseTaskRef(flags.task);
  if (!card.ok) {
    throw new Error(`--task needs a card reference (F18 or &F18), not "${flags.task}"; for a to-do use --todo`);
  }
  return { words, todo, card: card.value };
}
