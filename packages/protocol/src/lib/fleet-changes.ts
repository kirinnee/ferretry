/**
 * The shapes a reviewed account-model change shares with the fleet package's provisioner: the
 * handle a staged change is named by, the confirmation applying it may ask for, the writes it
 * previews, and how an apply ended.
 *
 * The routes that stage and apply a change are in `fleet-catalog.ts`; this file holds what both
 * that contract and the provisioner's own result types need, so neither restates the other.
 *
 * - **Absence is never silence.** An apply says what it left behind, and a rollback says what it
 *   could not verify. Every one of those is a field a reader can act on rather than a fact a caller
 *   has to infer from what is missing.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * A non-secret handle for one staged change. Safe in a path and in a log.
 *
 * IT IS A TRANSACTION HANDLE, NOT A CREDENTIAL, and it lives beside the change it names for exactly
 * that reason. It used to sit in a `fleet-authorization` module beside a single-use approval code,
 * which read as though holding one conferred something; it never did. Naming the staged artifact is
 * all it has ever done, and it is the one part of that module that survived the authorization half
 * being deleted.
 */
export const FleetProposalIdSchema = z.string().regex(/^fy_fprop_[A-Za-z0-9_-]{22}$/u, 'invalid fleet proposal id');
export type FleetProposalId = z.infer<typeof FleetProposalIdSchema>;

/**
 * The body of an apply. EMPTY, and kept as a schema so an old client's field is refused rather than
 * ignored: a governed caller's confirmation is the passkey step-up `fleet.configure` already demanded.
 */
export const FleetProposalApplyRequestSchema = z.strictObject({});
export type FleetProposalApplyRequest = z.infer<typeof FleetProposalApplyRequestSchema>;

/** A write that is not a plan operation: the configuration itself, and each edited asset. */
export const FleetDocumentSummarySchema = z.strictObject({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});
export type FleetDocumentSummary = z.infer<typeof FleetDocumentSummarySchema>;

/**
 * One write a plan will perform.
 *
 * Restated here rather than imported, because the browser does not depend on the fleet package —
 * that independence is the reason this contract exists at all. The daemon parses its own responses
 * through these schemas on the way out, so a plan that grows a field this does not know about fails
 * loudly at the daemon rather than silently at a client that cannot render it.
 *
 * `content` is deliberately absent from every operation: a wrapper's script is thousands of bytes
 * nobody reads in a review, and shipping it would make the payload the largest thing in the flow.
 */
export const FleetWriteOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('directory'), path: z.string().min(1), mode: z.number().int().optional() }),
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1), mode: z.number().int() }),
  z.strictObject({
    kind: z.literal('copy'),
    source: z.string().min(1),
    path: z.string().min(1),
    mode: z.number().int().optional(),
  }),
  z.strictObject({ kind: z.literal('symlink'), source: z.string().min(1), path: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('settings'),
    path: z.string().min(1),
    format: z.enum(['json', 'toml']),
    mode: z.number().int(),
    /** True when the file already at the path is folded in, so harness-written keys survive. */
    preserveExisting: z.boolean(),
    layerCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('codex-sqlite-ownership'),
    path: z.string().min(1),
    markerPath: z.string().min(1),
    sqliteHome: z.string().min(1),
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('prune'),
    path: z.string().min(1),
    marker: z.string().min(1),
    keep: z.array(z.string().min(1)).readonly(),
  }),
  /**
   * Empty a directory the plan materialized entry by entry of everything else it holds.
   *
   * It carries no marker, and a reader should see that as the wider bound it is: `prune` sweeps a
   * directory Ferretry shares with the user's own files and may only remove ones it marked, while this
   * sweeps a destination the fleet replaced wholesale on every apply before it became per-item. `keep`
   * is what bounds it, and it is exactly what this plan just put there.
   */
  z.strictObject({
    kind: z.literal('prune-directory'),
    path: z.string().min(1),
    keep: z.array(z.string().min(1)).readonly(),
  }),
  /**
   * A link to the one file a login lives in (Codex `auth.json`), which may not exist yet: an empty
   * slot has no login until somebody signs in, and the harness then writes it THROUGH this link.
   * Its own kind rather than a `symlink` with a flag, because "a link that is allowed to point at
   * nothing" is exactly what a reviewer needs to be told.
   */
  z.strictObject({ kind: z.literal('credential-link'), source: z.string().min(1), path: z.string().min(1) }),
  /**
   * Set named top-level keys in a document the harness also writes (Claude's `.claude.json`). The
   * listed keys are REPLACED whole; every other key in the file is left as the harness wrote it.
   */
  z.strictObject({
    kind: z.literal('json-keys'),
    path: z.string().min(1),
    format: z.enum(['json', 'toml']),
    mode: z.number().int(),
    replaceKeys: z.array(z.string().min(1)).readonly(),
    layerCount: z.number().int().nonnegative(),
  }),
  /**
   * Remove what an earlier apply put in a directory the person and the harness also write into, and
   * nothing else: only the named entries, and each only when it is a link or the earlier apply's
   * record names it. A file somebody made there stays.
   */
  z.strictObject({
    kind: z.literal('retire'),
    path: z.string().min(1),
    only: z.array(z.string().min(1)).readonly(),
    keep: z.array(z.string().min(1)).readonly(),
  }),
]);
export type FleetWriteOperation = z.infer<typeof FleetWriteOperationSchema>;

/**
 * Availability is a discriminant, not a flag beside an optional reason.
 *
 * The domain refuses a model that is unavailable without saying why, and one that claims to be
 * available while carrying a reason. Restating that here as a union rather than as two loose fields
 * is what stops the wire being able to express a state the fleet itself would reject — and a client
 * rendering "unavailable" with nothing to show for it.
 */
export const FleetManifestModelSummarySchema = z.discriminatedUnion('available', [
  z.strictObject({
    id: z.string().min(1),
    available: z.literal(true),
    displayName: z.string().min(1).optional(),
  }),
  z.strictObject({
    id: z.string().min(1),
    available: z.literal(false),
    displayName: z.string().min(1).optional(),
    unavailableReason: z.string().min(1),
  }),
]);

export const FleetManifestAccountSummarySchema = z
  .strictObject({
    id: z.uuid(),
    kind: z.enum(['claude', 'codex']),
    mode: z.enum(['interactive', 'auto']),
    wrapper: z.string().min(1),
    home: z.string().min(1),
    displayName: z.string().min(1),
    defaultModel: z.string().min(1).nullable(),
    /** Carried, because comparing a proposed roster against the live one needs what each serves. */
    models: z.array(FleetManifestModelSummarySchema).readonly(),
    available: z.boolean(),
    unavailableReason: z.string().min(1).nullable(),
  })
  // The same cross-field rules the configuration enforces, so a manifest cannot describe on the
  // wire an account the fleet would have refused to declare.
  .check(context => {
    const account = context.value;
    const say = (message: string, path: string): void => {
      context.issues.push({ code: 'custom', message, input: account, path: [path] });
    };
    if (account.available && account.unavailableReason !== null) {
      say('an available account must not carry an unavailableReason', 'unavailableReason');
    }
    if (!account.available && account.unavailableReason === null) {
      say('an unavailable account must state an unavailableReason', 'unavailableReason');
    }
    if (account.available && account.defaultModel === null) {
      say('an available account must name a defaultModel', 'defaultModel');
    }
    const chosen = account.models.find(model => model.id === account.defaultModel);
    if (account.defaultModel !== null && chosen === undefined) {
      say(`defaultModel "${account.defaultModel}" is not one of this account's models`, 'defaultModel');
    }
    // An account cannot default to a model it has itself declared down: every consumer would offer
    // it and every launch would fail on the same choice nobody made deliberately.
    if (chosen !== undefined && !chosen.available) {
      say(`defaultModel "${account.defaultModel}" is declared unavailable`, 'defaultModel');
    }
    const seen = new Set<string>();
    for (const model of account.models) {
      if (seen.has(model.id)) say(`duplicate model "${model.id}"`, 'models');
      seen.add(model.id);
    }
  });

export const FleetManifestSummarySchema = z
  .strictObject({
    version: z.number().int().positive(),
    generatedAt: InstantSchema,
    accounts: z.array(FleetManifestAccountSummarySchema).readonly(),
  })
  // Identity is what every consumer joins on, so a manifest that published the same id, wrapper or
  // home twice would make two accounts indistinguishable exactly where it matters most.
  .check(context => {
    for (const field of ['id', 'wrapper', 'home'] as const) {
      const seen = new Set<string>();
      for (const account of context.value.accounts) {
        if (seen.has(account[field])) {
          context.issues.push({
            code: 'custom',
            message: `duplicate account ${field} "${account[field]}"`,
            input: context.value,
            path: ['accounts', field],
          });
        }
        seen.add(account[field]);
      }
    }
  });
export type FleetManifestSummary = z.infer<typeof FleetManifestSummarySchema>;

/** What a history migration would move, per harness. Reported, never inferred from a total. */
export const FleetSharedHistorySummarySchema = z.strictObject({
  kind: z.enum(['claude', 'codex']),
  pool: z.string().min(1),
  migrated: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(),
});
export type FleetSharedHistorySummary = z.infer<typeof FleetSharedHistorySummarySchema>;

/** Residue a committed apply left behind. Never a failure, but it does need clearing. */
const residueShape = {
  /**
   * Moved-aside evidence still on disk. Undoing a committed apply to tidy up would delete the very
   * state the manifest now describes, so it is reported rather than removed.
   */
  backupResidue: z.array(z.string().min(1)).readonly().optional(),
  /** An exclusive claim that could not be cleared. It blocks the next apply until it is removed. */
  lockResidue: z.string().min(1).optional(),
  /**
   * Operations left as the disk has them, and why: where the destination side cannot reach a folder through its
   * descriptor (macOS), nothing below a runtime's top folder is moved aside or removed.
   */
  skipped: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        reason: z.string().min(1),
        /** The runtime (its account id) whose folder holds `path`. Absent when `path` is in no runtime's folder. */
        runtime: z.uuid().optional(),
        /** `path` relative to that runtime's folder: all a browser shows, never the folder's own place on disk. */
        within: z.string().min(1).optional(),
      }),
    )
    .readonly()
    .optional(),
};

/** State a rollback moved out of the way because it was not this apply's to delete. */
export const FleetDisplacedStateSchema = z.strictObject({
  path: z.string().min(1),
  movedTo: z.string().min(1),
});
export type FleetDisplacedState = z.infer<typeof FleetDisplacedStateSchema>;

export const FleetUnrestoredPathSchema = z.strictObject({
  path: z.string().min(1),
  reason: z.string().min(1),
  /** Where the original still is. Often the only remaining copy, so it is named, never cleaned. */
  backup: z.string().min(1).optional(),
});
export type FleetUnrestoredPath = z.infer<typeof FleetUnrestoredPathSchema>;

export const FleetApplyResultSchema = z.strictObject({
  accountCount: z.number().int().nonnegative(),
  operationCount: z.number().int().nonnegative(),
  /**
   * Non-empty, because a committed apply always published a manifest somewhere. An empty string was
   * how a scaffold used to masquerade as an apply of zero accounts; preparing a host now has its own
   * outcome, and this field refuses to describe anything that did not publish.
   */
  manifestPath: z.string().min(1),
  prunedWrappers: z.array(z.string().min(1)),
  sharedHistory: z.array(FleetSharedHistorySummarySchema).readonly(),
  ...residueShape,
});
export type FleetApplyResult = z.infer<typeof FleetApplyResultSchema>;

export const FleetApplyCommittedStateSchema = z.strictObject({
  accountCount: z.number().int().nonnegative(),
  operationCount: z.number().int().nonnegative(),
  manifestPath: z.string().min(1),
  manifest: FleetManifestSummarySchema,
  prunedWrappers: z.array(z.string().min(1)),
  sharedHistory: z.array(FleetSharedHistorySummarySchema).readonly(),
  ...residueShape,
});
export type FleetApplyCommittedState = z.infer<typeof FleetApplyCommittedStateSchema>;

/**
 * How an apply ended — as a body, not as a thrown error.
 *
 * The one thing a reader must know is structural: whether the host changed. A thrown API error
 * carries only a status, a message and a code, so every outcome that got as far as touching the
 * host comes back as a value instead.
 *
 * `rolled-back` is a claim about the *host*, not about the fleet: it requires that nothing was left
 * unrestored **and** that nothing of anybody else's had to be moved aside. Anything less is
 * `rollback-incomplete`, however cleanly the fleet itself reverted.
 */
export const FleetApplyOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('committed'), result: FleetApplyResultSchema }),
  z.strictObject({
    outcome: z.literal('committed-with-history-failure'),
    failedHarness: z.string().min(1),
    reason: z.string().min(1),
    committed: FleetApplyCommittedStateSchema,
    lockResidue: z.string().min(1).optional(),
  }),
  z.strictObject({
    outcome: z.literal('rolled-back'),
    failedOperation: z.string().min(1),
    reason: z.string().min(1),
    lockResidue: z.string().min(1).optional(),
  }),
  z.strictObject({
    outcome: z.literal('rollback-incomplete'),
    failedOperation: z.string().min(1),
    reason: z.string().min(1),
    unrestored: z.array(FleetUnrestoredPathSchema),
    displaced: z.array(FleetDisplacedStateSchema).optional(),
    lockResidue: z.string().min(1).optional(),
  }),
]);
export type FleetApplyOutcome = z.infer<typeof FleetApplyOutcomeSchema>;
