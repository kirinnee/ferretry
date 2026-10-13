/**
 * The wire contract for the account model's catalogue and its reviewed changes
 * (docs/design/account-model.md §4, §7): what a machine has — its tools, its components, its profiles
 * with their layer stacks, its runtimes — and every change a person can make to it, staged as a
 * preview and applied in a second, explicit step.
 *
 * ## Reads
 *
 * - `GET /v1/fleet/machine` — Agent permissions, the harness tools, whether it is set up, and what
 *   THIS caller may do to it (its authority).
 * - `GET /v1/fleet/components` — the six kinds, each component with its badges and "used by".
 * - `GET /v1/fleet/profiles` — every profile with its layers, its flattened stack per harness and
 *   its conflicts.
 * - `POST /v1/fleet/profiles/preview` — a profile's layers before they are saved, resolved the
 *   same way. It is a read with a body: it writes nothing.
 * - `GET /v1/fleet/runtimes` — each runtime with its resolved stack, model set, fixed layer and whether
 *   it can launch.
 *
 * ## Changes
 *
 * `POST /v1/fleet/proposals` stages ONE change and writes nothing; `GET /v1/fleet/proposals/:id` reads
 * it back; `POST /v1/fleet/proposals/:id/apply` applies exactly what was previewed, with the operator
 * password for a caller off this machine. A caller never sends a configuration document: it names one
 * intent, and the daemon derives the next configuration from the current one.
 *
 * ## No credential travels
 *
 * Nothing here can carry a login. A component's environment shows a value only when it is a
 * `${secret:NAME}` reference or its name does not look like a credential; any other value is reported
 * as hidden, and an edit keeps it with `{ keep: true }` rather than by sending it back.
 *
 * Every object is strict, so a field the daemon grew without adding it here fails the response.
 */
import { z } from 'zod';
import { InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema } from './common.ts';
import {
  FleetApplyOutcomeSchema,
  FleetChangeConfirmationSchema,
  FleetDocumentSummarySchema,
  FleetProposalIdSchema,
  FleetWriteOperationSchema,
} from './fleet-changes.ts';
import {
  FleetCredentialStoreSchema,
  FleetCredentialStatusWordSchema,
  FleetCredentialViewSchema,
} from './fleet-credentials.ts';
import { GrantRefusalSchema } from './grants.ts';

const HarnessKindSchema = z.enum(['claude', 'codex']);

/**
 * A runtime's name or a credential's id as a person typed it. The grammar (R1) is checked by the
 * daemon rather than here, because a name it refuses comes back with a suggestion (E16).
 */
const TypedNameSchema = z.string().min(1).max(200);

/** A component's or a profile's name: one path segment. */
export const FleetComponentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(value => !/[/\\]/u.test(value) && !value.includes('..') && value.trim() === value, {
    message: 'a name is one word or phrase with no slash',
  });

/** The six kinds, spelled as the configuration's `components` keys. */
export const FleetComponentKindSchema = z.enum(['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets']);
export type FleetComponentKind = z.infer<typeof FleetComponentKindSchema>;

/** Which configuration this machine has: none yet, or the account model. */
export const FleetCatalogFormatSchema = z.enum(['none', 'version-2']);
export type FleetCatalogFormat = z.infer<typeof FleetCatalogFormatSchema>;

/** Whether an act is offered, and why not when it is not. */
export const FleetCatalogActSchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({ available: z.literal(false), reason: NonEmptyStringSchema }),
]);
export type FleetCatalogAct = z.infer<typeof FleetCatalogActSchema>;

// ── Machine ──────────────────────────────────────────────────────────────────────────────────────

export const FleetMachineToolSchema = z.strictObject({
  harness: HarnessKindSchema,
  /** "Claude Code", "Codex". */
  label: NonEmptyStringSchema,
  installed: z.boolean(),
  /** The absolute command this machine resolves, when it is installed. Nothing was run to find it. */
  command: NonEmptyStringSchema.optional(),
});
export type FleetMachineTool = z.infer<typeof FleetMachineToolSchema>;

/**
 * What THIS caller may do to this machine, read before a surface offers a control it cannot use.
 *
 * IT IS THE CAPABILITY LAYER'S ANSWER, not a second one. `mayApply` is `fleet.configure` as the
 * operator's grants decided it for this request (reading the machine is itself `fleet.use`, so
 * inspecting and proposing are implied), and `confirmation` says whether applying will ask for the
 * operator password once more.
 */
export const FleetMachineAuthoritySchema = z.strictObject({
  /** `fleet.configure` for this caller, as the operator's grants decided it. */
  mayApply: z.boolean(),
  /**
   * WHY `mayApply` reads the way it does, in the SHARED grant vocabulary. Carried rather than left
   * to be inferred, because `false` has four different remedies — `not-granted` is a decision
   * somebody made, `locked` is a password the reader may already have, `rate-limited` is a wait,
   * and `undetermined` is a broken document.
   */
  applyRefusal: GrantRefusalSchema,
  /** What applying will additionally ask for, so a panel can say so before somebody clicks. */
  confirmation: FleetChangeConfirmationSchema,
});
export type FleetMachineAuthority = z.infer<typeof FleetMachineAuthoritySchema>;

export const FleetMachineViewSchema = z.strictObject({
  name: NonEmptyStringSchema,
  format: FleetCatalogFormatSchema,
  /** At least one runtime exists. A machine that is not set up opens the first run (M3). */
  setUp: z.boolean(),
  agentPermissions: z.enum(['auto', 'skip']),
  tools: z.array(FleetMachineToolSchema).readonly(),
  runtimeCount: NonNegativeIntegerSchema,
  runningSessions: NonNegativeIntegerSchema,
  /** What this caller may do here. A caller that unlocked reads its unlocked authority. */
  authority: FleetMachineAuthoritySchema,
});
export type FleetMachineView = z.infer<typeof FleetMachineViewSchema>;

// ── Components ───────────────────────────────────────────────────────────────────────────────────

/** One environment variable: its value when it may travel, or the fact that it is hidden. */
export const FleetEnvEntrySchema = z.union([
  z.strictObject({ name: NonEmptyStringSchema, value: z.string() }),
  z.strictObject({ name: NonEmptyStringSchema, hidden: z.literal(true) }),
]);
export type FleetEnvEntry = z.infer<typeof FleetEnvEntrySchema>;

/** What a component holds, per kind. A file is named relative to the fleet's asset tree. */
export const FleetComponentDetailSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('instructions'), file: NonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('mcp'),
    command: NonEmptyStringSchema.optional(),
    args: z.array(z.string()).readonly().optional(),
    url: NonEmptyStringSchema.optional(),
    env: z.array(FleetEnvEntrySchema).readonly(),
  }),
  z.strictObject({ kind: z.literal('skills'), items: z.array(NonEmptyStringSchema).readonly() }),
  z.strictObject({
    kind: z.literal('settings'),
    file: NonEmptyStringSchema.optional(),
    flags: z.array(NonEmptyStringSchema).readonly().optional(),
    env: z.array(FleetEnvEntrySchema).readonly(),
  }),
  z.strictObject({
    kind: z.literal('hooks'),
    file: NonEmptyStringSchema.optional(),
    directory: NonEmptyStringSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('modelSets'),
    models: z.array(NonEmptyStringSchema).readonly(),
    default: NonEmptyStringSchema,
  }),
]);
export type FleetComponentDetail = z.infer<typeof FleetComponentDetailSchema>;

/** Who uses a component or a profile: profiles by name, and the runtimes behind them. */
export const FleetUsageSchema = z.strictObject({
  profiles: z.array(NonEmptyStringSchema).readonly(),
  runtimes: z.array(NonEmptyStringSchema).readonly(),
});
export type FleetUsage = z.infer<typeof FleetUsageSchema>;

/** A component one harness honours only in part (K5, E22). */
export const FleetPartialSupportSchema = z.strictObject({
  harness: HarnessKindSchema,
  reason: NonEmptyStringSchema,
});

/** One settings key as it may travel: its value in words, or the fact that it is hidden (K4). */
export const FleetSettingsEntrySchema = z.union([
  /** A string is shown as it is; any other value as its JSON text. */
  z.strictObject({ key: NonEmptyStringSchema, value: z.string() }),
  z.strictObject({ key: NonEmptyStringSchema, hidden: z.literal(true) }),
]);
export type FleetSettingsEntry = z.infer<typeof FleetSettingsEntrySchema>;

/** What a component's file says, for the kinds that have one, with every secret-looking value cut out. */
export const FleetComponentContentSchema = z.discriminatedUnion('form', [
  /** Instructions and hooks: the file text. `redacted` says a secret-looking value was replaced by `‹hidden›`. */
  z.strictObject({ form: z.literal('text'), text: z.string(), redacted: z.boolean() }),
  /** Settings: the parsed file flattened to dotted keys, sorted. Objects nest; arrays, scalars and `{}` are leaves. */
  z.strictObject({ form: z.literal('entries'), entries: z.array(FleetSettingsEntrySchema).readonly() }),
]);
export type FleetComponentContent = z.infer<typeof FleetComponentContentSchema>;

export const FleetComponentViewSchema = z.strictObject({
  /** `<kind>/<name>`, as a profile layer names it. */
  reference: NonEmptyStringSchema,
  kind: FleetComponentKindSchema,
  name: NonEmptyStringSchema,
  /** The one harness it belongs to; absent for a generic component. */
  harness: HarnessKindSchema.optional(),
  detail: FleetComponentDetailSchema,
  partial: z.array(FleetPartialSupportSchema).readonly(),
  /** Notes that do not block saving (K6): "Command not found: uvx". */
  warnings: z.array(NonEmptyStringSchema).readonly(),
  usedBy: FleetUsageSchema,
  /** What the edit screen says about where the change lands (E20). */
  editNote: NonEmptyStringSchema,
  /** Whether it can be deleted now (K7, E21). */
  remove: FleetCatalogActSchema,
  /** What its file says: absent for MCP, skills and model sets, or when the file cannot be read or parsed. */
  content: FleetComponentContentSchema.optional(),
  /** E30: a path under somebody else's home that this component names, to check on this machine. */
  checkPath: NonEmptyStringSchema.optional(),
});
export type FleetComponentView = z.infer<typeof FleetComponentViewSchema>;

export const FleetComponentGroupSchema = z.strictObject({
  kind: FleetComponentKindSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  components: z.array(FleetComponentViewSchema).readonly(),
});
export type FleetComponentGroup = z.infer<typeof FleetComponentGroupSchema>;

export const FleetComponentCatalogSchema = z.strictObject({
  format: FleetCatalogFormatSchema,
  kinds: z.array(FleetComponentGroupSchema).readonly(),
});
export type FleetComponentCatalog = z.infer<typeof FleetComponentCatalogSchema>;

// ── Profiles ─────────────────────────────────────────────────────────────────────────────────────

/** One key two layers set to different values (P4, E18). Information, never an error. */
export const FleetLayerConflictSchema = z.strictObject({
  harness: HarnessKindSchema,
  field: z.enum(['settings', 'env', 'model']),
  key: NonEmptyStringSchema,
  /** "`permissions.defaultMode` · Claude Code: acceptEdits (from agent) overrides plan (from default)". */
  sentence: NonEmptyStringSchema,
  winner: NonEmptyStringSchema,
  overridden: z.array(NonEmptyStringSchema).readonly(),
});
export type FleetLayerConflict = z.infer<typeof FleetLayerConflictSchema>;

/** A layer one harness does not use (P5), with the reason in words. */
export const FleetSkippedLayerSchema = z.strictObject({
  reference: NonEmptyStringSchema,
  sentence: NonEmptyStringSchema,
});

/** A profile resolved for one harness: what applies, what is skipped, and what overrides what. */
export const FleetStackViewSchema = z.strictObject({
  harness: HarnessKindSchema,
  available: FleetCatalogActSchema,
  /** The components that apply, oldest first. */
  applied: z.array(NonEmptyStringSchema).readonly(),
  skipped: z.array(FleetSkippedLayerSchema).readonly(),
  conflicts: z.array(FleetLayerConflictSchema).readonly(),
  partial: z.array(z.strictObject({ reference: NonEmptyStringSchema, reason: NonEmptyStringSchema })).readonly(),
});
export type FleetStackView = z.infer<typeof FleetStackViewSchema>;

export const FleetLayeredProfileViewSchema = z.strictObject({
  name: NonEmptyStringSchema,
  /** As written, oldest first: `<kind>/<name>` or `profile/<name>`. */
  layers: z.array(NonEmptyStringSchema).readonly(),
  /** Runtimes that use this profile. */
  usedBy: z.array(NonEmptyStringSchema).readonly(),
  /** Profiles that use this one as a base. */
  baseFor: z.array(NonEmptyStringSchema).readonly(),
  /** Profiles that cannot be a base of this one because they include it (P3, E19). */
  wouldIncludeItself: z.array(NonEmptyStringSchema).readonly(),
  harnesses: z.array(FleetStackViewSchema).readonly(),
  /** Whether it can be deleted now (P6, E21), and which runtimes must pick another profile first. */
  remove: FleetCatalogActSchema,
});
export type FleetLayeredProfileView = z.infer<typeof FleetLayeredProfileViewSchema>;

export const FleetLayeredProfileCatalogSchema = z.strictObject({
  format: FleetCatalogFormatSchema,
  profiles: z.array(FleetLayeredProfileViewSchema).readonly(),
});
export type FleetLayeredProfileCatalog = z.infer<typeof FleetLayeredProfileCatalogSchema>;

/**
 * `POST /v1/fleet/profiles/preview`: a profile's layers as the builder has them, before it is
 * named or saved. Writes nothing.
 */
export const FleetProfileDraftRequestSchema = z.strictObject({
  /** Oldest first, as `profile.put` would send them. */
  layers: z.array(NonEmptyStringSchema).max(200),
  /** The profile being edited, whose own layers these replace. */
  editing: FleetComponentNameSchema.optional(),
});
export type FleetProfileDraftRequest = z.infer<typeof FleetProfileDraftRequestSchema>;

/** The draft resolved per harness exactly as a saved profile is, or why it cannot be. */
export const FleetProfileDraftViewSchema = z.strictObject({
  /** Claude Code, then Codex. */
  harnesses: z.array(FleetStackViewSchema).readonly(),
  /** A layer that does not exist, or one that would include the profile itself. */
  refusal: NonEmptyStringSchema.optional(),
});
export type FleetProfileDraftView = z.infer<typeof FleetProfileDraftViewSchema>;

// ── Runtimes ─────────────────────────────────────────────────────────────────────────────────────

export const FleetRuntimeModelSetSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('harness-default') }),
  z.strictObject({
    source: z.literal('model-set'),
    /** The model set component that won. */
    name: NonEmptyStringSchema,
    models: z.array(z.strictObject({ id: NonEmptyStringSchema, available: z.boolean() })).readonly(),
    declaredDefault: NonEmptyStringSchema,
    /** What the runtime launches with; absent when the login can use none of them. */
    default: NonEmptyStringSchema.optional(),
    /** Set when the default moved because the declared one is not available (E23). */
    note: NonEmptyStringSchema.optional(),
  }),
]);
export type FleetRuntimeModelSet = z.infer<typeof FleetRuntimeModelSetSchema>;

/** The locked layer an agent runtime gets last (F1–F3), and the user values it overrides (E24). */
export const FleetFixedLayerViewSchema = z.strictObject({
  agentPermissions: z.enum(['auto', 'skip']),
  entries: z.array(z.strictObject({ key: NonEmptyStringSchema, value: NonEmptyStringSchema })).readonly(),
  overridden: z
    .array(
      z.strictObject({
        key: NonEmptyStringSchema,
        value: NonEmptyStringSchema,
        from: NonEmptyStringSchema,
        sentence: NonEmptyStringSchema,
      }),
    )
    .readonly(),
});
export type FleetFixedLayerView = z.infer<typeof FleetFixedLayerViewSchema>;

export const FleetRuntimeViewSchema = z.strictObject({
  /** The runtime's stable id: the same id the manifest's account row and a session's account carry. */
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  /** The command name `fy start --agent` takes: the manifest account row's `wrapper`. */
  wrapper: NonEmptyStringSchema,
  harness: HarnessKindSchema,
  credential: z.strictObject({
    id: NonEmptyStringSchema,
    store: FleetCredentialStoreSchema,
    label: NonEmptyStringSchema.optional(),
    status: FleetCredentialStatusWordSchema.optional(),
  }),
  profile: NonEmptyStringSchema,
  agent: z.boolean(),
  stack: FleetStackViewSchema,
  modelSet: FleetRuntimeModelSetSchema,
  /** Agent runtimes only. */
  fixedLayer: FleetFixedLayerViewSchema.optional(),
  /** Whether it can launch now; when not, `reason` is the button's words ("Sign in to launch"). */
  launch: FleetCatalogActSchema,
  /** Other runtimes on the same login and profile (R4). */
  sameAs: z.array(NonEmptyStringSchema).readonly(),
});
export type FleetRuntimeView = z.infer<typeof FleetRuntimeViewSchema>;

export const FleetRuntimeCatalogSchema = z.strictObject({
  format: FleetCatalogFormatSchema,
  runtimes: z.array(FleetRuntimeViewSchema).readonly(),
});
export type FleetRuntimeCatalog = z.infer<typeof FleetRuntimeCatalogSchema>;

// ── Changes ──────────────────────────────────────────────────────────────────────────────────────

/** An environment value as an edit sends it: a new value, or "keep the one it has". */
export const FleetEnvInputSchema = z.record(
  z.string(),
  z.union([z.string(), z.strictObject({ keep: z.literal(true) })]),
);
export type FleetEnvInput = z.infer<typeof FleetEnvInputSchema>;

/**
 * A settings file as an edit sends it, by dotted key: a new value, or "keep the one it has" for a
 * value the catalogue reported as hidden.
 */
export const FleetSettingsEntriesInputSchema = z.record(
  z.string(),
  z.union([z.strictObject({ value: z.json() }), z.strictObject({ keep: z.literal(true) })]),
);
export type FleetSettingsEntriesInput = z.infer<typeof FleetSettingsEntriesInputSchema>;

/**
 * A component's fields as a change sends them. A file's path is never sent: the daemon names it
 * (`components/<kind>/<name>.<ext>`) or keeps the one an existing component has, and `content` is its
 * text.
 */
export const FleetComponentInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('instructions'), harness: HarnessKindSchema.optional() }),
  z.strictObject({
    kind: z.literal('mcp'),
    command: NonEmptyStringSchema.optional(),
    args: z.array(z.string()).optional(),
    url: NonEmptyStringSchema.optional(),
    env: FleetEnvInputSchema.optional(),
    harness: HarnessKindSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('skills'),
    items: z.array(NonEmptyStringSchema).min(1),
    harness: HarnessKindSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('settings'),
    harness: HarnessKindSchema,
    flags: z.array(NonEmptyStringSchema).optional(),
    env: FleetEnvInputSchema.optional(),
    /** The file by entry, instead of `content`: the daemon writes the document. */
    entries: FleetSettingsEntriesInputSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('hooks'), harness: HarnessKindSchema }),
  z.strictObject({
    kind: z.literal('modelSets'),
    models: z.array(NonEmptyStringSchema).min(1),
    default: NonEmptyStringSchema,
  }),
]);
export type FleetComponentInput = z.infer<typeof FleetComponentInputSchema>;

/** The longest component text one change may carry. */
export const MAX_COMPONENT_CONTENT_BYTES = 256 * 1024;

/**
 * One change to this machine's setup. `create: true` means "this name must be new": a clash is
 * refused with a suggestion (E16) rather than silently editing what is there.
 */
export const FleetAccountChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('runtime.put'),
    name: TypedNameSchema,
    credential: NonEmptyStringSchema,
    profile: FleetComponentNameSchema,
    agent: z.boolean(),
    create: z.boolean(),
    /** E15: the person saw "already uses this login and profile" and chose to add another anyway. */
    addAnother: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('runtime.remove'), name: NonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('profile.put'),
    name: FleetComponentNameSchema,
    /** Oldest first. A reorder is this with the same layers in a new order. */
    layers: z.array(NonEmptyStringSchema).min(1),
    create: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('profile.remove'),
    name: NonEmptyStringSchema,
    /** E21 "Switch n runtimes and delete": the profile every runtime on this one moves to. */
    switchRuntimesTo: FleetComponentNameSchema.optional(),
    /** E21 "Remove from those first": take it out of every profile built on it, then delete it. */
    removeFromProfiles: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('component.put'),
    name: FleetComponentNameSchema,
    component: FleetComponentInputSchema,
    /** The component's file text, for the kinds that have one. */
    content: z.string().max(MAX_COMPONENT_CONTENT_BYTES).optional(),
    create: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('component.remove'),
    componentKind: FleetComponentKindSchema,
    name: NonEmptyStringSchema,
    /** E21 "Remove from those first": take it out of every profile that has it, then delete it. */
    removeFromProfiles: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('credential.add'),
    id: TypedNameSchema,
    harness: HarnessKindSchema,
    label: NonEmptyStringSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('credential.label'),
    id: NonEmptyStringSchema,
    label: NonEmptyStringSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('credential.remove'), id: NonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('credential.signout'), id: NonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('machine.settings'), agentPermissions: z.enum(['auto', 'skip']) }),
  z.strictObject({
    kind: z.literal('setup.import'),
    /** The harnesses the person chose to import ("Skip Claude Code"). Default: every installed one. */
    include: z.array(HarnessKindSchema).max(2).optional(),
    /** The runtime name the person gave each imported harness (§4.3 step 4). Default: the suggestion. */
    names: z.strictObject({ claude: TypedNameSchema.optional(), codex: TypedNameSchema.optional() }).optional(),
    /** Components whose source changed since the last import that the person chose to update (O6). */
    acceptedUpdates: z.array(NonEmptyStringSchema).optional(),
    /** Add a runtime even where an identical one exists (E15 during Import again). */
    addDuplicates: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('clone.import'),
    mode: z.enum(['alongside', 'replace']),
    /** The source machine's export, read by the browser and handed over as data. */
    bundle: z.record(z.string(), z.unknown()),
  }),
]);
export type FleetAccountChange = z.infer<typeof FleetAccountChangeSchema>;
export type FleetAccountChangeKind = FleetAccountChange['kind'];

export const FleetAccountChangeRequestSchema = z.strictObject({ change: FleetAccountChangeSchema });
export type FleetAccountChangeRequest = z.infer<typeof FleetAccountChangeRequestSchema>;

/** A runtime as the change would publish it. */
export const FleetChangedRuntimeSchema = z.strictObject({
  name: NonEmptyStringSchema,
  harness: HarnessKindSchema,
  agent: z.boolean(),
  launch: FleetCatalogActSchema,
});

/** What applying the change would do, for the person approving it. */
export const FleetAccountChangePreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('apply'),
    operations: z.array(FleetWriteOperationSchema).readonly(),
    documents: z.array(FleetDocumentSummarySchema).readonly(),
    runtimes: z.array(FleetChangedRuntimeSchema).readonly(),
  }),
  z.strictObject({
    /** Sign-out runs the harness's own logout against the one store; it writes no plan. */
    kind: z.literal('sign-out'),
    credential: NonEmptyStringSchema,
    runtimesAffected: NonNegativeIntegerSchema,
    signsOutTerminal: z.boolean(),
  }),
  z.strictObject({
    /** A first-run import or a clone, carried out by its own executor. */
    kind: z.literal('executor'),
    executor: z.enum(['setup', 'clone']),
    description: NonEmptyStringSchema,
  }),
]);
export type FleetAccountChangePreview = z.infer<typeof FleetAccountChangePreviewSchema>;

export const FleetAccountChangeViewSchema = z.strictObject({
  id: FleetProposalIdSchema,
  revision: NonEmptyStringSchema,
  /** The change as staged; a component's text is reported by size in `documents`, not repeated. */
  change: FleetAccountChangeSchema,
  summary: NonEmptyStringSchema,
  /** The sentences a confirm card shows: who else it changes, what it signs out (E20, E21, E25). */
  consequences: z.array(NonEmptyStringSchema).readonly(),
  expiresAt: InstantSchema,
  state: z.enum(['pending', 'consumed']),
  preview: FleetAccountChangePreviewSchema,
});
export type FleetAccountChangeView = z.infer<typeof FleetAccountChangeViewSchema>;

/** What applying a change did. */
export const FleetAccountChangeOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('applied'), apply: FleetApplyOutcomeSchema }),
  z.strictObject({ outcome: z.literal('signed-out'), credential: FleetCredentialViewSchema }),
  z.strictObject({
    outcome: z.literal('sign-out-failed'),
    reason: NonEmptyStringSchema,
    credential: FleetCredentialViewSchema,
  }),
  z.strictObject({
    outcome: z.literal('executed'),
    executor: z.enum(['setup', 'clone']),
    summary: NonEmptyStringSchema,
  }),
]);
export type FleetAccountChangeOutcome = z.infer<typeof FleetAccountChangeOutcomeSchema>;

/** Every refusal the catalogue and its changes answer with, so a client branches on cause. */
export const FLEET_CATALOG_REFUSAL_CODES = [
  'fleet_catalog_unreadable',
  'fleet_change_refused',
  'fleet_change_unknown',
  'fleet_change_expired',
  'fleet_change_consumed',
  'fleet_change_unauthorized',
  'fleet_change_stale',
  'fleet_change_failed',
] as const;
export const FleetCatalogRefusalCodeSchema = z.enum(FLEET_CATALOG_REFUSAL_CODES);
export type FleetCatalogRefusalCode = z.infer<typeof FleetCatalogRefusalCodeSchema>;
