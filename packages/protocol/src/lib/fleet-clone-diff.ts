/**
 * The review a repeat copy shows before anything is written (docs/design/account-model.md §3.8 L1/L4,
 * docs/cross-daemon.md §3).
 *
 * `POST /v1/fleet/clone/review` takes the source's bundle and answers what a copy would change here:
 * every item that DIFFERS, why, and what is chosen for it — and a count of the ones that do not. An item
 * hidden as "the same" is byte-identical (every runnable field and every carried file) and is never written,
 * so what the review lists is everything an apply could write.
 *
 * The answer carries a `fingerprint`: the apply (`clone.import` with `mode: 'update'`) names it, the target
 * re-plans from the same inputs and refuses when it differs, so a person can never apply a review other
 * than the one they saw.
 *
 * Nothing here is a secret. Values shown are configuration text, which never holds a secret value (the
 * daemon refuses one); a `${secret:NAME}` stays a reference, and a login is a name and an outcome.
 */
import { z } from 'zod';
import { InstantSchema, NonEmptyStringSchema } from './common.ts';

/** What an item is, for the screen: a component kind, a profile or a runtime. A login is listed apart. */
export const CLONE_REVIEW_KINDS = [
  'instructions',
  'mcp',
  'skills',
  'settings',
  'hooks',
  'modelSets',
  'profile',
  'runtime',
] as const;
export const CloneReviewKindSchema = z.enum(CLONE_REVIEW_KINDS);
export type CloneReviewKind = z.infer<typeof CloneReviewKindSchema>;

/**
 * How one item stands against the other machine (design §3):
 * `new` — here never; `theirs` — changed on the source; `mine` — changed here, kept; `both` — changed on
 * both sides; `gone` — the source no longer has it; `removed-here` — copied before and removed here since.
 */
export const CLONE_OUTCOMES = ['new', 'theirs', 'mine', 'both', 'gone', 'removed-here'] as const;
export const CloneOutcomeSchema = z.enum(CLONE_OUTCOMES);
export type CloneOutcome = z.infer<typeof CloneOutcomeSchema>;

/** How an item was paired with its copy here: by origin key, by name alone (`probable`), or not at all. */
export const CloneMatchSchema = z.enum(['key', 'probable', 'none']);
export type CloneMatch = z.infer<typeof CloneMatchSchema>;

/**
 * What to do with one item. `take` writes the source's version here; `keep` leaves this machine's;
 * `remove` takes away an item the source no longer has; `add` brings in an item new here or one removed
 * here; `skip` leaves a new item out.
 */
export const CLONE_CHOICES = ['take', 'keep', 'remove', 'add', 'skip'] as const;
export const CloneChoiceSchema = z.enum(CLONE_CHOICES);
export type CloneChoice = z.infer<typeof CloneChoiceSchema>;

/** The choices an outcome allows. `both` allows two and has no default: nothing is chosen for the person. */
export const CLONE_OUTCOME_CHOICES = {
  new: ['add', 'skip'],
  theirs: ['take', 'keep'],
  mine: ['keep'],
  both: ['take', 'keep'],
  gone: ['keep', 'remove'],
  'removed-here': ['keep', 'add'],
} as const satisfies Record<CloneOutcome, readonly CloneChoice[]>;

/** The most items one review lists and one apply can decide. */
export const CLONE_REVIEW_ITEMS_LIMIT = 4096;

export const CloneReviewFileSchema = z.strictObject({
  path: NonEmptyStringSchema,
  change: z.enum(['added', 'changed', 'removed']),
  lines: z.strictObject({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }).optional(),
});

const CloneRunnableSchema = z.strictObject({
  reference: NonEmptyStringSchema,
  kind: z.enum(['instructions', 'mcp', 'skills', 'settings', 'hooks']),
  name: NonEmptyStringSchema,
  harness: z.enum(['claude', 'codex']).optional(),
  entries: z.array(z.strictObject({ label: z.string(), text: z.string(), document: z.boolean() })),
});

export const CloneReviewItemSchema = z.strictObject({
  /** The item as it is called here. */
  ref: NonEmptyStringSchema,
  /** The item as the source calls it. */
  sourceRef: NonEmptyStringSchema.optional(),
  kind: CloneReviewKindSchema,
  outcome: CloneOutcomeSchema,
  match: CloneMatchSchema,
  /** What is chosen by default. ABSENT for `both`: the person decides each one. */
  choice: CloneChoiceSchema.optional(),
  files: z.array(CloneReviewFileSchema),
  /** The top-level fields that differ, so a change with no document still says what it is. */
  fields: z.array(NonEmptyStringSchema).optional(),
  /** Only when the item would be written: everything it would run, exactly as the source exported it. */
  runnable: CloneRunnableSchema.optional(),
  /** What else this one pulls in or waits on, in words (`profile/review needs mcp/notes`). */
  needs: z.array(z.string()).optional(),
  /** A reason worth saying: a probable match, a duplicated link, a part that could not be compared. */
  note: z.string().optional(),
});
export type CloneReviewItem = z.infer<typeof CloneReviewItemSchema>;

export const CloneReviewLoginSchema = z.strictObject({
  sourceId: NonEmptyStringSchema,
  outcome: z.enum(['matched', 'slot', 'ask']),
  target: NonEmptyStringSchema.optional(),
  candidates: z.array(NonEmptyStringSchema).optional(),
});
export type CloneReviewLogin = z.infer<typeof CloneReviewLoginSchema>;

/** One settings document's keys. Filled by the per-key merge; empty until then. */
export const CloneReviewSettingsSchema = z.strictObject({
  path: NonEmptyStringSchema,
  keys: z.array(
    z.strictObject({
      key: NonEmptyStringSchema,
      outcome: CloneOutcomeSchema,
      mine: z.string().optional(),
      theirs: z.string().optional(),
      loosens: z.boolean().optional(),
    }),
  ),
});

/** One API key's name and how it stands. Names only. Filled with the newer-key copy; empty until then. */
export const CloneReviewKeySchema = z.strictObject({
  name: NonEmptyStringSchema,
  outcome: z.enum(['missing', 'newer', 'both', 'same']),
});

export const FleetCloneReviewSchema = z.strictObject({
  mode: z.enum(['first', 'update']),
  source: z.strictObject({
    name: z.string().max(120),
    lastCopiedAt: InstantSchema.optional(),
    verified: z.enum(['browser', 'self']),
  }),
  items: z.array(CloneReviewItemSchema).max(CLONE_REVIEW_ITEMS_LIMIT),
  settings: z.array(CloneReviewSettingsSchema),
  logins: z.array(CloneReviewLoginSchema),
  keys: z.array(CloneReviewKeySchema),
  /** What is already the same here, and how many of those were matched by name alone. */
  same: z.strictObject({ count: z.number().int().nonnegative(), probable: z.number().int().nonnegative() }),
  /** Names this review: the apply sends it back and is refused when this machine's answer has moved. */
  fingerprint: NonEmptyStringSchema,
});
export type FleetCloneReview = z.infer<typeof FleetCloneReviewSchema>;

/** `POST /v1/fleet/clone/review`: the same inputs `clone.import` takes, less the decisions. */
export const FleetCloneReviewRequestSchema = z.strictObject({
  bundle: z.record(z.string(), z.unknown()),
  source: z.strictObject({ daemonId: NonEmptyStringSchema }).optional(),
  names: z.strictObject({ source: NonEmptyStringSchema.max(120), target: NonEmptyStringSchema.max(120) }).optional(),
  settings: z
    .array(z.strictObject({ path: NonEmptyStringSchema, text: z.string() }))
    .max(8)
    .optional(),
  sourceSecrets: z
    .array(z.strictObject({ name: NonEmptyStringSchema, updatedAt: InstantSchema }))
    .max(1024)
    .optional(),
});
export type FleetCloneReviewRequest = z.infer<typeof FleetCloneReviewRequestSchema>;

/** One decision per item the review listed, by its `ref`. */
export const CloneDecisionsSchema = z
  .record(NonEmptyStringSchema, CloneChoiceSchema)
  .refine(decisions => Object.keys(decisions).length <= CLONE_REVIEW_ITEMS_LIMIT, {
    message: `a copy decides at most ${String(CLONE_REVIEW_ITEMS_LIMIT)} items`,
  });
export type CloneDecisions = z.infer<typeof CloneDecisionsSchema>;

/** Which login here each sign-in the source carries uses: an existing login's id, or `slot` for an empty one. */
export const CloneLoginChoicesSchema = z
  .record(NonEmptyStringSchema, NonEmptyStringSchema)
  .refine(choices => Object.keys(choices).length <= 512, { message: 'a copy settles at most 512 logins' });
export type CloneLoginChoices = z.infer<typeof CloneLoginChoicesSchema>;

/** The sentence a stale or incomplete apply is refused with. */
export const CLONE_REVIEW_STALE = 'Something changed since you reviewed. Review again.';
