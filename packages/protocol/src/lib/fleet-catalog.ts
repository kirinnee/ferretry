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
 * it back; `POST /v1/fleet/proposals/:id/apply` applies exactly what was previewed; a caller off this
 * machine confirms it with the passkey step-up. A caller never sends a configuration document: it names one
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
import { AutoResumeSummarySchema } from './auto-resume.ts';
import { BrowserModeSchema } from './browser.ts';
import { InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema } from './common.ts';
import {
  FleetApplyOutcomeSchema,
  FleetDocumentSummarySchema,
  FleetProposalIdSchema,
  FleetWriteOperationSchema,
} from './fleet-changes.ts';
import {
  FleetCredentialStatusWordSchema,
  FleetCredentialStoreSchema,
  FleetCredentialViewSchema,
} from './fleet-credentials.ts';
import { GrantRefusalSchema } from './grants.ts';
import { LocalModelsSchema } from './models.ts';

const HarnessKindSchema = z.enum(['claude', 'codex']);

/**
 * Which harnesses a component or a profile can be used with (§3.4 P7): both, or one. DERIVED by the
 * daemon — a component from its harness or its model ids, a profile from the union of its layers —
 * and never sent by a caller.
 */
export const FleetHarnessScopeSchema = z.enum(['generic', 'claude', 'codex']);
export type FleetHarnessScope = z.infer<typeof FleetHarnessScopeSchema>;

/**
 * A profile's derived scope. `mixed` is a profile written before P7 that layers Claude-only and
 * Codex-only parts together: it still reads and launches, but no change may create or keep one, and
 * `sentence` names the layers that disagree.
 */
export const FleetProfileScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scoped'), scope: FleetHarnessScopeSchema }),
  z.strictObject({ kind: z.literal('mixed'), sentence: NonEmptyStringSchema }),
]);
export type FleetProfileScope = z.infer<typeof FleetProfileScopeSchema>;

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
 * inspecting and proposing are implied). A governed caller confirms an apply with the same passkey
 * step-up `fleet.configure` already demands, so there is nothing further to announce.
 */
export const FleetMachineAuthoritySchema = z.strictObject({
  /** `fleet.configure` for this caller, as the operator's grants decided it. */
  mayApply: z.boolean(),
  /**
   * WHY `mayApply` reads the way it does, in the SHARED grant vocabulary. Carried rather than left
   * to be inferred, because `false` has three different remedies — `not-granted` is a decision
   * somebody made, `step-up-required` is a passkey touch on this device, and `undetermined` is a
   * broken document.
   */
  applyRefusal: GrantRefusalSchema,
});
export type FleetMachineAuthority = z.infer<typeof FleetMachineAuthoritySchema>;

/**
 * "What agents may control" (T, session-spec.html Settings): terminals, browsers and files, each on/off,
 * and Ferretry settings — whether an agent may edit this machine's configuration files with the
 * `config.*` tools (docs/config-files.md), off unless the owner turns it on.
 */
export const FleetAgentControlSchema = z.strictObject({
  terminals: z.boolean(),
  browsers: z.boolean(),
  files: z.boolean(),
  ferretrySettings: z.boolean(),
});
export type FleetAgentControl = z.infer<typeof FleetAgentControlSchema>;

export const FleetMachineViewSchema = z.strictObject({
  name: NonEmptyStringSchema,
  format: FleetCatalogFormatSchema,
  /** At least one runtime exists. A machine that is not set up opens the first run (M3). */
  setUp: z.boolean(),
  agentPermissions: z.enum(['auto', 'skip']),
  /**
   * "Default runtime for new agents" (T), RESOLVED: the machine's own setting, or the
   * `claude-default` fallback when that is an agent runtime here, or `null` when neither resolves —
   * there is nothing yet to pick, and a start with no runtime named would be refused too.
   */
  defaultRuntime: NonEmptyStringSchema.nullable(),
  agentControl: FleetAgentControlSchema,
  /**
   * "Browser mode": how this machine runs its agent browser — `headless`, or a real `window` an owner
   * browses through themselves (docs/browser-mode.md). Optional only so a newer app can read an older
   * daemon, which has no such setting and runs headless.
   */
  browserMode: BrowserModeSchema.optional(),
  /**
   * "Auto-resume after restart": when the daemon boots and finds ferrets that were running when the host
   * went down, it resumes them with their conversation intact. Optional only so a newer app can read an
   * older daemon, which has no such setting (and does not do it).
   */
  autoResume: z.boolean().optional(),
  /** What the last auto-resume pass did, or `null` when none has run. Left out by an older daemon. */
  lastAutoResume: AutoResumeSummarySchema.nullable().optional(),
  tools: z.array(FleetMachineToolSchema).readonly(),
  runtimeCount: NonNegativeIntegerSchema,
  runningSessions: NonNegativeIntegerSchema,
  /** What this caller may do here, step-up included. */
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
    /** `oauth`: the server is signed in to from Ferretry (docs/mcp-oauth.md). */
    auth: z.literal('oauth').optional(),
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
  /** Generic, or the one harness it can be used with — for a model set, derived from its model ids. */
  scope: FleetHarnessScopeSchema,
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
  /** Set by Clone: the machine it was copied from, by the name that machine gave itself. */
  clonedFrom: NonEmptyStringSchema.optional(),
  /** That machine's daemon id as the copying browser reported it, so a surface can name it by its own label. */
  clonedFromDaemon: NonEmptyStringSchema.optional(),
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
  /** Generic, Claude only or Codex only, derived from its layers (P7). */
  scope: FleetProfileScopeSchema,
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

/**
 * Which part of the merge a resolved value is in (§3.4): an MCP server or a skill by its name, a
 * settings key, an environment variable, a launch flag, an instructions or hooks component, the model.
 */
export const FleetResolvedFieldSchema = z.enum([
  'instructions',
  'mcp',
  'skills',
  'settings',
  'env',
  'flags',
  'hooks',
  'model',
]);
export type FleetResolvedField = z.infer<typeof FleetResolvedFieldSchema>;

/**
 * One value as a content item set it. `from` is the profile's OWN content item that brought it in —
 * the component itself, or the `profile/<name>` it arrived through — so a list can mark that item.
 * `hidden` says a secret-looking value was replaced by `‹hidden›` before it left the daemon.
 */
export const FleetResolvedSetterSchema = z.strictObject({
  value: z.string(),
  hidden: z.literal(true).optional(),
  from: NonEmptyStringSchema,
});
export type FleetResolvedSetter = z.infer<typeof FleetResolvedSetterSchema>;

/**
 * One FINAL value of a profile for one harness (R5 "Resolved"): what the runtime gets for `key`, the
 * item it came from, and every earlier value it overrode, oldest first.
 */
export const FleetResolvedEntrySchema = z.strictObject({
  harness: HarnessKindSchema,
  field: FleetResolvedFieldSchema,
  key: NonEmptyStringSchema,
  value: z.string(),
  hidden: z.literal(true).optional(),
  from: NonEmptyStringSchema,
  overridden: z.array(FleetResolvedSetterSchema).readonly(),
});
export type FleetResolvedEntry = z.infer<typeof FleetResolvedEntrySchema>;

/** The draft resolved per harness exactly as a saved profile is, or why it cannot be. */
export const FleetProfileDraftViewSchema = z.strictObject({
  /** Claude Code, then Codex. */
  harnesses: z.array(FleetStackViewSchema).readonly(),
  /**
   * Every final value per harness, Claude Code then Codex, in merge order (R5). Absent from a daemon
   * older than the Resolved view; empty for a draft that cannot be resolved.
   */
  resolved: z.array(FleetResolvedEntrySchema).readonly().optional(),
  /** What the draft's layers make it (P7). A mixed draft also carries the same sentence as `refusal`. */
  scope: FleetProfileScopeSchema,
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

/** One model a runtime offers, as its login's model catalog describes it (docs/model-catalog.md). */
export const FleetRuntimeModelChoiceSchema = z.strictObject({
  /** The value the CLI is handed: `--model`, `/model`. */
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  tier: z.enum(['best', 'balanced', 'fast']).optional(),
  /** The context window, in tokens. */
  context: z.number().int().positive().optional(),
  /** Whether it reasons at all; `efforts` lists the levels it takes, empty when it cannot be adjusted. */
  reasoning: z.boolean().optional(),
  efforts: z.array(NonEmptyStringSchema).readonly(),
  defaultEffort: NonEmptyStringSchema.optional(),
  /** Whether the CLI offers fast mode on it, when that is known without asking the CLI (Claude's is a rule on the id). */
  fast: z.boolean().optional(),
  note: NonEmptyStringSchema.optional(),
  available: z.boolean(),
  /** Installed on this machine, as the local server reported it (Ollama), rather than listed by the catalog. */
  local: z.boolean().optional(),
});
export type FleetRuntimeModelChoice = z.infer<typeof FleetRuntimeModelChoiceSchema>;

/**
 * What a runtime offers when its login reads a model catalog: exactly that catalog's models for the
 * runtime's CLI, and the one it launches with. Absent for a login with no catalog, whose runtimes offer
 * their profile's model set (`modelSet`).
 */
export const FleetRuntimeModelsSchema = z.strictObject({
  catalog: z.strictObject({
    id: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    /** Which copy is in effect: this machine's own file, the published catalog, or this build's. */
    origin: z.enum(['file', 'published', 'built-in']),
    /** Whether the provider takes ids beyond these, so a picker offers "Custom id…". */
    customIds: z.boolean(),
    docs: NonEmptyStringSchema,
    /** Where a picker may also read the models a local server reports. */
    detect: z.enum(['ollama']).optional(),
  }),
  choices: z.array(FleetRuntimeModelChoiceSchema).readonly(),
  default: NonEmptyStringSchema.optional(),
  /** What the last read of the local server found, for a catalog that detects one (`catalog.detect`). */
  local: LocalModelsSchema.optional(),
});
export type FleetRuntimeModels = z.infer<typeof FleetRuntimeModelsSchema>;

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
  /** What the runtime offers from its login's model catalog, when the login reads one. Wins over `modelSet`. */
  models: FleetRuntimeModelsSchema.optional(),
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
    /** `oauth` on a `url` server: signed in to from Ferretry (docs/mcp-oauth.md). */
    auth: z.literal('oauth').optional(),
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
    /**
     * Which CLI it runs, for a login that drives both (docs/provider-presets.md). Absent: the one its
     * profile is scoped to, else the login's own.
     */
    harness: HarnessKindSchema.optional(),
    agent: z.boolean(),
    create: z.boolean(),
    /** E15: the person saw "already uses this login and profile" and chose to add another anyway. */
    addAnother: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('runtime.remove'), name: NonEmptyStringSchema }),
  /**
   * Give a runtime a new name. Its id stays, so its sessions, history and config directory stay with
   * it, and the old name keeps resolving as a former name (docs/account-model.md "Renaming a runtime").
   */
  z.strictObject({ kind: z.literal('runtime.rename'), name: NonEmptyStringSchema, to: TypedNameSchema }),
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
    /**
     * The CLI. For a preset with a `claude:` and a `codex:` half, the one listed first: the login gets
     * every half the preset offers, so it drives both with one secret, and `env` holds the variables
     * of every half (docs/provider-presets.md).
     */
    harness: HarnessKindSchema,
    label: NonEmptyStringSchema.optional(),
    /**
     * Where the login lives. Absent (or `ferretry`) is an empty slot Ferretry keeps on this machine;
     * `host` is the person's OWN login, shared in place with `claude` or `codex` in their terminal — what
     * the first run's "Sign in now" makes before it signs in, so the import that follows reuses it.
     */
    store: z.enum(['ferretry', 'host', 'environment']).optional(),
    /**
     * `store: environment` only: the preset it is made from (docs/provider-presets.md). The daemon fills
     * in what the preset decides — the Codex model provider — and checks `env` against it.
     */
    preset: NonEmptyStringSchema.max(64).optional(),
    /**
     * `store: environment` only: every variable, as a plain value or a `${secret:NAME}` reference. A value
     * that looks like a raw key is refused: a secret goes in through `POST /v1/secrets`.
     */
    env: z.record(z.string().max(128), z.string().max(4096)).optional(),
    /** `store: environment` only: `aws-profile:<name>`, `gcloud-adc[:<path>]` or `azure-cli`, kept as a reference. */
    cloudCredential: NonEmptyStringSchema.max(512).optional(),
  }),
  z.strictObject({
    /**
     * Change an environment login's variables. A secret variable the catalogue reported as hidden is
     * kept with `{ keep: true }`. `cloudCredential: null` removes the reference.
     */
    kind: z.literal('credential.env'),
    id: NonEmptyStringSchema,
    env: FleetEnvInputSchema,
    cloudCredential: NonEmptyStringSchema.max(512).nullable().optional(),
  }),
  z.strictObject({
    kind: z.literal('credential.label'),
    id: NonEmptyStringSchema,
    label: NonEmptyStringSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('credential.remove'), id: NonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('credential.signout'), id: NonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('machine.settings'),
    agentPermissions: z.enum(['auto', 'skip']),
    /**
     * A caller always sends all three machine settings together — never only the one it means to
     * change — so one `machine.settings` change can never clobber a field it was not shown. `null`
     * unsets the explicit "Default runtime" override and falls back to the machine's own resolution.
     */
    defaultRuntime: NonEmptyStringSchema.nullable(),
    /** `ferretrySettings` may be left out by a client that predates it, and is then left as it is. */
    agentControl: FleetAgentControlSchema.extend({ ferretrySettings: z.boolean().optional() }),
    /** Left out by a client that predates it, and then left as it is. */
    browserMode: BrowserModeSchema.optional(),
    /** Left out by a client that predates it, and then left as it is. */
    autoResume: z.boolean().optional(),
  }),
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
    /**
     * Components the person chose NOT to copy (`mcp/notes`, `hooks/guard`), from the review that lists
     * everything a copy would run (`cloneRunnables`). Each is left out, and so is every layer naming it.
     */
    skip: z.array(NonEmptyStringSchema).max(512).optional(),
    /**
     * The source as THIS browser knows it: the daemon id it paired with, as the browser reports it
     * (the target cannot check it). The bundle's own `machine` is only the name the source gave itself.
     */
    source: z.strictObject({ daemonId: NonEmptyStringSchema }).optional(),
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

/** A session still running on a runtime a change removes or renames, as the confirm card lists it. */
export const FleetRunningSessionSchema = z.strictObject({
  id: NonEmptyStringSchema,
  /** What the person calls it: its teammate name, else its own name, else its id. */
  name: NonEmptyStringSchema,
  harness: HarnessKindSchema,
});
export type FleetRunningSession = z.infer<typeof FleetRunningSessionSchema>;

/** What applying the change would do, for the person approving it. */
export const FleetAccountChangePreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('apply'),
    operations: z.array(FleetWriteOperationSchema).readonly(),
    documents: z.array(FleetDocumentSummarySchema).readonly(),
    runtimes: z.array(FleetChangedRuntimeSchema).readonly(),
    /**
     * The sessions still running on the runtime a `runtime.remove` or `runtime.rename` names, so the
     * confirm card can list them and offer to move them first. Present only when there are some.
     */
    runningSessions: z.array(FleetRunningSessionSchema).readonly().optional(),
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
