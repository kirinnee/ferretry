/**
 * The wire contract for inspecting and changing a daemon's fleet.
 *
 * Three consumers have to agree on every shape here — the daemon that produces them, the command
 * line that prints them, and the browser that renders them — so they live in the one package all
 * three already depend on. A copy in each is how three descriptions of the same thing quietly stop
 * being the same thing.
 *
 * Two properties are worth naming because the schemas encode them rather than merely allowing them:
 *
 * - **Absence is never silence.** A listing says whether it is complete, an apply says what it
 *   left behind, and a rollback says what it could not verify. Every one of those is a field a
 *   reader can act on rather than a fact a caller has to infer from what is missing.
 * - **A caller never sends a configuration.** It sends one named intent. The daemon derives the
 *   document, so a change means the same thing to the person approving it as to the host applying
 *   it.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { FleetApprovalCodeSchema, FleetProposalIdSchema } from './fleet-authorization.ts';

/** What this caller's credential permits, read before a surface offers a control it cannot use. */
export const FleetPermissionsSchema = z.strictObject({
  mayInspect: z.boolean(),
  mayPropose: z.boolean(),
  /** True when the credential is already the host's, so no separate approval is needed. */
  mayApplyDirectly: z.boolean(),
  /** True when applying is possible, but only with an approval the host minted for one change. */
  mayApplyWithApproval: z.boolean(),
  /** The command a person runs on the host to mint that approval. */
  approvalCommand: z.string().min(1),
});
export type FleetPermissions = z.infer<typeof FleetPermissionsSchema>;

/**
 * One entry in the asset tree.
 *
 * Something the editor will not touch is still listed, with the reason. Omitting it would tell a
 * person their instructions are missing when they are merely a link, a binary, or over the limit.
 */
export const FleetAssetListingSchema = z.discriminatedUnion('readable', [
  z.strictObject({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    readable: z.literal(true),
  }),
  z.strictObject({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    readable: z.literal(false),
    /** Required: damaged evidence that does not explain itself is indistinguishable from absence. */
    reason: z.string().min(1),
  }),
]);
export type FleetAssetListing = z.infer<typeof FleetAssetListingSchema>;

export const FleetAssetIndexSchema = z.strictObject({
  files: z.array(FleetAssetListingSchema).readonly(),
  /** False when a bound stopped the walk. A truncated list must never read as the whole tree. */
  complete: z.boolean(),
});
export type FleetAssetIndex = z.infer<typeof FleetAssetIndexSchema>;

export const FleetAssetDocumentSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type FleetAssetDocument = z.infer<typeof FleetAssetDocumentSchema>;

/** A text file a change will write into the asset tree, relative to it and always `/`-separated. */
export const FleetAssetEditSchema = z.strictObject({ path: z.string().min(1), content: z.string() });
export type FleetAssetEdit = z.infer<typeof FleetAssetEditSchema>;

const NonEmpty = z.string().min(1);
const AccountModeSchema = z.enum(['interactive', 'auto']);

/**
 * A settings document, spelled out rather than left as `unknown`.
 *
 * Harness settings are ordinary JSON — objects, arrays, strings, numbers, booleans and nulls — and
 * saying so is what makes the contract closed. `unknown` would accept a function, a `Date` or an
 * undefined that survives no round trip, and none of those can be a settings value.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const SettingsLayerValueSchema = z.union([NonEmpty, z.record(z.string(), JsonValueSchema)]);
const SettingsFieldSchema = z.union([SettingsLayerValueSchema, z.array(SettingsLayerValueSchema).readonly()]);

/** The fields an overlay may carry, spelled out. Arbitrary keys are refused, not carried along. */
const layerFields = {
  env: z.record(z.string(), z.string()),
  flags: z.array(NonEmpty).readonly(),
  settings: SettingsFieldSchema,
  memory: NonEmpty,
  skills: NonEmpty,
  hooks: NonEmpty,
  hooksDir: NonEmpty,
  mcp: NonEmpty,
} as const;

const patchOf = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const HarnessOverlayPatchSchema = z.strictObject({
  env: patchOf(layerFields.env),
  flags: patchOf(layerFields.flags),
  settings: patchOf(layerFields.settings),
  memory: patchOf(layerFields.memory),
  skills: patchOf(layerFields.skills),
  hooks: patchOf(layerFields.hooks),
  hooksDir: patchOf(layerFields.hooksDir),
  mcp: patchOf(layerFields.mcp),
});

/**
 * An account's own overlay: the instructions, skills, settings and environment that belong to this
 * one account rather than to everything sharing its agent.
 *
 * Strict, and a **patch** rather than a replacement. An editor that shows four of these fields must
 * not silently erase the other four by sending back only what it displayed — so an omitted field is
 * left exactly as it is, and removing one takes an explicit `null`. The `claude` and `codex`
 * overlays follow the same rule.
 */
export const FleetAccountLayerPatchSchema = z.strictObject({
  env: patchOf(layerFields.env),
  flags: patchOf(layerFields.flags),
  settings: patchOf(layerFields.settings),
  memory: patchOf(layerFields.memory),
  skills: patchOf(layerFields.skills),
  hooks: patchOf(layerFields.hooks),
  hooksDir: patchOf(layerFields.hooksDir),
  mcp: patchOf(layerFields.mcp),
  claude: patchOf(HarnessOverlayPatchSchema),
  codex: patchOf(HarnessOverlayPatchSchema),
});
export type FleetAccountLayerPatch = z.infer<typeof FleetAccountLayerPatchSchema>;

const AccountLayerSchema = FleetAccountLayerPatchSchema;

/**
 * The one named intent a caller may send.
 *
 * Editing is a patch: an omitted field is left alone and an explicit `null` removes it. Both are
 * needed — without the distinction, an edit that names one field would blank everything it did not
 * name, and there would be no way to clear a field at all.
 */
export const FleetMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('initialize') }),
  z.strictObject({
    kind: z.literal('create-account'),
    harness: z.enum(['claude', 'codex']),
    name: NonEmpty,
    variant: NonEmpty.optional(),
    displayName: NonEmpty.optional(),
    mode: AccountModeSchema.optional(),
    models: z.array(NonEmpty).readonly(),
    defaultModel: NonEmpty.optional(),
    available: z.boolean().optional(),
    unavailableReason: NonEmpty.optional(),
    layer: AccountLayerSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('edit-account'),
    accountId: z.uuid(),
    displayName: NonEmpty.nullable().optional(),
    mode: AccountModeSchema.nullable().optional(),
    models: z.array(NonEmpty).readonly().optional(),
    defaultModel: NonEmpty.nullable().optional(),
    available: z.boolean().optional(),
    unavailableReason: NonEmpty.nullable().optional(),
    layer: AccountLayerSchema.nullable().optional(),
  }),
]);
export type FleetMutation = z.infer<typeof FleetMutationSchema>;

export const FleetProposalRequestSchema = z.strictObject({
  mutation: FleetMutationSchema,
  assetEdits: z.array(FleetAssetEditSchema).optional(),
});
export type FleetProposalRequest = z.infer<typeof FleetProposalRequestSchema>;

export const FleetProposalApplyRequestSchema = z.strictObject({
  /**
   * Present only for a caller whose credential does not already authorise the change, and held to
   * the same grammar the mint produces. A separate length rule here would be a second, laxer
   * description of the one thing this field can be.
   */
  approvalCode: FleetApprovalCodeSchema.optional(),
});
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

export const FleetPlanSummarySchema = z.strictObject({
  manifest: FleetManifestSummarySchema,
  manifestPath: z.string().min(1),
  operations: z.array(FleetWriteOperationSchema).readonly(),
  sharedHistory: z.array(FleetSharedHistorySummarySchema).readonly(),
});
export type FleetPlanSummary = z.infer<typeof FleetPlanSummarySchema>;

/** Everything a first run creates, as the reviewer sees it. */
export const FleetScaffoldSummarySchema = z.strictObject({
  directories: z.array(z.string().min(1)).readonly(),
  /** Objects, not bare strings: the shape the surface already renders, kept rather than narrowed. */
  files: z.array(z.strictObject({ path: z.string().min(1) })).readonly(),
  /** The line a person adds to their shell profile so the generated wrappers are runnable. */
  pathEntry: z.string().min(1),
});
export type FleetScaffoldSummary = z.infer<typeof FleetScaffoldSummarySchema>;

/**
 * What the reviewer is shown. `documents` is pinned alongside the plan because reviewing every
 * write before it happens has to include the ones that are not plan operations.
 */
export const FleetProposalPreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('apply'),
    plan: FleetPlanSummarySchema,
    documents: z.array(FleetDocumentSummarySchema).readonly(),
  }),
  z.strictObject({
    kind: z.literal('initialize'),
    scaffold: FleetScaffoldSummarySchema,
    documents: z.array(FleetDocumentSummarySchema).readonly(),
  }),
]);
export type FleetProposalPreview = z.infer<typeof FleetProposalPreviewSchema>;

export const FleetProposalViewSchema = z.strictObject({
  id: FleetProposalIdSchema,
  /** The configuration revision this change was derived from, or the missing-config sentinel. */
  revision: z.string().min(1),
  mutation: FleetMutationSchema,
  summary: z.string().min(1),
  expiresAt: InstantSchema,
  state: z.enum(['pending', 'consumed']),
  /** Edited assets by size. The text is what the reviewer just composed; its length is the fact. */
  assetEdits: z.array(FleetDocumentSummarySchema).readonly(),
  preview: FleetProposalPreviewSchema,
  /**
   * Whether an approval is outstanding, and until when — never the code itself. The value is
   * structurally absent from this shape rather than filtered out of it.
   */
  approval: z.strictObject({ outstanding: z.literal(true), expiresAt: InstantSchema }).optional(),
});
export type FleetProposalView = z.infer<typeof FleetProposalViewSchema>;

/** Residue a committed apply left behind. Never a failure, but it does need clearing. */
const residueShape = {
  /**
   * Moved-aside evidence still on disk. Undoing a committed apply to tidy up would delete the very
   * state the manifest now describes, so it is reported rather than removed.
   */
  backupResidue: z.array(z.string().min(1)).readonly().optional(),
  /** An exclusive claim that could not be cleared. It blocks the next apply until it is removed. */
  lockResidue: z.string().min(1).optional(),
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
    /**
     * Preparing a host is its own outcome, not an apply that published nothing. It creates only
     * what is absent and publishes no manifest, so reporting it as a committed apply of zero
     * accounts would tell a person their fleet is empty rather than that it is now ready.
     */
    outcome: z.literal('initialized'),
    created: z.array(z.string().min(1)).readonly(),
    kept: z.array(z.string().min(1)).readonly(),
    directories: z.array(z.string().min(1)).readonly(),
    /** The line a person adds to their shell profile so the generated wrappers are runnable. */
    pathEntry: z.string().min(1),
    lockResidue: z.string().min(1).optional(),
  }),
  z.strictObject({
    /**
     * Preparation stopped part-way. It has no undo — every file it writes is one that was absent,
     * and removing them again could not be told apart from removing files somebody else just made —
     * so the honest report is exactly what landed and where it stopped. Running it again completes
     * it, because absence is still the kernel's decision.
     */
    outcome: z.literal('initialization-partial'),
    reason: z.string().min(1),
    failedPath: z.string().min(1),
    created: z.array(z.string().min(1)).readonly(),
    kept: z.array(z.string().min(1)).readonly(),
    directories: z.array(z.string().min(1)).readonly(),
    lockResidue: z.string().min(1).optional(),
  }),
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

/** Every refusal the fleet surface answers with, so a client can branch on cause not on prose. */
export const FLEET_REFUSAL_CODES = [
  'fleet_config_missing',
  'fleet_config_invalid',
  'fleet_not_applied',
  'fleet_manifest_invalid',
  'fleet_plan_refused',
  'fleet_apply_refused',
  'fleet_environment_refused',
  'fleet_asset_refused',
  'fleet_proposal_refused',
  'fleet_proposal_unknown',
  'fleet_proposal_expired',
  'fleet_proposal_consumed',
  'fleet_proposal_unauthorized',
  'fleet_proposal_stale',
] as const;

export const FleetRefusalCodeSchema = z.enum(FLEET_REFUSAL_CODES);
export type FleetRefusalCode = z.infer<typeof FleetRefusalCodeSchema>;
