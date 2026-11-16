/**
 * Tidy's wire (§2.1), copied from today's `protocol/src/lib/tidy.ts` and `protocol/src/lib/service.ts` (the scratch
 * views) with the words renamed (task -> card, session -> ferret, sub-ferret -> helper, agenda item -> ask, info ->
 * notice) and the plan's `v` field dropped (no older reader to tell, A452).
 */
import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { AskIdSchema } from '@ferretry/core-asks/contract';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';

// ─── tidy plan (`POST /v1/tidy/plan`) ─────────────────────────────────────────────────────────────────────────────

/** A card's id as Board mints it (`B12`, `F412`, `I3`, `C9`); Tidy reads it, never makes one. */
export const TidyCardIdSchema = z.string().regex(/^[BFIC][1-9][0-9]{0,8}$/u);
export type TidyCardId = z.infer<typeof TidyCardIdSchema>;

/** Why a card is kept. */
export const TidyCardKeepCodeSchema = z.enum(['owner-asked', 'board-on', 'assigned-to-live-ferret', 'waiting-at-gate']);
export type TidyCardKeepCode = z.infer<typeof TidyCardKeepCodeSchema>;

/** Why an ask is kept. */
export const TidyAskKeepCodeSchema = z.enum(['gate', 'not-yours', 'owner-replying', 'needs-owner']);
export type TidyAskKeepCode = z.infer<typeof TidyAskKeepCodeSchema>;

/** Why an ask is closed. */
export const TidyCloseCodeSchema = z.enum(['notice', 'card-dropped', 'status-only']);
export type TidyCloseCode = z.infer<typeof TidyCloseCodeSchema>;

export const TidyDropSchema = z.strictObject({ id: TidyCardIdSchema, title: z.string(), why: z.string() });
export type TidyDrop = z.infer<typeof TidyDropSchema>;

export const TidyCloseSchema = z.strictObject({
  id: AskIdSchema,
  subject: z.string(),
  code: TidyCloseCodeSchema,
  why: z.string(),
});
export type TidyClose = z.infer<typeof TidyCloseSchema>;

export const TidyKeepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('card'),
    id: TidyCardIdSchema,
    title: z.string(),
    code: TidyCardKeepCodeSchema,
    why: z.string(),
  }),
  z.strictObject({
    kind: z.literal('ask'),
    id: AskIdSchema,
    title: z.string(),
    code: TidyAskKeepCodeSchema,
    why: z.string(),
  }),
]);
export type TidyKeep = z.infer<typeof TidyKeepSchema>;

/**
 * `POST /v1/tidy/plan`'s optional body. `ferret` is the owner's way to plan ANOTHER ferret's tidy (v4's `--session`); a
 * ferret's own credential may leave it out or name itself, and any other ferret is refused.
 */
export const TidyPlanRequestSchema = z.strictObject({ ferret: FerretIdSchema.optional() });
export type TidyPlanRequest = z.infer<typeof TidyPlanRequestSchema>;

/** The plan names the ferret it is for: the caller's own from its credential, or the one the owner asked about. */
export const TidyPlanSchema = z.strictObject({
  ferret: FerretIdSchema,
  /** A helper holds no cards to drop (the board refuses its drops), so its plan has none. */
  helper: z.boolean(),
  drop: z.array(TidyDropSchema),
  close: z.array(TidyCloseSchema),
  keep: z.array(TidyKeepSchema),
});
export type TidyPlan = z.infer<typeof TidyPlanSchema>;

// ─── scratch (`GET`/`POST /v1/gc`) ────────────────────────────────────────────────────────────────────────────────

export const SCRATCH_PATH = '/v1/gc' as const;

export const ScratchEntrySchema = z.object({
  name: z.string().min(1),
  bytes: NonNegativeIntegerSchema,
  kind: z.enum(['file', 'directory', 'symlink']),
});
export type ScratchEntry = z.infer<typeof ScratchEntrySchema>;

const ScratchPlanBaseShape = {
  ferret: FerretIdSchema,
  /** The ferret's name as the owner reads it. */
  name: z.string().optional(),
  directory: z.string().min(1),
  bytes: NonNegativeIntegerSchema,
  entries: z.array(ScratchEntrySchema),
};

export const ScratchPlanViewSchema = z.discriminatedUnion('eligible', [
  z.object({ ...ScratchPlanBaseShape, eligible: z.literal(true), reason: z.undefined().optional() }),
  z.object({ ...ScratchPlanBaseShape, eligible: z.literal(false), reason: z.string().min(1) }),
]);
export type ScratchPlanView = z.infer<typeof ScratchPlanViewSchema>;

export const ScratchPlanListSchema = z.array(ScratchPlanViewSchema);
export type ScratchPlanList = z.infer<typeof ScratchPlanListSchema>;

export const ScratchSweepViewSchema = z.object({
  ferrets: NonNegativeIntegerSchema,
  bytes: NonNegativeIntegerSchema,
  failures: NonNegativeIntegerSchema,
});
export type ScratchSweepView = z.infer<typeof ScratchSweepViewSchema>;

/** `POST /v1/gc`: `force` sweeps even when `config/tidy.yaml` switched the automatic sweep off. */
export const ScratchSweepRequestSchema = z.strictObject({ force: z.boolean().default(false) });
export type ScratchSweepRequest = z.infer<typeof ScratchSweepRequestSchema>;

export const SCRATCH_CODES = {
  unknownParameter: 'unknown_parameter',
  invalidLimit: 'invalid_limit',
} as const;
export const TIDY_CODES = {
  forbidden: 'forbidden',
  /** A ferret's credential named a ferret other than itself. */
  notYours: 'not_yours',
  unknownFerret: 'unknown_ferret',
  unavailable: 'unavailable',
} as const;

// ─── config and state ─────────────────────────────────────────────────────────────────────────────────────────────

/** Today's defaults (`defaultScratchCollectorConfig`). */
export const SCRATCH_DEFAULTS = { enabled: true, ttlHours: 24, perSweep: 20 } as const;

/** `config/tidy.yaml`. */
export const TidyConfigSchema = z.strictObject({
  scratch: z
    .strictObject({
      /** Whether the sweep runs by itself; an explicit `fy gc --force`-style request still can. */
      enabled: z.boolean().default(SCRATCH_DEFAULTS.enabled),
      /** How long a ferret must have been stopped before its scratch is reclaimed. */
      ttlHours: z.number().int().min(1).max(8_760).default(SCRATCH_DEFAULTS.ttlHours),
      /** How many ferrets one sweep reclaims from. */
      perSweep: z.number().int().min(1).max(500).default(SCRATCH_DEFAULTS.perSweep),
    })
    .default(SCRATCH_DEFAULTS),
});
export type TidyConfig = z.infer<typeof TidyConfigSchema>;

/** `state/tidy/housekeeping.json`: what the sweeps have reclaimed so far (today's lifetime counters). */
export const HousekeepingSchema = z.strictObject({
  format: z.literal(1),
  reclaimedFerrets: NonNegativeIntegerSchema,
  reclaimedBytes: NonNegativeIntegerSchema,
  lastSweepAt: InstantSchema.optional(),
});
export type Housekeeping = z.infer<typeof HousekeepingSchema>;

/** What the health report and the app read through the port. */
export const TidyTotalsSchema = z.strictObject({
  enabled: z.boolean(),
  reclaimedFerrets: NonNegativeIntegerSchema,
  reclaimedBytes: NonNegativeIntegerSchema,
});
export type TidyTotals = z.infer<typeof TidyTotalsSchema>;

/**
 * Switching the automatic sweep on, or shortening the wait before it clears a stopped ferret's files, lets the machine
 * delete files sooner and unasked: a loosening the owner confirms. Judged against the defaults when there is no file.
 */
export function tidyLoosens(before: TidyConfig | undefined, after: TidyConfig): readonly string[] {
  const was = before?.scratch ?? SCRATCH_DEFAULTS;
  const out: string[] = [];
  if (after.scratch.enabled && !was.enabled) out.push('scratch is cleared automatically');
  if (after.scratch.ttlHours < was.ttlHours) out.push('scratch is cleared sooner after a ferret stops');
  if (after.scratch.perSweep > was.perSweep) out.push('a sweep clears scratch from more ferrets');
  return out;
}
