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
import { GrantRefusalSchema, OperatorPasswordSchema } from './grants.ts';

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
 * What a governed caller must produce before one staged change is applied.
 *
 * TWO VALUES, AND THE SECOND IS NOT A SECOND CREDENTIAL SYSTEM. `none` is the answer for a caller the
 * operator's grants do not govern at all — the host's own command line, and a browser on this machine
 * that has already unlocked — and for a machine with no operator password, where there is no secret to
 * bind a change to and a prompt would be a control that cannot refuse. `operator-password` is the
 * per-change confirmation: the SAME password the unlock is made of, proved again against this exact
 * staged change, so a borrowed five-minute unlock is not by itself enough to provision a host.
 */
export const FleetChangeConfirmationSchema = z.enum(['none', 'operator-password']);
export type FleetChangeConfirmation = z.infer<typeof FleetChangeConfirmationSchema>;

/**
 * What this caller may do here, read before a surface offers a control it cannot use.
 *
 * IT IS THE CAPABILITY LAYER'S ANSWER, not a second one. `mayApply` is `fleet.configure` as
 * `decideCapability` decided it for this request, and `confirmation` says whether applying will ask
 * for the operator password once more. The shape used to carry `mayApplyDirectly`,
 * `mayApplyWithApproval` and the command that minted an approval code — three fields describing an
 * authority the fleet ran privately, in a vocabulary no other capability shared.
 */
export const FleetPermissionsSchema = z.strictObject({
  mayInspect: z.boolean(),
  mayPropose: z.boolean(),
  /** `fleet.configure` for this caller, as the operator's grants decided it. */
  mayApply: z.boolean(),
  /**
   * WHY `mayApply` reads the way it does, in the SHARED grant vocabulary.
   *
   * Carried rather than left to be inferred, because `false` has four different remedies —
   * `not-granted` is a decision somebody made, `locked` is a password the reader may already have,
   * `rate-limited` is a wait, and `undetermined` is a broken document — and a panel that showed one
   * sentence for all four is the dead end this whole surface exists to remove. It is the same enum
   * `GrantsView` reports and the same one a 403's `grant_*` code spells, so the fleet panel cannot word
   * a refusal differently from the grants panel beside it.
   */
  applyRefusal: GrantRefusalSchema,
  /** What applying will additionally ask for, so a panel can say so before somebody clicks. */
  confirmation: FleetChangeConfirmationSchema,
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

const MAX_ASSET_REF_LENGTH = 200;
const MAX_ASSET_REF_DEPTH = 8;
/**
 * Exactly the two spellings the fleet expands to the user's home directory. Matching them and
 * nothing else is deliberate: `~kirin/notes` and `$EDITOR/x` are expanded by nobody, so they stay
 * inside the asset tree and refusing them would be a rule about a danger that is not there.
 */
const HOME_ALIASES: readonly string[] = ['~', '$HOME'];

/**
 * Why this string cannot name a fleet asset, or `undefined` when it can.
 *
 * **One grammar, two boundaries.** A caller names assets in two places — the text files a change
 * carries, and the `memory` / `skills` / `hooks` / `hooksDir` / `mcp` / `settings` fields of an
 * overlay that say which of them an account uses. Both end up as a source the host reads and copies,
 * so both are held to the same rule and the rule is written once. Two descriptions of what a remote
 * caller may name is how one of them quietly becomes the laxer one.
 *
 * Absolute paths, home aliases, traversal segments and Windows separators are refused rather than
 * normalised away: a caller that asked for `../../.ssh/authorized_keys` has said what it wants, and
 * quietly rewriting that into something harmless teaches nobody anything and hides a probe.
 *
 * **This is a rule about untrusted callers, not about the file format.** An operator hand-editing
 * `config.yaml` may legitimately write `~/notes.md` or an absolute path, and the configuration
 * schema still accepts both. What a paired browser may compose is a much smaller thing.
 *
 * The reason is returned rather than thrown so the two boundaries can each phrase their own
 * refusal — a schema issue on the wire, a refusal with the offending path on the daemon — without
 * either restating the grammar.
 */
export function fleetAssetRefProblem(candidate: string): string | undefined {
  if (candidate.length === 0) return 'is empty';
  if (candidate.length > MAX_ASSET_REF_LENGTH) return `is longer than ${MAX_ASSET_REF_LENGTH} characters`;
  if (candidate.includes('\\')) return 'must use "/" separators';
  if (candidate.startsWith('/')) return 'must be relative to the asset directory';
  if (/^[A-Za-z]:/u.test(candidate)) return 'must be relative to the asset directory';
  // Every control character, tab and newline included. A file's *contents* legitimately contain
  // those three; a path never does, and one that did would print as something other than what it
  // opens.
  if (/[\p{Cc}\p{Cf}]/u.test(candidate)) return 'contains control characters';

  const segments = candidate.split('/');
  if (HOME_ALIASES.includes(segments[0] ?? '')) return 'must be relative to the asset directory, not to a home';
  if (segments.length > MAX_ASSET_REF_DEPTH) return `is deeper than ${MAX_ASSET_REF_DEPTH} directories`;
  for (const segment of segments) {
    if (segment === '') return 'contains an empty path segment';
    if (segment === '.' || segment === '..') return 'contains a path traversal segment';
    if (segment.trim() !== segment) return 'has a segment starting or ending with whitespace';
  }
  return undefined;
}

/** The one sentence both boundaries refuse with, or `undefined` when the reference is well-formed. */
const assetRefRefusal = (candidate: string): string | undefined => {
  const problem = fleetAssetRefProblem(candidate);
  return problem === undefined ? undefined : `asset path "${candidate}" ${problem}`;
};

/** One reference into the fleet's asset tree, held to the grammar above at the wire boundary. */
const FleetAssetRefSchema = z.string().check(context => {
  const refusal = assetRefRefusal(context.value);
  if (refusal === undefined) return;
  context.issues.push({ code: 'custom', message: refusal, input: context.value });
});

/**
 * A per-item skills selection: one reference, or the list of them.
 *
 * Written as one schema rather than a union of the two shapes because a failed `z.union` reports
 * "Invalid input" and drops the branch's own issue — so a caller who sent a path outside the asset tree
 * would be told the shape was wrong instead of being told which path was refused and why. The shape
 * check is structural and the grammar is applied to every entry afterwards, which keeps each refusal
 * naming the reference that earned it, and gives a list entry the index in its path.
 */
const FleetSkillsSelectionSchema = z.union([z.string(), z.array(z.string()).readonly()]).check(context => {
  const value = context.value;
  const references = typeof value === 'string' ? [value] : value;
  references.forEach((reference, index) => {
    const refusal = assetRefRefusal(reference);
    if (refusal === undefined) return;
    context.issues.push({
      code: 'custom',
      message: refusal,
      input: reference,
      path: typeof value === 'string' ? [] : [index],
    });
  });
});

/** A text file a change will write into the asset tree, relative to it and always `/`-separated. */
export const FleetAssetEditSchema = z.strictObject({ path: FleetAssetRefSchema, content: z.string() });
export type FleetAssetEdit = z.infer<typeof FleetAssetEditSchema>;

const NonEmpty = z.string().min(1);
const AccountModeSchema = z.enum(['interactive', 'auto']);

/**
 * One lane a create-account produces: a composition slot, and the mode the account in it publishes.
 *
 * The PAIR is the unit, and that is the whole reason this is a shape rather than two parallel lists.
 * A **variant** is a named composition slot the fleet declares; a **mode** is the closed enum
 * consumers read to decide whether an account may be driven unattended. They are usually the same
 * word and are not the same fact — a fleet may legitimately declare a `review` lane whose accounts
 * run interactively — so a caller that sent `variants: [...]` beside `modes: [...]` would be sending
 * two lists somebody has to zip, and the zip is where they stop lining up.
 *
 * Both fields stay optional per lane, exactly as the single spelling had them: an absent `variant` is
 * the default lane, and an absent `mode` leaves the variant's own default to decide. Not exported —
 * a caller composes one through {@link FleetMutationSchema}, and a second exported name for it would
 * be a second place to keep in step.
 */
const FleetAccountLaneSchema = z.strictObject({
  variant: NonEmpty.optional(),
  mode: AccountModeSchema.optional(),
});

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

/**
 * A settings layer is either a document written inline or a reference to one in the asset tree, and
 * the string case is the reference — so it is held to the asset grammar, exactly like `memory`.
 *
 * The grammar is checked on the whole field rather than inside the branches on purpose. A union
 * whose branches all fail reports that nothing matched, and "invalid input" is a useless thing to
 * tell somebody who wrote one path wrong: the branches stay structural, and the check that runs
 * once the shape is known says which reference is wrong and why.
 */
const SettingsLayerValueSchema = z.union([NonEmpty, z.record(z.string(), JsonValueSchema)]);
const SettingsFieldSchema = z
  .union([SettingsLayerValueSchema, z.array(SettingsLayerValueSchema).readonly()])
  .check(context => {
    const layers: readonly unknown[] = Array.isArray(context.value) ? context.value : [context.value];
    for (const layer of layers) {
      if (typeof layer !== 'string') continue;
      const refusal = assetRefRefusal(layer);
      if (refusal !== undefined) context.issues.push({ code: 'custom', message: refusal, input: layer });
    }
  });

/**
 * The fields an overlay may carry, spelled out. Arbitrary keys are refused, not carried along.
 *
 * Every field here that names a file names one **inside the fleet's own asset tree**. That is the
 * difference between an overlay a person composed in a browser and one an operator typed on the
 * host: applying copies each named source into an account home, so a field that accepted any
 * pathname would let a caller with a paired credential choose which of the host's files the next
 * approved change copies — and the one-line summary the host approves would not mention it.
 * `flags` and `env` are values rather than references, so they are unaffected.
 */
const layerFields = {
  env: z.record(z.string(), z.string()),
  flags: z.array(NonEmpty).readonly(),
  settings: SettingsFieldSchema,
  memory: FleetAssetRefSchema,
  /**
   * A per-item selection: the store items this layer takes, each one materialized under its own name.
   *
   * A list rather than one directory, because the shared pool is a store of individually-addressable
   * items and an account takes the subset it needs. A bare reference is accepted as the selection of
   * one, so a caller that only ever picks a single item does not have to know the field is a list.
   */
  skills: FleetSkillsSelectionSchema,
  hooks: FleetAssetRefSchema,
  hooksDir: FleetAssetRefSchema,
  mcp: FleetAssetRefSchema,
} as const;

/**
 * The asset fields a shared document may supply, and the subset a link may move.
 *
 * Restated here rather than imported, for the reason every shape in this file is: the browser does not
 * depend on the fleet package. `settings` is shareable but not linkable — it is a stack that is
 * deep-merged left to right, so "use the shared one" would have to choose a position in that stack,
 * and a shared layer in the wrong position is silently overridden or silently overriding. It is
 * reported so a person can see which layers are shared documents, and changed through the ordinary
 * overlay edit where the order is written down.
 */
export const FLEET_SHAREABLE_FIELDS = ['settings', 'memory', 'skills', 'hooks', 'hooksDir', 'mcp'] as const;
export const FLEET_LINKABLE_FIELDS = ['memory', 'skills', 'hooks', 'hooksDir', 'mcp'] as const;

export const FleetShareableFieldSchema = z.enum(FLEET_SHAREABLE_FIELDS);
export const FleetLinkableFieldSchema = z.enum(FLEET_LINKABLE_FIELDS);
export type FleetLinkableField = z.infer<typeof FleetLinkableFieldSchema>;

/**
 * Which composition slot supplied a value.
 *
 * Carried because "shared or account-local" is a question about *where the value came from*, and a
 * client that had to answer it would be re-implementing the fleet's precedence order in a package
 * that cannot see the configuration. Every slot but `account` is shared by construction: a profile
 * reaches every agent that lists it, and an agent's own fields reach all of its lanes.
 */
export const FleetCompositionOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('base-profile'), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal('agent-profile'), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal('variant-profile'), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal('variant'), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal('agent'), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal('account') }),
]);
export type FleetCompositionOrigin = z.infer<typeof FleetCompositionOriginSchema>;

/**
 * How an asset field's value actually reaches an account's home.
 *
 * The distinction a surface must render, because two of the three overwrite the destination on every
 * apply and one of them does not:
 *
 * - `link` — the destination IS the shared document. One inode, so an edit to the document is already
 *   this account's, with no apply in between.
 * - `copy` — the destination holds the document's bytes as of the last apply. Only for a source the
 *   fleet may not link to, which is a source outside its own asset tree.
 * - `generated` — the destination is composed from a stack of layers merged in memory and written as one
 *   file. Editing it loses the edit on the next apply; edit a layer instead.
 */
export const FleetAssetMaterializationSchema = z.enum(['link', 'copy', 'generated']);
export type FleetAssetMaterialization = z.infer<typeof FleetAssetMaterializationSchema>;

/**
 * One item of a per-item selection. `sharedName` is absent when the item is not a declared one.
 *
 * Not exported: a client reads an item through the `selection` arm of {@link FleetAssetSharingSchema},
 * which is where the shape is meaningful, and a second exported name for it would be a second place to
 * keep in step.
 */
const FleetSelectedItemSchema = z.strictObject({
  /** The name this item takes inside the account's destination directory. */
  name: z.string().min(1),
  path: z.string().min(1),
  sharedName: z.string().min(1).optional(),
  referrers: z.number().int().positive(),
  materialization: FleetAssetMaterializationSchema.optional(),
});

/**
 * What one account's asset field is: nothing, a declared shared document, its own path, or — for a
 * field that holds ITEMS rather than one document — the selection it made.
 *
 * `referrers` is positive by construction in every arm that carries one — an account resolving a path
 * is itself a referrer, so a zero would mean the count and the value disagree. `local` with more than
 * one referrer is a path a fleet already shares without having declared it, which is a state a surface
 * should offer to fix rather than one it should hide.
 *
 * `materialization` is how the value reaches the home, and it is absent for exactly the fields missing
 * from `linkable` — a harness with no destination for a field materializes nothing there, so naming a
 * mechanism would describe a write that never happens.
 *
 * `skills` is the only field that reports `selection`, and it reports nothing else: asking "shared or
 * its own copy" about a selection has no answer, because each item answers it separately and the whole
 * point of per-item selection is that two accounts can overlap on some items and not others. A client
 * that renders `selection` for one field and the other three states for the rest is reading this
 * correctly.
 */
export const FleetAssetSharingSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent') }),
  z.strictObject({
    state: z.literal('shared'),
    name: z.string().min(1),
    path: z.string().min(1),
    origin: FleetCompositionOriginSchema,
    referrers: z.number().int().positive(),
    materialization: FleetAssetMaterializationSchema.optional(),
  }),
  z.strictObject({
    state: z.literal('local'),
    path: z.string().min(1),
    origin: FleetCompositionOriginSchema,
    referrers: z.number().int().positive(),
    materialization: FleetAssetMaterializationSchema.optional(),
  }),
  z.strictObject({
    state: z.literal('selection'),
    /** The one slot that supplied the whole list; a later slot replaces it rather than adding to it. */
    origin: FleetCompositionOriginSchema,
    /** In declaration order. Empty is a declared selection of nothing, which is not the same as absent. */
    items: z.array(FleetSelectedItemSchema).readonly(),
  }),
]);
export type FleetAssetSharing = z.infer<typeof FleetAssetSharingSchema>;

/** One declared shared document and every account using it, by id. */
export const FleetSharedDocumentSchema = z.strictObject({
  field: FleetShareableFieldSchema,
  name: z.string().min(1),
  path: z.string().min(1),
  accounts: z.array(z.uuid()).readonly(),
});
export type FleetSharedDocument = z.infer<typeof FleetSharedDocumentSchema>;

/** One layer of an account's settings stack, in merge order. Reported, never linked. */
export const FleetSettingsLayerSharingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    position: z.number().int().nonnegative(),
    kind: z.literal('inline'),
    origin: FleetCompositionOriginSchema,
  }),
  z.strictObject({
    position: z.number().int().nonnegative(),
    kind: z.literal('document'),
    path: z.string().min(1),
    /** Absent when this layer is not one of the declared shared documents. */
    name: z.string().min(1).optional(),
    origin: FleetCompositionOriginSchema,
    referrers: z.number().int().positive(),
  }),
]);
export type FleetSettingsLayerSharing = z.infer<typeof FleetSettingsLayerSharingSchema>;

export const FleetAccountSharingSchema = z.strictObject({
  accountId: z.uuid(),
  kind: z.enum(['claude', 'codex']),
  wrapper: z.string().min(1),
  displayName: z.string().min(1),
  /** Every linkable field, always present, so a client never has to read absence as a state. */
  fields: z.strictObject({
    memory: FleetAssetSharingSchema,
    skills: FleetAssetSharingSchema,
    hooks: FleetAssetSharingSchema,
    hooksDir: FleetAssetSharingSchema,
    mcp: FleetAssetSharingSchema,
  }),
  settings: z.array(FleetSettingsLayerSharingSchema).readonly(),
  /**
   * The fields this account can actually be linked or unlinked. A field its harness has no
   * destination for is excluded here, so a surface never offers a control whose apply would refuse.
   */
  linkable: z.array(FleetLinkableFieldSchema).readonly(),
});
export type FleetAccountSharing = z.infer<typeof FleetAccountSharingSchema>;

/**
 * The whole sharing picture, derived from the configuration rather than from disk.
 *
 * Which is the useful direction: it describes what the next apply will materialize, so the report a
 * person reads and the plan they approve come from one document.
 */
export const FleetSharingSchema = z.strictObject({
  documents: z.array(FleetSharedDocumentSchema).readonly(),
  accounts: z.array(FleetAccountSharingSchema).readonly(),
});
export type FleetSharing = z.infer<typeof FleetSharingSchema>;

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
    /**
     * The lanes this one change creates, one account each, on ONE provider account.
     *
     * A SET rather than the single `variant`/`mode` pair this replaces, because "add this account,
     * interactive and unattended" is one decision a person made once. Two proposals would mean two
     * reviews and — for a caller this host's grants govern — two operator-password confirmations for
     * that one decision. There is no second spelling: a create names its lanes here or it names none,
     * and a transient wire request is exactly the thing that can be replaced rather than widened,
     * because a held proposal stores the resulting PLAN and never the mutation.
     *
     * Non-empty, since a create that produced no account is a request with no effect. Two lanes that
     * resolve to the same variant are refused by the daemon rather than here: the default a bare lane
     * takes is the daemon's to know, so this schema cannot see the collision that would follow.
     */
    lanes: z.array(FleetAccountLaneSchema).min(1).readonly(),
    displayName: NonEmpty.optional(),
    models: z.array(NonEmpty).readonly(),
    defaultModel: NonEmpty.optional(),
    available: z.boolean().optional(),
    unavailableReason: NonEmpty.optional(),
    layer: AccountLayerSchema.optional(),
  }),
  /**
   * Point one account's asset field at a declared shared document, by name.
   *
   * The name rather than the path: a caller that could send a path would be choosing which of the
   * host's files the next approved change copies into a home, and the one-line summary the host
   * approves would not mention it. The daemon resolves the name through `config.shared`, so the only
   * documents a remote caller can link are the ones the fleet declared.
   */
  z.strictObject({
    kind: z.literal('link-shared-asset'),
    accountId: z.uuid(),
    field: FleetLinkableFieldSchema,
    name: NonEmpty,
  }),
  /**
   * Give one account its own copy of the shared document it currently uses.
   *
   * It carries no content and no destination. Both are derived on the host — the text from the shared
   * document as it is now, the destination from the account's own wrapper name — because an unlink
   * that let a caller supply either would be an arbitrary file write wearing a named intent's summary.
   */
  z.strictObject({
    kind: z.literal('unlink-shared-asset'),
    accountId: z.uuid(),
    field: FleetLinkableFieldSchema,
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
   * The per-change confirmation, present only when {@link FleetPermissionsSchema}'s `confirmation`
   * said it would be asked for.
   *
   * IT IS THE OPERATOR PASSWORD AND NOTHING ELSE — the same value the unlock is made of, held to the
   * same rule by the same schema, so this cannot become a second, laxer description of one secret. It
   * travels in a BODY: a query parameter reaches every proxy's access log, and this one is worth more
   * than the five minutes an unlock is.
   */
  operatorPassword: OperatorPasswordSchema.optional(),
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
