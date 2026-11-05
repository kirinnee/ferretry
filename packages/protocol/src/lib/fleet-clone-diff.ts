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
import { CONFIG_FILE_MAX_BYTES } from './config-files.ts';
import { CloneableSecretNameSchema } from './secret-clone.ts';
import { MAX_SECRETS_PER_DAEMON } from './secrets.ts';

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

const CloneRunnableEntrySchema = z.strictObject({ label: z.string(), text: z.string(), document: z.boolean() });

const CloneRunnableSchema = z.strictObject({
  reference: NonEmptyStringSchema,
  kind: z.enum(['instructions', 'mcp', 'skills', 'settings', 'hooks']),
  name: NonEmptyStringSchema,
  harness: z.enum(['claude', 'codex']).optional(),
  entries: z.array(CloneRunnableEntrySchema),
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
  /**
   * Only for an ENVIRONMENT login the copy would add as a new login here: everything its runtimes run
   * with — harness, provider, every variable and both harness halves, `${secret:NAME}` as the reference,
   * never a value. A sign-in login carries none: it becomes an empty slot.
   */
  runnable: z.strictObject({ entries: z.array(CloneRunnableEntrySchema) }).optional(),
});
export type CloneReviewLogin = z.infer<typeof CloneReviewLoginSchema>;

/**
 * The settings documents a copy merges key by key: three configuration files, and the machine's
 * `controls` (`agentPermissions`, `agentControl.*`, `defaultRuntime`) as one keyed document.
 */
export const CLONE_SETTINGS_DOCS = ['warden.yaml', 'learning.yaml', 'voice.yaml', 'controls'] as const;
export const CloneSettingsDocSchema = z.enum(CLONE_SETTINGS_DOCS);
export type CloneSettingsDoc = z.infer<typeof CloneSettingsDocSchema>;

/** The most keys one settings document lists: a configuration file is far smaller than this. */
export const CLONE_SETTINGS_KEYS_LIMIT = 2048;

/** What to do with one settings key. `take` writes the source's value (or removes the key it no longer has). */
export const CloneKeyChoiceSchema = z.enum(['take', 'keep']);
export type CloneKeyChoice = z.infer<typeof CloneKeyChoiceSchema>;

/**
 * One settings document's differing keys (design §5). A key is a dotted path down to a scalar, and a list is
 * one value. `mine` and `theirs` are the values as configuration text, which never holds a secret value;
 * a `${secret:NAME}` stays a reference. A key both sides agree on is not listed.
 */
export const CloneReviewSettingsSchema = z.strictObject({
  path: CloneSettingsDocSchema,
  /** The document is not on this machine yet: a copy would create it. */
  isNew: z.boolean().optional(),
  /** Why this document cannot be copied here, in words: no key of it can be applied until it is left out. */
  refused: z.string().optional(),
  keys: z
    .array(
      z.strictObject({
        key: NonEmptyStringSchema,
        outcome: CloneOutcomeSchema,
        /** What is chosen by default. ABSENT for `both`: the person decides each one. */
        choice: CloneKeyChoiceSchema.optional(),
        mine: z.string().optional(),
        theirs: z.string().optional(),
        /** Taking this key would loosen what this machine may spend or what its agents may do. */
        loosens: z.boolean().optional(),
      }),
    )
    .max(CLONE_SETTINGS_KEYS_LIMIT),
});
export type CloneReviewSettings = z.infer<typeof CloneReviewSettingsSchema>;

/** One settings document as the source holds it: its text (a missing file is the empty text), or the controls as JSON. */
export const CloneSettingsTextSchema = z.strictObject({
  path: CloneSettingsDocSchema,
  text: z.string().refine(text => new TextEncoder().encode(text).length <= CONFIG_FILE_MAX_BYTES, {
    message: `a settings document is at most ${String(CONFIG_FILE_MAX_BYTES / 1024)} KiB`,
  }),
});
export type CloneSettingsText = z.infer<typeof CloneSettingsTextSchema>;

/** `clone.import`'s per-key decisions: for each document, for each key the review listed, take or keep. */
export const CloneSettingsDecisionsSchema = z.partialRecord(
  CloneSettingsDocSchema,
  z
    .record(NonEmptyStringSchema, CloneKeyChoiceSchema)
    .refine(keys => Object.keys(keys).length <= CLONE_SETTINGS_KEYS_LIMIT, { message: 'too many keys decided' }),
);
export type CloneSettingsDecisions = z.infer<typeof CloneSettingsDecisionsSchema>;

/**
 * How one API key stands against the source's copy of it, from `updatedAt` timestamps alone — no value and
 * no digest of one is ever compared (docs/secrets.md):
 *
 * - `missing` — the source holds it, this machine does not: it is copied, as it always was;
 * - `newer` — the source changed it since the last copy and nothing changed it here: REPORTED only;
 * - `both` — the source changed it AND it was changed here since the last copy: REPORTED only, saying so;
 * - `same` — nothing newer on the source, or no earlier copy to compare with: nothing is said.
 *
 * A copy NEVER writes a key this machine holds, whatever the outcome (docs/secrets.md): `newer` and `both` are
 * reports that tell the person to replace the key themselves, `fy secret set NAME`.
 */
export const CLONE_KEY_OUTCOMES = ['missing', 'newer', 'both', 'same'] as const;

/** One API key's name and how it stands. Names only: a sign-in's name is not a name a copy can carry. */
export const CloneReviewKeySchema = z.strictObject({
  name: CloneableSecretNameSchema,
  outcome: z.enum(CLONE_KEY_OUTCOMES),
});
export type CloneReviewKey = z.infer<typeof CloneReviewKeySchema>;

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
  settings: z.array(CloneSettingsTextSchema).max(CLONE_SETTINGS_DOCS.length).optional(),
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

/** The most characters a source may be named by when it is forgotten: an id, a name or a machine name. */
export const CLONE_FORGET_SOURCE_LIMIT = 200;

/**
 * `POST /v1/fleet/clone/forget`: drop the "last copied" record for one source, so the next copy from it
 * starts as if there had been none. `source` is how the machine knows the source — its id, as `self:<id>`
 * or the bare id the export carries — or the name it was copied under.
 */
export const FleetCloneForgetRequestSchema = z.strictObject({
  source: NonEmptyStringSchema.max(CLONE_FORGET_SOURCE_LIMIT),
});
export type FleetCloneForgetRequest = z.infer<typeof FleetCloneForgetRequestSchema>;

/** Whether there was a record to forget. Nothing copied, no login and no secret is touched either way. */
export const FleetCloneForgetResultSchema = z.strictObject({ forgotten: z.boolean() });
export type FleetCloneForgetResult = z.infer<typeof FleetCloneForgetResultSchema>;

/** `POST /v1/fleet/clone/keys`: the keys a sealed copy has just filed here, and when the source last changed each. */
export const FLEET_CLONE_KEYS_PATH = '/v1/fleet/clone/keys' as const;

/**
 * What the browser reports once a sealed copy has landed: the source it copied from, the instant this machine
 * says it filed them (`filedAt`, from the import's own answer) and, for each key it filed, the `updatedAt` the
 * SOURCE listed for it. The target records `filedAt` as the key's baseline ONLY for a key whose own store entry
 * was created at that instant: a key deleted and made again since is not the one the copy filed, so it is left
 * unrecorded, and a key the person edited since is still recorded at the copy's instant, so the next review
 * sees that it changed here. Timestamps only. A sign-in's name is refused at parse.
 */
export const FleetCloneKeysRecordRequestSchema = z.strictObject({
  source: z.strictObject({ daemonId: NonEmptyStringSchema }),
  filedAt: InstantSchema,
  keys: z
    .array(z.strictObject({ name: CloneableSecretNameSchema, sourceUpdatedAt: InstantSchema }))
    .min(1)
    .max(MAX_SECRETS_PER_DAEMON)
    .refine(keys => new Set(keys.map(key => key.name)).size === keys.length, 'each key is named once'),
});
export type FleetCloneKeysRecordRequest = z.infer<typeof FleetCloneKeysRecordRequestSchema>;

/** How many of those keys the record now holds (none when this machine has no record of that source). */
export const FleetCloneKeysRecordResultSchema = z.strictObject({ recorded: z.number().int().nonnegative() });
export type FleetCloneKeysRecordResult = z.infer<typeof FleetCloneKeysRecordResultSchema>;
