import { z } from 'zod';
import { toBullets } from './agenda.ts';
import { type BoardTask, BoardTaskEditFields, BoardTaskVisibilitySchema } from './board.ts';
import { PositiveIntegerSchema } from './common.ts';

/**
 * A CARD'S WORDS AS ONE EDITABLE DOCUMENT (`fy task patch`, docs/board.md § Patch: a card as one document).
 *
 * JSON Merge Patch (RFC 7386), as the agenda's (`agenda-patch.ts`): a key that is present replaces the field, an
 * absent key leaves it, `null` empties it; a list is replaced whole. Each field is the `edit` action's own schema
 * (`BoardTaskEditFields`), so a patch and `fy task edit` never disagree on what a field may hold.
 *
 * STRICT: the ask, the lane, links, history, owner and assignee are changed by their own verbs and are refused here by
 * name; the document has no token, digest or credential field for a patch to carry.
 */

/** A point list as a card stores it: one line is its text, several are one bullet each; `null` empties it. */
const points = <T extends z.ZodType>(field: z.ZodOptional<T>) =>
  z
    .preprocess(
      value =>
        value === null
          ? ''
          : Array.isArray(value) && value.every(point => typeof point === 'string')
            ? ((kept: string[]) => (kept.length === 1 ? kept[0] : toBullets(kept)))(
                value.map(point => point.trim()).filter(point => point !== ''),
              )
            : value,
      field.unwrap(),
    )
    .optional();

/** A Markdown field `null` empties. */
const emptied = <T extends z.ZodType>(field: z.ZodOptional<T>) =>
  z.preprocess(value => (value === null ? '' : value), field.unwrap()).optional();

export const BoardTaskPatchSchema = z.strictObject({
  /** READ BEFORE WRITE: the revision `fy task show <id> --yaml` printed (required); a stale one is refused. */
  revision: PositiveIntegerSchema,
  /** Rewritten, never removed. */
  title: BoardTaskEditFields.title,
  /** The one line the card face shows: rewritten, never removed. */
  summary: BoardTaskEditFields.summary,
  premise: points(BoardTaskEditFields.premise),
  context: points(BoardTaskEditFields.context),
  /** The glossary, replaced whole; `null` empties it. */
  terms: z.preprocess(value => (value === null ? [] : value), BoardTaskEditFields.terms.unwrap()).optional(),
  brief: emptied(BoardTaskEditFields.brief),
  howToTest: emptied(BoardTaskEditFields.howToTest),
  /**
   * The card's Status (&C48): the one object that MERGES BY KEY — each part named (`now`, `doneSoFar`, `next`) replaces
   * that part, the rest stay; `""` empties a part. The daemon merges it inside the card's write. Never `null`.
   */
  status: BoardTaskEditFields.status,
  visibility: BoardTaskVisibilitySchema.optional(),
});
export type BoardTaskPatch = z.infer<typeof BoardTaskPatchSchema>;

/** Every key a card patch takes, in the order `fy task show --yaml` prints them. */
export const BOARD_TASK_PATCH_KEYS = Object.keys(BoardTaskPatchSchema.shape) as readonly (keyof BoardTaskPatch)[];

/**
 * A CARD'S REVISION (`board.patch.1`): the seq of its newest history event. Every change to a card appends one, so it
 * moves on whenever anybody writes the card; the CLI prints it and the daemon checks it with this one function.
 */
export const boardTaskRevision = (task: Pick<BoardTask, 'history'>): number => task.history.at(-1)?.seq ?? 1;
