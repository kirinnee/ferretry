/**
 * `fy task patch` and `fy task show --yaml` (&F957; docs/board.md § Patch: a card as one document).
 *
 * A card's words are ONE editable document. `cardPatchDocument` prints it with its revision; `composeCardPatch` reads
 * a patch against the card as it stands — refusing one written against an older revision (read before write) — and
 * composes the ONE `edit` action carrying what differs: the same action, validation and governance as `fy task edit`,
 * never a second write path. Pure.
 */
import {
  BOARD_TASK_PATCH_KEYS,
  type BoardTask,
  type BoardTaskActionRequestInput,
  type BoardTaskPatch,
  BoardTaskPatchSchema,
  boardTaskRevision,
} from '@ferretry/protocol';
import { patchProblems, readPatchText, samePatchValue } from '../patch/document.ts';
import { taskTitleIssue } from '../tasks/task-title.ts';

type CardWords = Pick<
  BoardTask,
  'title' | 'summary' | 'premise' | 'context' | 'terms' | 'brief' | 'howToTest' | 'visibility' | 'status' | 'history'
>;

type WordKey = Exclude<keyof BoardTaskPatch, 'revision'>;

const WORD_KEYS = BOARD_TASK_PATCH_KEYS.filter((key): key is WordKey => key !== 'revision');

/** The card as the document `patch` takes back: its revision, then every field it changes ("" when empty). */
export function cardPatchDocument(card: CardWords): Record<string, unknown> {
  return {
    revision: boardTaskRevision(card),
    ...Object.fromEntries(
      WORD_KEYS.flatMap(key => {
        const value = card[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
}

/** A patch's text, parsed: the document, or every problem in it, one line each. */
export function parseCardPatch(
  text: string,
  source: string,
):
  | { readonly ok: true; readonly patch: BoardTaskPatch }
  | { readonly ok: false; readonly problems: readonly string[] } {
  const read = readPatchText(text, source);
  if (!read.ok) return { ok: false, problems: [read.problem] };
  if (!('revision' in read.value)) {
    return {
      ok: false,
      problems: [
        'revision: required — read the whole card first (task show <id> --yaml prints it), so no part is left out of date',
      ],
    };
  }
  const parsed = BoardTaskPatchSchema.safeParse(read.value);
  if (!parsed.success) return { ok: false, problems: patchProblems(parsed.error, BOARD_TASK_PATCH_KEYS) };
  if (WORD_KEYS.every(key => parsed.data[key] === undefined)) {
    return { ok: false, problems: [`${source} names no field to change: a patch changes at least one`] };
  }
  const title = parsed.data.title;
  const titleProblem = title === undefined ? null : taskTitleIssue(title);
  if (titleProblem !== null) return { ok: false, problems: [`title: ${titleProblem}`] };
  return { ok: true, patch: parsed.data };
}

/** What a card patch asks: the edit to send, nothing (every value matches), or a refusal (read it again). */
export type CardPatchPlan =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'edit'; readonly request: BoardTaskActionRequestInput };

/** The ONE edit a patch is against `card`; `stale` when the card has changed since the patch's revision was read. */
export function composeCardPatch(card: CardWords, patch: BoardTaskPatch): CardPatchPlan {
  if (patch.revision !== boardTaskRevision(card)) return { kind: 'stale' };
  const fields: Record<string, unknown> = Object.fromEntries(
    WORD_KEYS.flatMap(key => {
      if (key === 'status') return [];
      const value = patch[key];
      return value === undefined || samePatchValue(value, card[key]) ? [] : [[key, value]];
    }),
  );
  const status = changedStatusParts(card, patch.status);
  if (status !== undefined) fields.status = status;
  if (Object.keys(fields).length === 0) return { kind: 'unchanged' };
  return {
    kind: 'edit',
    request: { action: 'edit', revision: patch.revision, ...fields } as BoardTaskActionRequestInput,
  };
}

/**
 * The status parts a patch names that differ from the card's (a card with no status reads each part as ""): the status
 * MERGES BY KEY, so only those go, and the daemon merges them into the card's status inside its write.
 */
function changedStatusParts(
  card: CardWords,
  status: BoardTaskPatch['status'],
): NonNullable<BoardTaskPatch['status']> | undefined {
  if (status === undefined) return undefined;
  const parts = (['now', 'doneSoFar', 'next'] as const).flatMap(part => {
    const value = status[part];
    return value === undefined || value === (card.status?.[part] ?? '') ? [] : [[part, value] as const];
  });
  return parts.length === 0 ? undefined : Object.fromEntries(parts);
}
