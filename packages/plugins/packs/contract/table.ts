/**
 * A LEAD'S ONE-TABLE VIEW OF ITS PACK — `GET /v1/ferrets/:ferretId/pack` and `fy pack` (docs/pack-mode.md § Checking
 * on your helpers). Today's `fy status --subtree`: the word is the lead's pack now (§1.2).
 *
 * Each live ferret below the asked one is one row: who, on what model, in what state, on which card and PR, and the one line
 * it last said. The daemon builds the rows from what Ferrets holds (its children and its sitrep lines), so a lead
 * reads state it did not have to carry in its context.
 */
import { FerretStateSchema } from '@ferretry/core-ferrets/contract';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from '@ferretry/std';
import { z } from 'zod';

/** How long after it ended a ferret below still has a row, marked `ended`: long enough to read a result. */
export const PACK_ENDED_WINDOW_MS = 2 * 60 * 60_000;

/** The longest a row's last line may be, in characters (code points, so an emoji is one), ellipsis included. */
export const PACK_LAST_LINE_MAX = 100;

/** How many characters a row's last line has — the one rule the daemon cuts by and the schema checks by. */
export const lastLineLength = (text: string): number => [...text].length;

/** How a row's ferret is doing, in a lead's words. */
export const PackRowStateSchema = z.enum(['running', 'waiting', 'needs-you', 'ended']);
export type PackRowState = z.infer<typeof PackRowStateSchema>;

export const PackRowSchema = z.strictObject({
  id: z.string().min(1),
  /** The ferret's name. */
  name: z.string().min(1),
  parent: z.string().min(1).optional(),
  /** 1 for a child of the asked ferret, 2 for a grandchild, and so on. */
  depth: PositiveIntegerSchema,
  /** The model it runs (what it was started with; `default` when it named none), as today's table showed. */
  model: z.string().min(1),
  state: PackRowStateSchema,
  /** The ferret's own state, for a reader who needs more than the four-way row state. */
  ferretState: FerretStateSchema,
  /** The card it works on (`&F767`) and that card's lane, as its card line says. */
  card: z.strictObject({ ref: z.string().min(1), lane: z.string().min(1).optional() }).optional(),
  /** The card's PR — the open one when there are several, else the newest — as the board's PR cache last read it. */
  pr: z
    .strictObject({
      number: PositiveIntegerSchema,
      url: z.string().min(1),
      state: z.enum(['unknown', 'open', 'closed', 'merged']),
      draft: z.boolean(),
      checks: z.enum(['none', 'pending', 'passing', 'failing']),
    })
    .optional(),
  /** The newest line a plugin added to its sitrep, cut to one line. */
  last: z
    .strictObject({
      at: InstantSchema,
      source: z.enum(['note', 'message']),
      text: z
        .string()
        .min(1)
        .refine(text => lastLineLength(text) <= PACK_LAST_LINE_MAX, {
          message: `at most ${PACK_LAST_LINE_MAX} characters`,
        }),
    })
    .optional(),
  /** When it ended; present exactly on an `ended` row. */
  endedAt: InstantSchema.optional(),
});
export type PackRow = z.infer<typeof PackRowSchema>;

export const PackTableSchema = z.strictObject({
  root: z.strictObject({ id: z.string().min(1), name: z.string().min(1) }),
  /** When the daemon read the rows. */
  at: InstantSchema,
  /** The window an ended ferret stays listed for. */
  endedWindowMs: NonNegativeIntegerSchema,
  /** Tree order: a ferret, then its own helpers, then the next sibling. */
  rows: z.array(PackRowSchema),
});
export type PackTable = z.infer<typeof PackTableSchema>;
