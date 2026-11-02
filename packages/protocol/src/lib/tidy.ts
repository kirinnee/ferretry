import { z } from 'zod';
import { AgendaIdSchema } from './agenda.ts';
import { BoardTaskIdSchema } from './board-refs.ts';

/**
 * TIDY — one ferret's clean-up of its own unwanted cards and work-tracking agenda items (docs/board.md,
 * "Tidy").
 *
 * The daemon owns the DECISION (which card is dropped, which item is closed, which is kept and why) so a
 * dry run, the real run and the tests share one rule. It does not own the ACT: the CLI applies the plan with
 * the card drop and the agenda "done" the ferret could have typed itself, item by item, so every change
 * keeps its history and its authority check. The plan names the calling session from its own credential and
 * never takes a session in the request.
 */

export const TIDY_PLAN_PATH = '/v1/tidy/plan' as const;

/** Why a card is kept. */
export const TidyCardKeepCodeSchema = z.enum([
  'owner-asked',
  'board-on',
  'assigned-to-live-session',
  'waiting-at-gate',
]);
export type TidyCardKeepCode = z.infer<typeof TidyCardKeepCodeSchema>;

/** Why an agenda item is kept. */
export const TidyItemKeepCodeSchema = z.enum(['gate', 'not-yours', 'owner-replying', 'needs-owner']);
export type TidyItemKeepCode = z.infer<typeof TidyItemKeepCodeSchema>;

/** Why an agenda item is closed. */
export const TidyCloseCodeSchema = z.enum(['info', 'card-dropped', 'status-only']);
export type TidyCloseCode = z.infer<typeof TidyCloseCodeSchema>;

export const TidyDropSchema = z.strictObject({
  id: BoardTaskIdSchema,
  title: z.string(),
  why: z.string(),
});
export type TidyDrop = z.infer<typeof TidyDropSchema>;

export const TidyCloseSchema = z.strictObject({
  id: AgendaIdSchema,
  subject: z.string(),
  code: TidyCloseCodeSchema,
  why: z.string(),
});
export type TidyClose = z.infer<typeof TidyCloseSchema>;

export const TidyKeepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('task'),
    id: BoardTaskIdSchema,
    title: z.string(),
    code: TidyCardKeepCodeSchema,
    why: z.string(),
  }),
  z.strictObject({
    kind: z.literal('agenda'),
    id: AgendaIdSchema,
    title: z.string(),
    code: TidyItemKeepCodeSchema,
    why: z.string(),
  }),
]);
export type TidyKeep = z.infer<typeof TidyKeepSchema>;

export const TidyPlanSchema = z.strictObject({
  v: z.literal(1),
  sessionId: z.string().min(1),
  /** A sub-ferret holds no cards to drop (the daemon refuses its drops), so its plan has none. */
  subFerret: z.boolean(),
  drop: z.array(TidyDropSchema),
  close: z.array(TidyCloseSchema),
  keep: z.array(TidyKeepSchema),
});
export type TidyPlan = z.infer<typeof TidyPlanSchema>;
