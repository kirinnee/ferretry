/**
 * The wire contract for the runtimes' catalogue and its reviewed changes (today's `fleet-catalog.ts`, renamed):
 * what a machine has (tools, components, profiles with their layer stacks, runtimes) and every change a person can
 * make, staged as a preview and applied in a second, explicit step.
 *
 * - `GET /v1/runtimes/machine` · `GET /v1/runtimes/components` · `GET /v1/runtimes/profiles` ·
 *   `POST /v1/runtimes/profiles/preview` (a read with a body) · `GET /v1/runtimes` (each runtime, resolved).
 * - `POST /v1/runtimes/proposals` stages ONE change and writes nothing; `GET /v1/runtimes/proposals/:id` reads it back;
 *   `POST /v1/runtimes/proposals/:id/apply` applies exactly what was previewed (a caller off this machine confirms with
 *   the passkey step-up). A caller never sends a configuration document: it names one intent.
 *
 * Nothing here can carry a login: a component's environment shows a value only when it is a `${secret:NAME}` reference
 * or its name does not look like a credential; an edit keeps a hidden value with `{ keep: true }`. A launch flag or an
 * MCP argument that carries a credential travels as `{ shown, hidden: true }` (its flag kept, its value cut), and an
 * edit keeps it with `{ keep: true, at }` against the list's etag.
 * Every object is strict. Shapes owned by other subsystems come from `./shared.ts`.
 */
import { HIDDEN_WORD_TEXT } from '@ferretry/core-vault/contract';
import { z } from 'zod';
import { ApplyOutcomeSchema, DocumentSummarySchema, ProposalIdSchema, WriteOperationSchema } from './changes.ts';
import {
  CLONE_SETTINGS_DOCS,
  CloneDecisionsSchema,
  CloneLoginChoicesSchema,
  CloneSettingsDecisionsSchema,
  CloneSettingsTextSchema,
} from './clone.ts';
import {
  AutoResumeSummarySchema,
  BrowserFirewallFailureSchema,
  BrowserModeSchema,
  BrowserPortsSettingSchema,
  BrowserProxySettingSchema,
  CatalogProvenanceSchema,
  CredentialStatusWordSchema,
  CredentialStoreSchema,
  CredentialViewSchema,
  DisabledSchema,
  GrantRefusalSchema,
  HarnessKeySchema,
  InstantSchema,
  LocalModelsSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
} from './shared.ts';

/**
 * Which harnesses a component or a profile can be used with (§3.4 P7): both, or one. DERIVED by the
 * daemon — a component from its harness or its model ids, a profile from the union of its layers —
 * and never sent by a caller.
 */
export const HarnessScopeSchema = z.enum(['generic', 'claude-code', 'codex']);
export type HarnessScope = z.infer<typeof HarnessScopeSchema>;

/**
 * A profile's derived scope. `mixed` is a profile written before P7 that layers Claude-only and
 * Codex-only parts together: it still reads and launches, but no change may create or keep one, and
 * `sentence` names the layers that disagree.
 */
export const ProfileScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scoped'), scope: HarnessScopeSchema }),
  z.strictObject({ kind: z.literal('mixed'), sentence: NonEmptyStringSchema }),
]);
export type ProfileScope = z.infer<typeof ProfileScopeSchema>;

/**
 * A runtime's name or a credential's id as a person typed it. The grammar (R1) is checked by the
 * daemon rather than here, because a name it refuses comes back with a suggestion (E16).
 */
const TypedNameSchema = z.string().min(1).max(200);

/** A component's or a profile's name: one path segment. */
export const ComponentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(value => !/[/\\]/u.test(value) && !value.includes('..') && value.trim() === value, {
    message: 'a name is one word or phrase with no slash',
  });

/** The six kinds, spelled as the configuration's `components` keys. */
export const ComponentKindSchema = z.enum(['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets']);
export type ComponentKind = z.infer<typeof ComponentKindSchema>;

/** Which configuration this machine has: none yet, or present. */
export const CatalogFormatSchema = z.enum(['none', 'present']);
export type CatalogFormat = z.infer<typeof CatalogFormatSchema>;

/** Whether an act is offered, and why not when it is not. */
export const CatalogActSchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({ available: z.literal(false), reason: NonEmptyStringSchema }),
]);
export type CatalogAct = z.infer<typeof CatalogActSchema>;

// ── Machine ──────────────────────────────────────────────────────────────────────────────────────

export const MachineToolSchema = z.strictObject({
  harness: HarnessKeySchema,
  /** "Claude Code", "Codex". */
  label: NonEmptyStringSchema,
  installed: z.boolean(),
  /** The absolute command this machine resolves, when it is installed. Nothing was run to find it. */
  command: NonEmptyStringSchema.optional(),
});
export type MachineTool = z.infer<typeof MachineToolSchema>;

/**
 * What THIS caller may do to this machine, read before a surface offers a control it cannot use.
 *
 * IT IS THE CAPABILITY LAYER'S ANSWER, not a second one. `mayApply` is `fleet.configure` as the
 * operator's grants decided it for this request (reading the machine is itself `fleet.use`, so
 * inspecting and proposing are implied). A governed caller confirms an apply with the same passkey
 * step-up `fleet.configure` already demands, so there is nothing further to announce.
 */
export const MachineAuthoritySchema = z.strictObject({
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
export type MachineAuthority = z.infer<typeof MachineAuthoritySchema>;

/**
 * "What agents may control" (T, session-spec.html Settings): terminals, browsers and files, each on/off,
 * and Ferretry settings — whether an agent may edit this machine's configuration files with the
 * `config.*` tools (docs/config-files.md), off unless the owner turns it on; and Page scripts — whether
 * an agent may run its own JavaScript in a page (`browser.eval`), off unless the owner turns it on.
 */
export const AgentControlSchema = z.strictObject({
  terminals: z.boolean(),
  browsers: z.boolean(),
  files: z.boolean(),
  ferretrySettings: z.boolean(),
  pageScripts: z.boolean(),
});
export type AgentControl = z.infer<typeof AgentControlSchema>;

export const MachineViewSchema = z.strictObject({
  name: NonEmptyStringSchema,
  format: CatalogFormatSchema,
  /** At least one runtime exists. A machine that is not set up opens the first run (M3). */
  setUp: z.boolean(),
  agentPermissions: z.enum(['auto', 'skip']),
  /**
   * "Default runtime for new agents" (T), RESOLVED: the machine's own setting, or the
   * `claude-default` fallback when that is an agent runtime here, or `null` when neither resolves —
   * there is nothing yet to pick, and a start with no runtime named would be refused too.
   */
  defaultRuntime: NonEmptyStringSchema.nullable(),
  agentControl: AgentControlSchema,
  /**
   * "Browser mode": how this machine runs its agent browser — `headless`, or a real `window` an owner
   * browses through themselves (docs/browser-mode.md).
   */
  browserMode: BrowserModeSchema,
  /**
   * "Browser proxy": where the agent browser sends its traffic (docs/browser-proxy.md), or `null` for direct.
   * Credentials are only ever `${secret:NAME}` references here.
   */
  browserProxy: BrowserProxySettingSchema.nullable(),
  /**
   * "Browser ports": `random`, `per-user` or explicit loopback ports for the agent browser, its sign-in relay and
   * the login window.
   */
  browserPorts: BrowserPortsSettingSchema,
  /**
   * "When the loopback firewall check fails": `warn` or `refuse` (decline to start the browser on a fixed port).
   */
  browserFirewallFailure: BrowserFirewallFailureSchema,
  /**
   * "Auto-resume after restart": when the daemon boots and finds ferrets that were running when the host
   * went down, it resumes them with their conversation intact.
   */
  autoResume: z.boolean(),
  /**
   * "Agenda mode for new ferrets" (docs/agenda.md): whether a ferret started from now on is told to keep an agenda.
   */
  agendaMode: z.boolean(),
  /**
   * "Public usage feed" (docs/multi-user-host.md): whether `GET /usage` and `GET /metrics` answer a caller with no
   * credential.
   */
  publicUsageFeed: z.boolean(),
  /** What the last auto-resume pass did, or `null` when none has run. */
  lastAutoResume: AutoResumeSummarySchema.nullable(),
  tools: z.array(MachineToolSchema).readonly(),
  runtimeCount: NonNegativeIntegerSchema,
  runningSessions: NonNegativeIntegerSchema,
  /** What this caller may do here, step-up included. */
  authority: MachineAuthoritySchema,
});
export type MachineView = z.infer<typeof MachineViewSchema>;

// ── Components ───────────────────────────────────────────────────────────────────────────────────

/** One environment variable: its value when it may travel, or the fact that it is hidden. */
export const EnvEntrySchema = z.union([
  z.strictObject({ name: NonEmptyStringSchema, value: z.string() }),
  z.strictObject({ name: NonEmptyStringSchema, hidden: z.literal(true) }),
]);
export type EnvEntry = z.infer<typeof EnvEntrySchema>;

/** What stands in a command-line word for the value that is not shown, and so can never be typed as one (the Vault contract's). */
export { HIDDEN_WORD_TEXT };

/**
 * One launch flag or MCP argument as it may travel: as written, or — when it carries a credential — the fact that it
 * is hidden, with the word as it may be shown (`--token=‹hidden›`, `‹hidden›` after `--token`).
 */
export const HiddenWordSchema = z.strictObject({ shown: NonEmptyStringSchema, hidden: z.literal(true) });
export const CommandWordSchema = z.union([z.string(), HiddenWordSchema]);
export type HiddenWord = z.infer<typeof HiddenWordSchema>;
export type CommandWord = z.infer<typeof CommandWordSchema>;

/** What a component holds, per kind. A file is named relative to the fleet's asset tree. */
export const ComponentDetailSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('instructions'), file: NonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('mcp'),
    command: NonEmptyStringSchema.optional(),
    args: z.array(CommandWordSchema).readonly().optional(),
    /** The etag of `args` as read, present with them: an edit that keeps a hidden argument sends it back. */
    argsEtag: NonEmptyStringSchema.optional(),
    url: NonEmptyStringSchema.optional(),
    /** `oauth`: the server is signed in to from Ferretry (docs/mcp-oauth.md). */
    auth: z.literal('oauth').optional(),
    env: z.array(EnvEntrySchema).readonly(),
  }),
  z.strictObject({ kind: z.literal('skills'), items: z.array(NonEmptyStringSchema).readonly() }),
  z.strictObject({
    kind: z.literal('settings'),
    file: NonEmptyStringSchema.optional(),
    flags: z
      .array(z.union([NonEmptyStringSchema, HiddenWordSchema]))
      .readonly()
      .optional(),
    /** The etag of `flags` as read, present with them: an edit that keeps a hidden flag sends it back. */
    flagsEtag: NonEmptyStringSchema.optional(),
    env: z.array(EnvEntrySchema).readonly(),
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
export type ComponentDetail = z.infer<typeof ComponentDetailSchema>;

/** Who uses a component or a profile: profiles by name, and the runtimes behind them. */
export const ComponentUsageSchema = z.strictObject({
  profiles: z.array(NonEmptyStringSchema).readonly(),
  runtimes: z.array(NonEmptyStringSchema).readonly(),
});
export type ComponentUsage = z.infer<typeof ComponentUsageSchema>;

/** A component one harness honours only in part (K5, E22). */
export const PartialSupportSchema = z.strictObject({
  harness: HarnessKeySchema,
  reason: NonEmptyStringSchema,
});

/** One settings key as it may travel: its value in words, or the fact that it is hidden (K4). */
export const SettingsEntrySchema = z.union([
  /** A string is shown as it is; any other value as its JSON text. */
  z.strictObject({ key: NonEmptyStringSchema, value: z.string() }),
  z.strictObject({ key: NonEmptyStringSchema, hidden: z.literal(true) }),
]);
export type SettingsEntry = z.infer<typeof SettingsEntrySchema>;

/** What a component's file says, for the kinds that have one, with every secret-looking value cut out. */
export const ComponentContentSchema = z.discriminatedUnion('form', [
  /** Instructions and hooks: the file text. `redacted` says a secret-looking value was replaced by `‹hidden›`. */
  z.strictObject({ form: z.literal('text'), text: z.string(), redacted: z.boolean() }),
  /** Settings: the parsed file flattened to dotted keys, sorted. Objects nest; arrays, scalars and `{}` are leaves. */
  z.strictObject({ form: z.literal('entries'), entries: z.array(SettingsEntrySchema).readonly() }),
]);
export type ComponentContent = z.infer<typeof ComponentContentSchema>;

export const ComponentViewSchema = z.strictObject({
  /** `<kind>/<name>`, as a profile layer names it. */
  reference: NonEmptyStringSchema,
  kind: ComponentKindSchema,
  name: NonEmptyStringSchema,
  /** The one harness it belongs to; absent for a generic component. */
  harness: HarnessKeySchema.optional(),
  /** Generic, or the one harness it can be used with — for a model set, derived from its model ids. */
  scope: HarnessScopeSchema,
  detail: ComponentDetailSchema,
  partial: z.array(PartialSupportSchema).readonly(),
  /** Notes that do not block saving (K6): "Command not found: uvx". */
  warnings: z.array(NonEmptyStringSchema).readonly(),
  usedBy: ComponentUsageSchema,
  /** What the edit screen says about where the change lands (E20). */
  editNote: NonEmptyStringSchema,
  /** Whether it can be deleted now (K7, E21). */
  remove: CatalogActSchema,
  /** What its file says: absent for MCP, skills and model sets, or when the file cannot be read or parsed. */
  content: ComponentContentSchema.optional(),
  /** E30: a path under somebody else's home that this component names, to check on this machine. */
  checkPath: NonEmptyStringSchema.optional(),
  /** Set by Clone: the machine it was copied from, by the name that machine gave itself. */
  clonedFrom: NonEmptyStringSchema.optional(),
  /** That machine's daemon id as the copying browser reported it, so a surface can name it by its own label. */
  clonedFromDaemon: NonEmptyStringSchema.optional(),
  /** Set by a catalog install: what this machine verified about where it came from (docs/catalogs.md). */
  installedFrom: CatalogProvenanceSchema.optional(),
});
export type ComponentView = z.infer<typeof ComponentViewSchema>;

export const ComponentGroupSchema = z.strictObject({
  kind: ComponentKindSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  components: z.array(ComponentViewSchema).readonly(),
});
export type ComponentGroup = z.infer<typeof ComponentGroupSchema>;

export const ComponentCatalogSchema = z.strictObject({
  format: CatalogFormatSchema,
  kinds: z.array(ComponentGroupSchema).readonly(),
});
export type ComponentCatalog = z.infer<typeof ComponentCatalogSchema>;

// ── Profiles ─────────────────────────────────────────────────────────────────────────────────────

/** One key two layers set to different values (P4, E18). Information, never an error. */
export const LayerConflictSchema = z.strictObject({
  harness: HarnessKeySchema,
  field: z.enum(['settings', 'env', 'model']),
  key: NonEmptyStringSchema,
  /** "`permissions.defaultMode` · Claude Code: acceptEdits (from agent) overrides plan (from default)". */
  sentence: NonEmptyStringSchema,
  winner: NonEmptyStringSchema,
  overridden: z.array(NonEmptyStringSchema).readonly(),
});
export type LayerConflict = z.infer<typeof LayerConflictSchema>;

/** A layer one harness does not use (P5), with the reason in words. */
export const SkippedLayerSchema = z.strictObject({
  reference: NonEmptyStringSchema,
  sentence: NonEmptyStringSchema,
});

/** A profile resolved for one harness: what applies, what is skipped, and what overrides what. */
export const StackViewSchema = z.strictObject({
  harness: HarnessKeySchema,
  available: CatalogActSchema,
  /** The components that apply, oldest first. */
  applied: z.array(NonEmptyStringSchema).readonly(),
  skipped: z.array(SkippedLayerSchema).readonly(),
  conflicts: z.array(LayerConflictSchema).readonly(),
  partial: z.array(z.strictObject({ reference: NonEmptyStringSchema, reason: NonEmptyStringSchema })).readonly(),
});
export type StackView = z.infer<typeof StackViewSchema>;

export const LayeredProfileViewSchema = z.strictObject({
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
  scope: ProfileScopeSchema,
  harnesses: z.array(StackViewSchema).readonly(),
  /** Whether it can be deleted now (P6, E21), and which runtimes must pick another profile first. */
  remove: CatalogActSchema,
});
export type LayeredProfileView = z.infer<typeof LayeredProfileViewSchema>;

export const LayeredProfileCatalogSchema = z.strictObject({
  format: CatalogFormatSchema,
  profiles: z.array(LayeredProfileViewSchema).readonly(),
});
export type LayeredProfileCatalog = z.infer<typeof LayeredProfileCatalogSchema>;

/**
 * `POST /v1/runtimes/profiles/preview`: a profile's layers as the builder has them, before it is
 * named or saved. Writes nothing.
 */
export const ProfileDraftRequestSchema = z.strictObject({
  /** Oldest first, as `profile.put` would send them. */
  layers: z.array(NonEmptyStringSchema).max(200),
  /** The profile being edited, whose own layers these replace. */
  editing: ComponentNameSchema.optional(),
});
export type ProfileDraftRequest = z.infer<typeof ProfileDraftRequestSchema>;

/**
 * Which part of the merge a resolved value is in (§3.4): an MCP server or a skill by its name, a
 * settings key, an environment variable, a launch flag, an instructions or hooks component, the model.
 */
export const ResolvedFieldSchema = z.enum([
  'instructions',
  'mcp',
  'skills',
  'settings',
  'env',
  'flags',
  'hooks',
  'model',
]);
export type ResolvedField = z.infer<typeof ResolvedFieldSchema>;

/**
 * One value as a content item set it. `from` is the profile's OWN content item that brought it in —
 * the component itself, or the `profile/<name>` it arrived through — so a list can mark that item.
 * `hidden` says a secret-looking value was replaced by `‹hidden›` before it left the daemon.
 */
export const ResolvedSetterSchema = z.strictObject({
  value: z.string(),
  hidden: z.literal(true).optional(),
  from: NonEmptyStringSchema,
});
export type ResolvedSetter = z.infer<typeof ResolvedSetterSchema>;

/**
 * One FINAL value of a profile for one harness (R5 "Resolved"): what the runtime gets for `key`, the
 * item it came from, and every earlier value it overrode, oldest first.
 */
export const ResolvedEntrySchema = z.strictObject({
  harness: HarnessKeySchema,
  field: ResolvedFieldSchema,
  key: NonEmptyStringSchema,
  value: z.string(),
  hidden: z.literal(true).optional(),
  from: NonEmptyStringSchema,
  overridden: z.array(ResolvedSetterSchema).readonly(),
});
export type ResolvedEntry = z.infer<typeof ResolvedEntrySchema>;

/** The draft resolved per harness exactly as a saved profile is, or why it cannot be. */
export const ProfileDraftViewSchema = z.strictObject({
  /** Claude Code, then Codex. */
  harnesses: z.array(StackViewSchema).readonly(),
  /**
   * Every final value per harness, Claude Code then Codex, in merge order (R5). Absent from a daemon
   * older than the Resolved view; empty for a draft that cannot be resolved.
   */
  resolved: z.array(ResolvedEntrySchema).readonly().optional(),
  /** What the draft's layers make it (P7). A mixed draft also carries the same sentence as `refusal`. */
  scope: ProfileScopeSchema,
  /** A layer that does not exist, or one that would include the profile itself. */
  refusal: NonEmptyStringSchema.optional(),
});
export type ProfileDraftView = z.infer<typeof ProfileDraftViewSchema>;

// ── Runtimes ─────────────────────────────────────────────────────────────────────────────────────

export const RuntimeModelSetSchema = z.discriminatedUnion('source', [
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
export type RuntimeModelSet = z.infer<typeof RuntimeModelSetSchema>;

/** One model a runtime offers, as its login's model catalog describes it (docs/model-catalog.md). */
export const RuntimeModelChoiceSchema = z.strictObject({
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
export type RuntimeModelChoice = z.infer<typeof RuntimeModelChoiceSchema>;

/**
 * What a runtime offers when its login reads a model catalog: exactly that catalog's models for the
 * runtime's CLI, and the one it launches with. Absent for a login with no catalog, whose runtimes offer
 * their profile's model set (`modelSet`).
 */
export const RuntimeModelsSchema = z.strictObject({
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
  choices: z.array(RuntimeModelChoiceSchema).readonly(),
  default: NonEmptyStringSchema.optional(),
  /** What the last read of the local server found, for a catalog that detects one (`catalog.detect`). */
  local: LocalModelsSchema.optional(),
});
export type RuntimeModels = z.infer<typeof RuntimeModelsSchema>;

/** The locked layer an agent runtime gets last (F1–F3), and the user values it overrides (E24). */
export const FixedLayerViewSchema = z.strictObject({
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
export type FixedLayerView = z.infer<typeof FixedLayerViewSchema>;

export const RuntimeViewSchema = z.strictObject({
  /** The runtime's stable id: the same id the manifest's account row and a session's account carry. */
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  /** The command name `fy start --agent` takes: the manifest account row's `wrapper`. */
  wrapper: NonEmptyStringSchema,
  harness: HarnessKeySchema,
  credential: z.strictObject({
    id: NonEmptyStringSchema,
    store: CredentialStoreSchema,
    label: NonEmptyStringSchema.optional(),
    status: CredentialStatusWordSchema.optional(),
  }),
  profile: NonEmptyStringSchema,
  agent: z.boolean(),
  stack: StackViewSchema,
  modelSet: RuntimeModelSetSchema,
  /** What the runtime offers from its login's model catalog, when the login reads one. Wins over `modelSet`. */
  models: RuntimeModelsSchema.optional(),
  /** Agent runtimes only. */
  fixedLayer: FixedLayerViewSchema.optional(),
  /** Whether it can launch now; when not, `reason` is the button's words ("Sign in to launch"). */
  launch: CatalogActSchema,
  /** Switched off — by its own switch or its login's. Running ferrets are untouched; new starts refuse. */
  disabled: DisabledSchema.optional(),
  /** Other runtimes on the same login and profile (R4). */
  sameAs: z.array(NonEmptyStringSchema).readonly(),
  /**
   * What the last apply on this machine left as it was inside this runtime's folder: each path relative to
   * that folder, never the folder's own place on disk. Kept in the daemon's memory until the next apply, so
   * every device sees it. Absent when nothing was skipped.
   */
  skipped: z.array(NonEmptyStringSchema).readonly().optional(),
});
export type RuntimeView = z.infer<typeof RuntimeViewSchema>;

export const RuntimeCatalogSchema = z.strictObject({
  format: CatalogFormatSchema,
  runtimes: z.array(RuntimeViewSchema).readonly(),
});
export type RuntimeCatalog = z.infer<typeof RuntimeCatalogSchema>;

// ── Changes ──────────────────────────────────────────────────────────────────────────────────────

/** An environment value as an edit sends it: a new value, or "keep the one it has". */
export const EnvInputSchema = z.record(z.string(), z.union([z.string(), z.strictObject({ keep: z.literal(true) })]));
export type EnvInput = z.infer<typeof EnvInputSchema>;

/** A word a person typed: never the text that stands in for a hidden value, so the mask can never be saved as one. */
const typedWord = <T extends z.ZodString>(schema: T) =>
  schema.refine(word => !word.includes(HIDDEN_WORD_TEXT), {
    message: `${HIDDEN_WORD_TEXT} stands in for a hidden value and cannot be saved as one: keep the word, or type its value`,
  });

/**
 * A launch flag or MCP argument as an edit sends it: a new word, or "keep the one at `at`" for a word the catalogue
 * reported as hidden. `at` is the word's position in the list as it was read; the list's etag says which read.
 */
export const KeptWordSchema = z.strictObject({ keep: z.literal(true), at: NonNegativeIntegerSchema });
export type KeptWord = z.infer<typeof KeptWordSchema>;

/** A launch flag as an edit sends it. */
export const FlagInputSchema = z.union([typedWord(NonEmptyStringSchema), KeptWordSchema]);
/** An MCP argument as an edit sends it. */
export const ArgInputSchema = z.union([typedWord(z.string()), KeptWordSchema]);

/**
 * A settings file as an edit sends it, by dotted key: a new value, or "keep the one it has" for a
 * value the catalogue reported as hidden.
 */
export const SettingsEntriesInputSchema = z.record(
  z.string(),
  z.union([z.strictObject({ value: z.json() }), z.strictObject({ keep: z.literal(true) })]),
);
export type SettingsEntriesInput = z.infer<typeof SettingsEntriesInputSchema>;

/**
 * A component's fields as a change sends them. A file's path is never sent: the daemon names it
 * (`components/<kind>/<name>.<ext>`) or keeps the one an existing component has, and `content` is its
 * text.
 */
export const ComponentInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('instructions'), harness: HarnessKeySchema.optional() }),
  z.strictObject({
    kind: z.literal('mcp'),
    command: NonEmptyStringSchema.optional(),
    args: z.array(ArgInputSchema).optional(),
    /** The `argsEtag` the kept arguments were read with; needed by every `{ keep: true }` in `args`. */
    argsEtag: NonEmptyStringSchema.optional(),
    url: NonEmptyStringSchema.optional(),
    /** `oauth` on a `url` server: signed in to from Ferretry (docs/mcp-oauth.md). */
    auth: z.literal('oauth').optional(),
    env: EnvInputSchema.optional(),
    harness: HarnessKeySchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('skills'),
    items: z.array(NonEmptyStringSchema).min(1),
    harness: HarnessKeySchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('settings'),
    harness: HarnessKeySchema,
    flags: z.array(FlagInputSchema).optional(),
    /** The `flagsEtag` the kept flags were read with; needed by every `{ keep: true }` in `flags`. */
    flagsEtag: NonEmptyStringSchema.optional(),
    env: EnvInputSchema.optional(),
    /** The file by entry, instead of `content`: the daemon writes the document. */
    entries: SettingsEntriesInputSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('hooks'), harness: HarnessKeySchema }),
  z.strictObject({
    kind: z.literal('modelSets'),
    models: z.array(NonEmptyStringSchema).min(1),
    default: NonEmptyStringSchema,
  }),
]);
export type ComponentInput = z.infer<typeof ComponentInputSchema>;

/** The longest component text one change may carry. */
export const MAX_COMPONENT_CONTENT_BYTES = 256 * 1024;

/**
 * One change to this machine's setup. `create: true` means "this name must be new": a clash is
 * refused with a suggestion (E16) rather than silently editing what is there.
 */
export const AccountChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('runtime.put'),
    name: TypedNameSchema,
    credential: NonEmptyStringSchema,
    profile: ComponentNameSchema,
    /**
     * Which CLI it runs, for a login that drives both (docs/provider-presets.md). Absent: the one its
     * profile is scoped to, else the login's own.
     */
    harness: HarnessKeySchema.optional(),
    agent: z.boolean(),
    create: z.boolean(),
    /** E15: the person saw "already uses this login and profile" and chose to add another anyway. */
    addAnother: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('runtime.remove'), name: NonEmptyStringSchema }),
  /**
   * Give a runtime a new name. A runtime's id is its name (Runtimes keeps no id state), so the apply also
   * rewrites every reference to it that other subsystems keep (Ferrets' records, the default runtime).
   */
  z.strictObject({ kind: z.literal('runtime.rename'), name: NonEmptyStringSchema, to: TypedNameSchema }),
  z.strictObject({
    kind: z.literal('profile.put'),
    name: ComponentNameSchema,
    /** Oldest first. A reorder is this with the same layers in a new order. */
    layers: z.array(NonEmptyStringSchema).min(1),
    create: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('profile.remove'),
    name: NonEmptyStringSchema,
    /** E21 "Switch n runtimes and delete": the profile every runtime on this one moves to. */
    switchRuntimesTo: ComponentNameSchema.optional(),
    /** E21 "Remove from those first": take it out of every profile built on it, then delete it. */
    removeFromProfiles: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('component.put'),
    name: ComponentNameSchema,
    component: ComponentInputSchema,
    /** The component's file text, for the kinds that have one. */
    content: z.string().max(MAX_COMPONENT_CONTENT_BYTES).optional(),
    create: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('component.remove'),
    componentKind: ComponentKindSchema,
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
    harness: HarnessKeySchema,
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
    env: EnvInputSchema,
    cloudCredential: NonEmptyStringSchema.max(512).nullable().optional(),
  }),
  z.strictObject({
    kind: z.literal('credential.label'),
    id: NonEmptyStringSchema,
    label: NonEmptyStringSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('credential.remove'),
    id: NonEmptyStringSchema,
    /**
     * "Switch to…": each runtime on this login mapped to the login it moves to, in the SAME apply as the
     * removal. Without it a login a runtime still uses is refused (C10), as before.
     */
    switchRuntimes: z.record(NonEmptyStringSchema, NonEmptyStringSchema).optional(),
    /** "Remove the runtime too": each runtime on this login deleted in the same apply (runtime.remove's rules). */
    removeRuntimes: z.array(NonEmptyStringSchema).optional(),
    /** The default runtime for new agents moves here in the same apply: required when a removed runtime was it. */
    defaultRuntime: NonEmptyStringSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('credential.signout'), id: NonEmptyStringSchema }),
  /**
   * Switch a login off without deleting it (docs/disabling.md). A tightening: it needs no confirmation.
   * `until` is an instant; the login switches itself back on then.
   */
  z.strictObject({
    kind: z.literal('credential.disable'),
    id: NonEmptyStringSchema,
    reason: NonEmptyStringSchema.max(200).optional(),
    until: InstantSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('credential.enable'), id: NonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('runtime.disable'),
    name: NonEmptyStringSchema,
    reason: NonEmptyStringSchema.max(200).optional(),
    until: InstantSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('runtime.enable'), name: NonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('machine.settings'),
    agentPermissions: z.enum(['auto', 'skip']),
    /**
     * A caller always sends all three machine settings together — never only the one it means to
     * change — so one `machine.settings` change can never clobber a field it was not shown. `null`
     * unsets the explicit "Default runtime" override and falls back to the machine's own resolution.
     */
    defaultRuntime: NonEmptyStringSchema.nullable(),
    agentControl: AgentControlSchema,
    browserMode: BrowserModeSchema,
    /** `null` turns the proxy off. */
    browserProxy: BrowserProxySettingSchema.nullable(),
    browserPorts: BrowserPortsSettingSchema,
    browserFirewallFailure: BrowserFirewallFailureSchema,
    autoResume: z.boolean(),
    agendaMode: z.boolean(),
    publicUsageFeed: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('setup.import'),
    /** The harnesses the person chose to import ("Skip Claude Code"). Default: every installed one. */
    include: z.array(HarnessKeySchema).max(2).optional(),
    /** The runtime name the person gave each imported harness (§4.3 step 4). Default: the suggestion. */
    names: z.strictObject({ 'claude-code': TypedNameSchema.optional(), codex: TypedNameSchema.optional() }).optional(),
    /** Components whose source changed since the last import that the person chose to update (O6). */
    acceptedUpdates: z.array(NonEmptyStringSchema).optional(),
    /** Add a runtime even where an identical one exists (E15 during Import again). */
    addDuplicates: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('clone.import'),
    /**
     * `update` repeats an earlier copy and writes only what the review listed and the person chose
     * (`decisions`); `alongside` and `replace` copy everything, as they always have.
     */
    mode: z.enum(['alongside', 'replace', 'update']),
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
    /**
     * "Default runtime for new agents" after the copy: the SOURCE's name for one of the agent runtimes the
     * bundle brings (the target maps it through any rename), or `null` to leave it unset. Left out, the
     * target keeps its own default when the copy leaves it standing, and otherwise picks a valid one and
     * says so — a copy never leaves a default that names a runtime it removed.
     */
    defaultRuntime: NonEmptyStringSchema.nullable().optional(),
    /**
     * What this browser calls the two machines, for the sentences the target writes (`Liftoff EC2`, not
     * the hostname). Display only: nothing is matched against them.
     */
    names: z.strictObject({ source: NonEmptyStringSchema.max(120), target: NonEmptyStringSchema.max(120) }).optional(),
    /** `update` only: what to do with each item the review listed, by its `ref`. Every `both` item needs one. */
    decisions: CloneDecisionsSchema.optional(),
    /** `update` only: which login here each sign-in the source carries uses. Never rewrites a login. */
    logins: CloneLoginChoicesSchema.optional(),
    /** `update` only: the review's fingerprint. The apply re-plans and is refused when it no longer matches. */
    reviewed: NonEmptyStringSchema.optional(),
    /**
     * `update` only: the settings documents the source carried (`warden.yaml`, `learning.yaml`, `voice.yaml`
     * as text, and `controls` as JSON), merged key by key against this machine's own.
     */
    settings: z.array(CloneSettingsTextSchema).max(CLONE_SETTINGS_DOCS.length).optional(),
    /** `update` only: take or keep for each key the review listed. Every key both sides changed needs one. */
    settingsDecisions: CloneSettingsDecisionsSchema.optional(),
  }),
]);
export type AccountChange = z.infer<typeof AccountChangeSchema>;
export type AccountChangeKind = AccountChange['kind'];

export const AccountChangeRequestSchema = z.strictObject({ change: AccountChangeSchema });
export type AccountChangeRequest = z.infer<typeof AccountChangeRequestSchema>;

/** A runtime as the change would publish it. */
export const ChangedRuntimeSchema = z.strictObject({
  name: NonEmptyStringSchema,
  harness: HarnessKeySchema,
  agent: z.boolean(),
  launch: CatalogActSchema,
});

/** A session still running on a runtime a change removes or renames, as the confirm card lists it. */
export const RunningSessionSchema = z.strictObject({
  id: NonEmptyStringSchema,
  /** What the person calls it: its teammate name, else its own name, else its id. */
  name: NonEmptyStringSchema,
  harness: HarnessKeySchema,
  /** The runtime it runs on, named when one change touches several (removing a login). */
  runtime: NonEmptyStringSchema.optional(),
});
export type RunningSession = z.infer<typeof RunningSessionSchema>;

/** What applying the change would do, for the person approving it. */
export const AccountChangePreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('apply'),
    operations: z.array(WriteOperationSchema).readonly(),
    documents: z.array(DocumentSummarySchema).readonly(),
    runtimes: z.array(ChangedRuntimeSchema).readonly(),
    /**
     * The sessions still running on the runtime a `runtime.remove` or `runtime.rename` names, so the
     * confirm card can list them and offer to move them first. Present only when there are some.
     */
    runningSessions: z.array(RunningSessionSchema).readonly().optional(),
    /**
     * Secret NAMES (never values) that only the login a `credential.remove` deletes referred to. The
     * secret store is a separate capability (docs/secrets.md), so they are listed, not deleted.
     */
    orphanedSecrets: z.array(NonEmptyStringSchema).readonly().optional(),
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
export type AccountChangePreview = z.infer<typeof AccountChangePreviewSchema>;

export const AccountChangeViewSchema = z.strictObject({
  id: ProposalIdSchema,
  revision: NonEmptyStringSchema,
  /** The change as staged; a component's text is reported by size in `documents`, not repeated. */
  change: AccountChangeSchema,
  summary: NonEmptyStringSchema,
  /** The sentences a confirm card shows: who else it changes, what it signs out (E20, E21, E25). */
  consequences: z.array(NonEmptyStringSchema).readonly(),
  expiresAt: InstantSchema,
  state: z.enum(['pending', 'consumed']),
  preview: AccountChangePreviewSchema,
});
export type AccountChangeView = z.infer<typeof AccountChangeViewSchema>;

/** What applying a change did. */
export const AccountChangeOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('applied'), apply: ApplyOutcomeSchema }),
  z.strictObject({ outcome: z.literal('signed-out'), credential: CredentialViewSchema }),
  z.strictObject({
    outcome: z.literal('sign-out-failed'),
    reason: NonEmptyStringSchema,
    credential: CredentialViewSchema,
  }),
  z.strictObject({
    /**
     * A change to one login, made by Logins (every `credential.*` except a sign-out). `held`: the file was written but it
     * loosens something (a removed budget), so the tighter version stays in effect until the owner confirms;
     * `sentences` say what widened.
     */
    outcome: z.literal('login-changed'),
    result: z.enum(['applied', 'held']),
    sentences: z.array(NonEmptyStringSchema).readonly().optional(),
    /** What the change was, in the words the preview used ("Remove login work"): a client says what happened, not just "Done". */
    summary: NonEmptyStringSchema.optional(),
    /** A removal that moved or removed runtimes first: what that apply did, with the paths it left as they were. */
    moved: ApplyOutcomeSchema.optional(),
  }),
  z.strictObject({
    outcome: z.literal('executed'),
    executor: z.enum(['setup', 'clone']),
    summary: NonEmptyStringSchema,
  }),
]);
export type AccountChangeOutcome = z.infer<typeof AccountChangeOutcomeSchema>;

/** Every refusal the catalogue and its changes answer with, so a client branches on cause. */
export const CATALOG_REFUSAL_CODES = [
  'fleet_catalog_unreadable',
  'fleet_change_refused',
  'fleet_change_unknown',
  'fleet_change_expired',
  'fleet_change_consumed',
  'fleet_change_unauthorized',
  'fleet_change_stale',
  'fleet_change_failed',
] as const;
export const CatalogRefusalCodeSchema = z.enum(CATALOG_REFUSAL_CODES);
export type CatalogRefusalCode = z.infer<typeof CatalogRefusalCodeSchema>;
