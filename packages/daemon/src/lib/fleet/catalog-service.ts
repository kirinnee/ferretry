/**
 * The account model's catalogue and its reviewed changes, as this daemon serves them
 * (docs/design/account-model.md §4, §7): what the machine has, read fresh on every call, and every
 * change a person can make to it, staged as a preview and applied in a second, explicit step.
 *
 * ## Reads
 *
 * The machine, components, profile and runtime reads answer the configuration IN EFFECT — the
 * configuration files, each at its last good version (docs/config-files.md) — and no configuration at
 * all as an empty model. A retired single-file `fleet/config.yaml` is refused as unreadable, with the
 * sentence saying how to set the machine up again — never converted, never touched. Nothing is launched and no provider is called; the only facts outside the configuration
 * are the component files it names, the harness commands this daemon's one rule resolves, and the
 * credential statuses the credentials surface already knows.
 *
 * ## One change, one plan, one boundary
 *
 * A caller names ONE intent; {@link deriveAccountChange} derives the next model from the current one.
 * The model is materialised by the fleet library into the exact plan the provisioner previews, and the
 * apply writes the configuration files that change, every component document the change carries, and that plan inside the
 * provisioner's single rollback boundary — so a machine is never left declaring a runtime whose
 * directory was never made, or a component whose file was never written. Each document carries the
 * digest it was composed against, and the provisioner refuses one that moved.
 *
 * Sign-out, first-run import and clone are not configuration edits: they run their own executors
 * (U13's sign-out, and the setup and clone ports U15 fills), reviewed and confirmed the same way.
 *
 * ## Governed like every fleet change
 *
 * Who may stage or apply is the route's `fleet.configure`, which holds a caller off this host behind a
 * live passkey step-up. The order is: read the change, consume synchronously, check it is still current,
 * then act — restoring it only while it is certain nothing was attempted.
 */
import {
  type AccountModel,
  type ClaudeStatuslineCommand,
  EMPTY_RUNTIME_IDS,
  expandAssetPath,
  FleetApplyFailureError,
  type FleetApplyPreview,
  type FleetDocumentWrite,
  type FleetLayout,
  type FleetModelApplyPlan,
  type FleetProvisioner,
  type HarnessKind,
  joinPath,
  type MaterialiseBodies,
  type ModelCatalogSources,
  materialiseFleet,
  nextDisableExpiry,
  type BudgetHolds,
  type ProviderPreset,
  parseSettings,
  type RuntimeIds,
  type RuntimeRename,
  renameRuntimeId,
  type SettingsObject,
  skillFrontmatterKeys,
  skillSourceReference,
} from '@ferretry/fleet';
import type {
  AutoResumeSummary,
  FleetAccountChange,
  FleetAccountChangeOutcome,
  FleetAccountChangePreview,
  FleetAccountChangeView,
  FleetAgentControl,
  FleetCatalogInstallChange,
  FleetCatalogFormat,
  FleetCatalogRefusalCode,
  FleetComponentCatalog,
  FleetCredentialList,
  FleetLayeredProfileCatalog,
  FleetMachineAuthority,
  FleetMachineView,
  FleetProfileDraftRequest,
  FleetProfileDraftView,
  FleetRunningSession,
  FleetRuntimeCatalog,
  SessionStatus,
} from '@ferretry/protocol';
import { FleetCatalogInstallChangeSchema } from '@ferretry/protocol';
import type { CallerGovernance, CapabilityPresentation } from '../api/capability.ts';
import { ApiError } from '../api/error.ts';
import {
  type CatalogFacts,
  componentCatalog,
  componentUsage,
  machineView,
  profileCatalog,
  profileDraftView,
  runtimeCatalog,
  runtimesUsingCredential,
} from './catalog.ts';
import { FleetCredentialRefusal, type FleetCredentialSignOutOutcome } from './credentials-service.ts';
import {
  type AccountChangeFacts,
  type AccountComponentFile,
  type AccountPlanChange,
  deriveAccountChange,
  FleetMutationRefusal,
  isAccountPlanChange,
} from './mutations.ts';
import { type FleetProposalRecord, FleetProposalRefusal, FleetProposalStore, redactProposal } from './proposals.ts';
import {
  type RuntimeSessionRecord,
  runningSessionsOn,
  type SessionRuntimeRename,
  sessionRunning,
} from './runtime-sessions.ts';
import { applyFailureSummary, applyResultSummary, operationSummary } from './wire.ts';

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

/** Every refusal this surface answers with, so a client branches on cause rather than on prose. */
export class FleetCatalogRefusal extends Error {
  constructor(
    readonly code: FleetCatalogRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'FleetCatalogRefusal';
  }
}

/**
 * "What agents may control" turned back ON, from a device this request did not just prove a passkey
 * for (owner decision, T) — the same "adding access always asks" rule `docs/grants.md` states for
 * minting a pairing code and widening a device, reused rather than reinvented: a passkey proved FOR
 * THIS ACT, never the unlock alone and never a step-up merely inside its window. Turning one OFF, and
 * every act from the machine itself (loopback), never throws this.
 */
export class FleetCatalogFreshStepUpRequired extends Error {
  constructor() {
    super('turning an agent control back on from a remote device needs a passkey confirmation for it');
    this.name = 'FleetCatalogFreshStepUpRequired';
  }
}

const AGENT_CONTROL_KINDS: readonly (keyof FleetAgentControl)[] = [
  'terminals',
  'browsers',
  'files',
  'ferretrySettings',
  'pageScripts',
];

/** Whether `next` turns ON a kind `current` did not already allow — the half of a write that ever
 *  needs a fresh passkey. Unchanged values, a narrowed kind and a kind left out never count. */
function agentControlWidened(current: FleetAgentControl, next: Partial<FleetAgentControl>): boolean {
  return AGENT_CONTROL_KINDS.some(kind => !current[kind] && next[kind] === true);
}

/** What `apply` needs to enforce and spend the fresh-passkey rule above. Absent reads as "no proof
 *  and nothing to spend" — never as "trust it", so a boundary that forgot to wire this fails closed. */
export interface FreshStepUpContext {
  readonly presentation: CapabilityPresentation | undefined;
  readonly spend: () => void;
}

// ── Ports ────────────────────────────────────────────────────────────────────────────────────────

/** The machine's configuration as one read: its format, its model, and the digest it was read at. */
export interface AccountDocumentReading {
  readonly format: FleetCatalogFormat;
  /** The model in effect, or an empty one when there is no configuration. */
  readonly model: AccountModel;
  /** A digest of the fleet files in effect, or `ABSENT_DOCUMENT_REVISION` when there are none. */
  readonly revision: string;
  /**
   * The writes that move the configuration files from this model to `next` (docs/config-files.md):
   * each changed file rewritten key by key with its comments kept, each file `next` drops removed —
   * every one carrying the revision it was composed against, which the provisioner checks. A `rename`
   * moves that runtime's file with its comments and re-points every other file that names it.
   */
  documents(next: AccountModel, rename?: RuntimeRename): readonly FleetDocumentWrite[];
}

/** A first-run import or a clone, carried out by its own executor (U15). */
export interface AccountChangeExecutor<Change extends FleetAccountChange> {
  /** What applying would do, in words, for the confirm card. Writes nothing. */
  describe(change: Change): Promise<string>;
  /** Do it. Answers the one-line summary of what was done. */
  execute(change: Change): Promise<string>;
}

type SetupChange = Extract<FleetAccountChange, { kind: 'setup.import' }>;
type CloneChange = Extract<FleetAccountChange, { kind: 'clone.import' }>;

export interface FleetCatalogServiceDeps {
  /**
   * The configuration in effect. Throws when it exists and cannot be read. `fresh` loads it from disk
   * first rather than answering the last load — what judging a change stale needs, because an edit
   * saved a moment ago may not have been loaded yet.
   */
  document(fresh?: boolean): Promise<AccountDocumentReading>;
  /** One file a component names, by absolute path. `undefined` when it is absent or cannot be read. */
  readAsset(path: string): Promise<string | undefined>;
  /** What a document is now: its sha256, or `ABSENT_DOCUMENT_REVISION`. */
  documentRevision(path: string): Promise<string>;
  /** `ids.json`; `undefined` when there is none yet. */
  ids(): Promise<RuntimeIds | undefined>;
  /** The harness command this daemon's one rule resolves. Nothing is launched to find it. */
  locate(harness: HarnessKind): string | undefined;
  /**
   * Whether every wrapper file this plan would write already holds exactly that content on disk. A
   * republish whose manifest is unchanged still has to rewrite a wrapper whose harness path moved, which
   * the manifest does not record. Absent means the caller cannot say, and the manifest alone decides.
   */
  wrappersCurrent?(plan: FleetModelApplyPlan): Promise<boolean>;
  /** Whether an MCP server's command resolves on this machine (K6). */
  commandExists(command: string): boolean;
  /** Every session's status, to count the running ones (E20, E32). */
  sessionStatuses(): Promise<readonly SessionStatus[]>;
  /**
   * Every session's runtime facts, for the sessions a runtime removal or rename names. Absent means
   * this daemon cannot say, and the confirm card says only what it knows.
   */
  sessionRecords?(): Promise<readonly RuntimeSessionRecord[]>;
  /**
   * Re-point every session record on a renamed runtime at its new name, once the rename has applied.
   * Answers how many moved. A record it could not rewrite still resolves through `ids.json`.
   */
  renameSessions?(rename: SessionRuntimeRename): Promise<number>;
  machineName(): string;
  /** The credentials surface: its list for status words and sign-out sentences, its sign-out executor. */
  readonly credentials: {
    list(): Promise<FleetCredentialList>;
    signOut(id: string): Promise<FleetCredentialSignOutOutcome>;
  };
  readonly provisioner: Pick<FleetProvisioner, 'preview' | 'apply'>;
  readonly layout: FleetLayout;
  /** A fresh runtime id (a UUID). */
  mint(): string;
  /** 22 URL-safe characters for a change handle. */
  mintId(): string;
  now(): number;
  /** Claude's statusLine command, bound to `claudeStatuslineCommand(binary, own)`. */
  readonly claudeStatusline: ClaudeStatuslineCommand;
  /** The `fy` executable a wrapper runs to claim a conversation. */
  readonly fyCommand: string;
  /** The person's own Codex home, when it can be named. */
  readonly hostCodexHome?: string;
  /** Whether the installed Claude accepts `--permission-mode auto` (O4), measured on the pinned version. */
  readonly acceptsAutoPermissionMode: boolean;
  /** The provider presets this machine offers, for a login made from one (docs/provider-presets.md). */
  presets?(): Promise<readonly ProviderPreset[]>;
  /** The model catalogs and presets in effect (docs/model-catalog.md): what each runtime offers and pins. */
  modelCatalogs?(): Promise<ModelCatalogSources>;
  /** The fleet manifest as it is published now, unparsed; `undefined` when there is none. */
  publishedManifest?(): Promise<unknown>;
  /** The last auto-resume pass after a restart, for the Machine view; `null` when none has run. */
  lastAutoResume?(): Promise<AutoResumeSummary | null>;
  /**
   * The logins their spend budget holds now (docs/budgets.md), published unavailable exactly as a disabled
   * login is. Absent: no budget holds anything.
   */
  budgetHolds?(): BudgetHolds;
  /** The first-run import and clone executors. Absent means "not available on this machine yet". */
  readonly executors?: {
    readonly setup?: AccountChangeExecutor<SetupChange>;
    readonly clone?: AccountChangeExecutor<CloneChange>;
  };
}

/** The budget holds every publish carries (docs/budgets.md), or nothing when none are known. */
export function budgetHoldsOf(deps: Pick<FleetCatalogServiceDeps, 'budgetHolds'>): {
  readonly budgetHolds?: BudgetHolds;
} {
  const holds = deps.budgetHolds?.();
  return holds === undefined || Object.keys(holds).length === 0 ? {} : { budgetHolds: holds };
}

// ── Running sessions ─────────────────────────────────────────────────────────────────────────────

/** How many of these sessions are still running. */
export const countRunningSessions = (statuses: readonly SessionStatus[]): number =>
  statuses.filter(sessionRunning).length;

/**
 * Whether a planned manifest says what the published one already says, the moment it was made
 * aside. Anything else that differs — a model, a default, a catalog — is worth publishing again.
 */
/** The absolute path each located harness resolved to, which a wrapper execs instead of a bare name. */
export function harnessCommandsOf(
  locate: (harness: HarnessKind) => string | undefined,
): Partial<Record<HarnessKind, string>> {
  const claude = locate('claude');
  const codex = locate('codex');
  return {
    ...(claude === undefined ? {} : { claude }),
    ...(codex === undefined ? {} : { codex }),
  };
}

export function sameManifest(planned: { readonly generatedAt: string }, published: unknown): boolean {
  if (published === null || typeof published !== 'object') return false;
  const { generatedAt: _planned, ...next } = planned;
  const { generatedAt: _published, ...current } = published as { readonly generatedAt?: unknown };
  return JSON.stringify(next) === JSON.stringify(current);
}

// ── Component bodies ─────────────────────────────────────────────────────────────────────────────

/** The document format each harness's settings file is in. */
const SETTINGS_FORMAT = { claude: 'json', codex: 'toml' } as const satisfies Record<HarnessKind, 'json' | 'toml'>;

/** A document that parses, or nothing: an unreadable body is reported by the plan, not here. */
function parsed(text: string | undefined, format: 'json' | 'toml'): SettingsObject | undefined {
  if (text === undefined) return undefined;
  try {
    return parseSettings(text, format);
  } catch {
    return undefined;
  }
}

/** The bodies a materialisation reads, and each hooks file's text as the edit screen shows it. */
interface ReadBodies extends MaterialiseBodies {
  readonly hooksTexts: Readonly<Record<string, string>>;
}

/** The configuration's file paths are relative to the asset tree, or `~`/absolute. */
const assetPath = (layout: FleetLayout, file: string): string =>
  expandAssetPath(file, layout.userHome, layout.assetsDirectory);

// ── Proposals ────────────────────────────────────────────────────────────────────────────────────

/** What a staged change holds: the exact plan and documents, or the executor it runs. */
type ChangePayload =
  | {
      readonly kind: 'apply';
      readonly plan: FleetModelApplyPlan;
      readonly documents: readonly FleetDocumentWrite[];
      readonly preview: Extract<FleetAccountChangePreview, { kind: 'apply' }>;
      readonly consequences: readonly string[];
    }
  | {
      readonly kind: 'sign-out';
      readonly preview: Extract<FleetAccountChangePreview, { kind: 'sign-out' }>;
      readonly consequences: readonly string[];
    }
  | {
      readonly kind: 'executor';
      readonly preview: Extract<FleetAccountChangePreview, { kind: 'executor' }>;
      /** Runs the executor on exactly the change that was described. */
      readonly run: () => Promise<string>;
      readonly consequences: readonly string[];
    };

type ChangeRecord = FleetProposalRecord<ChangePayload, FleetAccountChange>;

const PROPOSAL_CODES = {
  unknown: 'fleet_change_unknown',
  expired: 'fleet_change_expired',
  consumed: 'fleet_change_consumed',
  exhausted: 'fleet_change_refused',
} as const satisfies Record<FleetProposalRefusal['problem'], FleetCatalogRefusalCode>;

const COMMITTED: ReadonlySet<string> = new Set(['committed', 'committed-with-history-failure']);

/** Configuration and component documents are private: they name everything a runtime runs with. */
const DOCUMENT_MODE = 0o600;

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

/** The change as a view repeats it: a component's text is reported by size, never echoed back. */
function stagedChange(change: FleetAccountChange): FleetAccountChange {
  if (change.kind !== 'component.put' || change.content === undefined) return change;
  const { content: _reportedBySize, ...rest } = change;
  return rest;
}

/**
 * The runtimes a component edit lands on even when no catalogue row reads differently: a new text for
 * an instructions, settings or hooks file changes what those runtimes launch with, and the catalogue
 * never shows file text.
 */
const textUsers = (model: AccountModel, change: AccountPlanChange): ReadonlySet<string> =>
  change.kind === 'component.put' && change.content !== undefined
    ? new Set(componentUsage(model, `${change.component.kind}/${change.name}`).runtimes)
    : new Set();

// ── Authority ────────────────────────────────────────────────────────────────────────────────────

/**
 * What this caller may do to the machine, as the operator's grants decided it for this request.
 *
 * `mayApply` is `fleet.configure`, and the refusal travels with it because `false` has four different
 * remedies — `step-up-required` among them, which the caller answers with its passkey.
 *
 * AN ABSENT GOVERNANCE IS THE STRICTER READING. The served route declares a capability and so always
 * has one built — but "nobody could tell me where this caller stands" must never render as an open
 * Apply button.
 */
export function machineAuthority(governance: CallerGovernance | undefined): FleetMachineAuthority {
  if (governance === undefined) return { mayApply: false, applyRefusal: 'undetermined' };
  const configure = governance.decide({ capability: 'fleet', axis: 'configure' });
  return { mayApply: configure.allowed, applyRefusal: configure.refusal };
}

// ── The service ──────────────────────────────────────────────────────────────────────────────────

export class FleetCatalogService {
  readonly #changes: FleetProposalStore<ChangePayload, FleetAccountChange>;

  constructor(private readonly deps: FleetCatalogServiceDeps) {
    this.#changes = new FleetProposalStore<ChangePayload, FleetAccountChange>({
      now: () => deps.now(),
      mintId: () => deps.mintId(),
    });
  }

  /** `GET /v1/fleet/machine`, with what this caller may do to it. */
  async machine(governance: CallerGovernance | undefined): Promise<FleetMachineView> {
    const reading = await this.#read();
    return machineView(reading.model, await this.#facts(reading), machineAuthority(governance));
  }

  /** `GET /v1/fleet/components`. */
  async components(): Promise<FleetComponentCatalog> {
    const reading = await this.#read();
    return componentCatalog(reading.model, await this.#facts(reading));
  }

  /** `GET /v1/fleet/profiles`. */
  async profiles(): Promise<FleetLayeredProfileCatalog> {
    const reading = await this.#read();
    return profileCatalog(reading.model, await this.#facts(reading));
  }

  /** The earliest `disabled.until` still ahead on any login or runtime (ms), or `undefined` when none is. */
  /** The budget holds a publish carries, or nothing when none are known. */
  #budgetHolds(): { readonly budgetHolds?: BudgetHolds } {
    return budgetHoldsOf(this.deps);
  }

  async nextDisableExpiry(): Promise<number | undefined> {
    const { model } = await this.#read();
    return nextDisableExpiry(
      [...Object.values(model.credentials), ...Object.values(model.runtimes)].map(entry => entry.disabled),
      this.deps.now(),
    );
  }

  /** `GET /v1/fleet/runtimes`. */
  async runtimes(): Promise<FleetRuntimeCatalog> {
    const reading = await this.#read();
    return runtimeCatalog(reading.model, await this.#facts(reading));
  }

  /**
   * Publish the configuration AS IT ALREADY IS again, when what it publishes would now read differently
   * (docs/model-catalog.md): a model catalog changed — a newer one was fetched, `config/models/` was
   * edited, or this build carries a newer built-in one — so the runtimes' models, defaults and tier
   * pins move with it, and no login has to be edited. No configuration file is written, and a fleet
   * whose manifest would be identical is left exactly as it is.
   *
   * Answers what it did. A machine with no fleet yet, or one wired without catalogs, has nothing to do.
   */
  async republish(): Promise<'applied' | 'unchanged' | 'skipped'> {
    const reading = await this.#read();
    const sources = await this.#modelCatalogs();
    if (reading.format === 'none' || sources.modelCatalogs === undefined) return 'skipped';
    let plan: FleetModelApplyPlan;
    try {
      plan = materialiseFleet({
        model: reading.model,
        layout: this.deps.layout,
        ids: (await this.deps.ids()) ?? EMPTY_RUNTIME_IDS,
        mint: () => this.deps.mint(),
        generatedAt: new Date(this.deps.now()).toISOString(),
        bodies: await this.#bodies(reading.model),
        claudeStatusline: this.deps.claudeStatusline,
        fyCommand: this.deps.fyCommand,
        harnessCommands: harnessCommandsOf(this.deps.locate),
        ...(this.deps.hostCodexHome === undefined ? {} : { hostCodexHome: this.deps.hostCodexHome }),
        acceptsAutoPermissionMode: this.deps.acceptsAutoPermissionMode,
        ...this.#budgetHolds(),
        ...sources,
      });
    } catch (error) {
      throw new FleetCatalogRefusal('fleet_change_refused', errorMessage(error));
    }
    if (
      sameManifest(plan.manifest, await this.deps.publishedManifest?.()) &&
      (await this.deps.wrappersCurrent?.(plan)) !== false
    )
      return 'unchanged';
    try {
      await this.deps.provisioner.apply(plan, []);
    } catch (error) {
      throw new FleetCatalogRefusal('fleet_change_failed', errorMessage(error));
    }
    return 'applied';
  }

  /** `POST /v1/fleet/profiles/preview`: a profile's layers before they are saved. Writes nothing. */
  async previewProfile(request: FleetProfileDraftRequest): Promise<FleetProfileDraftView> {
    const reading = await this.#read();
    return profileDraftView(reading.model, request, await this.#facts(reading));
  }

  /**
   * Stage one change: derive it, plan it, preview it, and hold it — writing nothing. A change that
   * cannot be applied is refused now rather than stored, because a proposal nobody can apply is
   * worse than a refusal nobody stored.
   */
  async propose(change: FleetAccountChange): Promise<FleetAccountChangeView> {
    const reading = await this.#read();
    const staged = await this.#stage(reading, change);
    const record = this.#proposals(() =>
      this.#changes.open({
        revision: reading.revision,
        mutation: change,
        payload: staged.payload,
        summary: staged.summary,
      }),
    );
    return this.#view(record);
  }

  /**
   * Install one verified catalog item: stage it, check the configuration has not moved, and apply it
   * in this one call. It never enters the proposal store, so `/v1/fleet/proposals` can neither stage,
   * read nor apply it — its only caller is the catalog installer, after the installer's own checks
   * (signature, digest, publisher pin, passkey, no ferret). The same `fleet.configure` decision as an
   * ordinary apply still has to come with it.
   */
  async installCatalogItem(
    change: FleetCatalogInstallChange,
    governance: CallerGovernance | undefined,
  ): Promise<{ readonly outcome: FleetAccountChangeOutcome; readonly component: unknown }> {
    if (governance === undefined) {
      throw new ApiError(403, 'this daemon cannot say whether this caller may change the fleet', 'forbidden');
    }
    // The same rules the installer applied, again, so no caller of this method can hand the executor a
    // path or a provenance the installer would not have produced.
    const checked = FleetCatalogInstallChangeSchema.safeParse(change);
    if (!checked.success)
      throw new FleetCatalogRefusal(
        'fleet_change_refused',
        checked.error.issues[0]?.message ?? 'this is not a change the catalog installer makes',
      );
    const reading = await this.#read();
    const staged = await this.#stagePlan(reading, change);
    await this.#assertCurrent({ revision: reading.revision });
    const outcome = await this.#execute({ payload: staged.payload, mutation: change });
    if (outcome.outcome === 'applied' && !COMMITTED.has(outcome.apply.outcome)) {
      const failed = outcome.apply as { readonly reason?: string };
      throw new FleetCatalogRefusal('fleet_change_failed', failed.reason ?? 'the change did not land');
    }
    // The component as the daemon holds it, taken from the model that was just written, so nothing
    // after the write has to read the configuration again.
    return {
      outcome,
      component: staged.model.components[change.component.kind === 'skills' ? 'skills' : 'mcp'][change.name],
    };
  }

  /**
   * One stored component exactly as the daemon holds it (every field, hidden environment values as
   * their real stored text), or `undefined` when there is none. It exists for the installer's
   * edited-locally hash and is never served by a route.
   */
  async storedComponent(kind: 'mcp' | 'skills', name: string): Promise<unknown> {
    return (await this.#read()).model.components[kind][name];
  }

  /** `GET /v1/fleet/proposals/:id`. */
  async read(id: string): Promise<FleetAccountChangeView> {
    return this.#view(this.#proposals(() => this.#changes.require(id)));
  }

  /**
   * Apply exactly the change that was reviewed.
   *
   * Spend, then await: two applies arriving together must not both find it pending. If it never reaches
   * the host — the configuration moved — it is put back, because nothing about the host changed.
   *
   * `freshStepUp` is the one extra rule on top of the ordinary `fleet.configure` step-up: a
   * `machine.settings` change that turns "what agents may control" back ON, for a caller this host
   * does not govern, needs a passkey proved for THIS act — mirroring minting a pairing code and
   * widening a device (`docs/grants.md`). Turning one off, and every act at the machine itself, never
   * asks for it; `agentControlWidened` is the one test, run against the model as it is RIGHT NOW,
   * never the one a stale preview was shown against.
   */
  async apply(
    id: string,
    governance: CallerGovernance | undefined,
    freshStepUp?: FreshStepUpContext,
  ): Promise<FleetAccountChangeOutcome> {
    if (governance === undefined) {
      throw new ApiError(403, 'this daemon cannot say whether this caller may change the fleet', 'forbidden');
    }
    const record = this.#proposals(() => this.#changes.consume(id));
    let widensAgentControl = false;
    try {
      const model = await this.#assertCurrent(record);
      if (record.mutation.kind === 'machine.settings') {
        widensAgentControl = agentControlWidened(model.machine.agentControl, record.mutation.agentControl);
        if (widensAgentControl && governance.governed && freshStepUp?.presentation?.freshStepUp !== true) {
          throw new FleetCatalogFreshStepUpRequired();
        }
      }
    } catch (error) {
      this.#changes.restore(record);
      throw error;
    }
    const outcome = await this.#execute(record);
    if (widensAgentControl) freshStepUp?.spend();
    return outcome;
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────────

  async #read(fresh = false): Promise<AccountDocumentReading> {
    try {
      return await this.deps.document(fresh);
    } catch (error) {
      throw new FleetCatalogRefusal(
        'fleet_catalog_unreadable',
        `this machine's fleet configuration could not be read: ${errorMessage(error)}`,
      );
    }
  }

  /** The component bodies the model names, with the documents a change is about to write in their place. */
  async #bodies(model: AccountModel, pending: readonly AccountComponentFile[] = []): Promise<ReadBodies> {
    const layout = this.deps.layout;
    const overlay = new Map(pending.map(file => [assetPath(layout, file.file), file.content]));
    const text = async (file: string): Promise<string | undefined> => {
      const path = assetPath(layout, file);
      return overlay.get(path) ?? (await this.deps.readAsset(path));
    };
    const instructions: Record<string, string> = {};
    for (const [name, component] of Object.entries(model.components.instructions)) {
      const body = await text(component.file);
      if (body !== undefined) instructions[name] = body;
    }
    const settings: Record<string, SettingsObject> = {};
    for (const [name, component] of Object.entries(model.components.settings)) {
      if (component.file === undefined) continue;
      const body = parsed(await text(component.file), SETTINGS_FORMAT[component.harness]);
      if (body !== undefined) settings[name] = body;
    }
    const hooks: Record<string, SettingsObject> = {};
    const hooksTexts: Record<string, string> = {};
    for (const [name, component] of Object.entries(model.components.hooks)) {
      if (component.file === undefined) continue;
      const raw = await text(component.file);
      const body = parsed(raw, 'json');
      if (body === undefined) continue;
      hooks[name] = body;
      hooksTexts[name] = raw as string;
    }
    const skillFrontmatter: Record<string, readonly string[]> = {};
    const items = new Set(Object.values(model.components.skills).flatMap(component => component.items));
    for (const item of [...items].toSorted()) {
      const body = await text(`${skillSourceReference(item)}/SKILL.md`);
      if (body !== undefined) skillFrontmatter[item] = skillFrontmatterKeys(body);
    }
    return { instructions, settings, hooks, skillFrontmatter, hooksTexts };
  }

  async #runningSessions(): Promise<number> {
    return countRunningSessions(await this.deps.sessionStatuses());
  }

  async #facts(reading: AccountDocumentReading, read?: ReadBodies): Promise<CatalogFacts> {
    const bodies = read ?? (await this.#bodies(reading.model));
    const missingCommands = new Set(
      Object.values(reading.model.components.mcp)
        .flatMap(component => (component.command === undefined ? [] : [component.command]))
        .filter(command => !this.deps.commandExists(command)),
    );
    return {
      format: reading.format,
      machineName: this.deps.machineName(),
      tools: { claude: this.deps.locate('claude'), codex: this.deps.locate('codex') },
      runningSessions: await this.#runningSessions(),
      runtimeIds: await this.#runtimeIds(),
      settingsBodies: bodies.settings ?? {},
      instructionBodies: bodies.instructions ?? {},
      skillFrontmatter: bodies.skillFrontmatter ?? {},
      hooksTexts: bodies.hooksTexts,
      userHome: this.deps.layout.userHome,
      missingCommands,
      credentialStatus: await this.#credentialStatus(),
      acceptsAutoPermissionMode: this.deps.acceptsAutoPermissionMode,
      lastAutoResume: (await this.deps.lastAutoResume?.()) ?? null,
      now: this.deps.now(),
      ...this.#budgetHolds(),
      ...(await this.#modelCatalogs()),
    };
  }

  /** The catalogs an apply and the runtime list read, or nothing on a machine wired without them. */
  async #modelCatalogs(): Promise<{ readonly modelCatalogs?: ModelCatalogSources }> {
    const sources = await this.deps.modelCatalogs?.();
    return sources === undefined ? {} : { modelCatalogs: sources };
  }

  /** Each runtime's id by name, from `ids.json`. A machine with none yet has no ids to report. */
  async #runtimeIds(): Promise<Readonly<Record<string, string>>> {
    const ids = await this.deps.ids();
    return Object.fromEntries(Object.entries(ids?.runtimes ?? {}).map(([name, entry]) => [name, entry.id]));
  }

  /** Each credential's status word, from the credentials surface. A list that fails shows no words. */
  async #credentialStatus(): Promise<CatalogFacts['credentialStatus']> {
    try {
      const list = await this.deps.credentials.list();
      return Object.fromEntries(list.credentials.map(credential => [credential.id, credential.status.word]));
    } catch {
      return {};
    }
  }

  // ── Staging ────────────────────────────────────────────────────────────────────────────────────

  async #stage(
    reading: AccountDocumentReading,
    change: FleetAccountChange,
  ): Promise<{ readonly payload: ChangePayload; readonly summary: string }> {
    if (isAccountPlanChange(change)) return await this.#stagePlan(reading, change);
    if (change.kind === 'credential.signout') return await this.#stageSignOut(change.id);
    return change.kind === 'setup.import'
      ? await this.#stageExecutor('setup', change, this.deps.executors?.setup)
      : await this.#stageExecutor('clone', change, this.deps.executors?.clone);
  }

  async #stagePlan(
    reading: AccountDocumentReading,
    change: AccountPlanChange,
  ): Promise<{ readonly payload: ChangePayload; readonly summary: string; readonly model: AccountModel }> {
    let ids: RuntimeIds;
    try {
      ids = (await this.deps.ids()) ?? EMPTY_RUNTIME_IDS;
    } catch (error) {
      throw new FleetCatalogRefusal(
        'fleet_change_refused',
        `the runtime ids could not be read: ${errorMessage(error)}`,
      );
    }
    const named = change.kind === 'runtime.rename' || change.kind === 'runtime.remove';
    const runtimeFacts =
      change.kind === 'credential.remove'
        ? await this.#loginRuntimeFacts(reading.model, change.id, ids)
        : named
          ? await this.#runtimeFacts(change.name, ids)
          : {};
    let edit: ReturnType<typeof deriveAccountChange>;
    try {
      edit = deriveAccountChange(reading.model, change, {
        machineName: this.deps.machineName(),
        runningSessions: await this.#runningSessions(),
        settingsBodies: (await this.#bodies(reading.model)).settings ?? {},
        ...(change.kind === 'credential.add' || change.kind === 'credential.env'
          ? { presets: (await this.deps.presets?.()) ?? [] }
          : {}),
        ...runtimeFacts,
      });
    } catch (error) {
      throw error instanceof FleetMutationRefusal
        ? new FleetCatalogRefusal('fleet_change_refused', error.message)
        : error;
    }
    const bodies = await this.#bodies(edit.model, edit.files);
    const layout = this.deps.layout;
    let plan: FleetModelApplyPlan;
    let preview: FleetApplyPreview;
    try {
      plan = materialiseFleet({
        model: edit.model,
        layout,
        // A rename moves the runtime's id to its new name in this same apply, so its config directory,
        // its sessions and its history stay exactly where they are.
        ids: change.kind === 'runtime.rename' ? renameRuntimeId(ids, change.name, change.to) : ids,
        mint: () => this.deps.mint(),
        generatedAt: new Date(this.deps.now()).toISOString(),
        bodies,
        claudeStatusline: this.deps.claudeStatusline,
        fyCommand: this.deps.fyCommand,
        harnessCommands: harnessCommandsOf(this.deps.locate),
        ...(this.deps.hostCodexHome === undefined ? {} : { hostCodexHome: this.deps.hostCodexHome }),
        ...(await this.#modelCatalogs()),
        acceptsAutoPermissionMode: this.deps.acceptsAutoPermissionMode,
        ...this.#budgetHolds(),
      });
      preview = await this.deps.provisioner.preview(plan);
    } catch (error) {
      throw error instanceof Error ? new FleetCatalogRefusal('fleet_change_refused', errorMessage(error)) : error;
    }
    const rename = change.kind === 'runtime.rename' ? { from: change.name, to: change.to } : undefined;
    const documents: FleetDocumentWrite[] = [...reading.documents(edit.model, rename)];
    for (const file of edit.files) {
      const path = assetPath(layout, file.file);
      documents.push({
        path,
        content: file.content,
        mode: DOCUMENT_MODE,
        expect: await this.deps.documentRevision(path),
      });
    }
    return {
      summary: edit.summary,
      model: edit.model,
      payload: {
        kind: 'apply',
        plan,
        documents,
        consequences: edit.consequences,
        preview: {
          kind: 'apply',
          operations: preview.operations.map(operationSummary),
          documents: documents.map(document => ({
            path: document.path,
            bytes: new TextEncoder().encode(document.content).length,
          })),
          runtimes: await this.#changedRuntimes(reading, edit.model, bodies, textUsers(reading.model, change)),
          ...(runtimeFacts.runningOn === undefined || runtimeFacts.runningOn.length === 0
            ? {}
            : { runningSessions: runtimeFacts.runningOn }),
          ...(edit.orphanedSecrets === undefined ? {} : { orphanedSecrets: edit.orphanedSecrets }),
        },
      },
    };
  }

  /**
   * What a removal or a rename of one runtime needs to know beyond the configuration: every other
   * spelling `ids.json` resolves to a runtime (so a new name never takes one), and the sessions still
   * running on this one, by any spelling a record may carry.
   */
  async #runtimeFacts(
    name: string,
    ids: RuntimeIds,
  ): Promise<Pick<AccountChangeFacts, 'runtimeReferences' | 'runningOn'>> {
    const runtimeReferences: Record<string, string> = {};
    for (const [owner, entry] of Object.entries(ids.runtimes)) {
      runtimeReferences[entry.id] = owner;
      for (const former of entry.formerNames) runtimeReferences[former] = owner;
    }
    const records = await this.deps.sessionRecords?.().catch(() => undefined);
    if (records === undefined) return { runtimeReferences };
    const entry = ids.runtimes[name];
    const runningOn = runningSessionsOn(records, {
      name,
      wrapper: joinPath(this.deps.layout.binDirectory, name),
      ...(entry === undefined ? {} : { id: entry.id, formerNames: entry.formerNames }),
    });
    return { runtimeReferences, runningOn };
  }

  /**
   * What removing a login needs to know about the runtimes on it: the ferrets running on each, by
   * runtime, so the dry run can say how many keep running whichever way each runtime is moved.
   */
  async #loginRuntimeFacts(
    model: AccountModel,
    credential: string,
    ids: RuntimeIds,
  ): Promise<Pick<AccountChangeFacts, 'runningByRuntime' | 'runningOn'>> {
    const byRuntime: Record<string, readonly FleetRunningSession[]> = {};
    for (const name of runtimesUsingCredential(model, credential)) {
      const { runningOn } = await this.#runtimeFacts(name, ids);
      if (runningOn !== undefined) byRuntime[name] = runningOn.map(session => ({ ...session, runtime: name }));
    }
    const all = Object.values(byRuntime).flat();
    return { runningByRuntime: byRuntime, ...(Object.keys(byRuntime).length === 0 ? {} : { runningOn: all }) };
  }

  /**
   * The runtimes this change adds or alters, as it would publish them: every runtime whose catalogue
   * row reads differently afterwards — its own entry, or anything its stack reaches — so an edit to a
   * component names exactly the runtimes it lands on.
   */
  async #changedRuntimes(
    reading: AccountDocumentReading,
    candidate: AccountModel,
    bodies: ReadBodies,
    textUsers: ReadonlySet<string>,
  ): Promise<Extract<FleetAccountChangePreview, { kind: 'apply' }>['runtimes']> {
    const rows = (catalog: FleetRuntimeCatalog): ReadonlyMap<string, string> =>
      new Map(catalog.runtimes.map(runtime => [runtime.name, JSON.stringify(runtime)]));
    const before = rows(runtimeCatalog(reading.model, await this.#facts(reading)));
    const after = runtimeCatalog(candidate, await this.#facts({ ...reading, model: candidate }, bodies));
    return after.runtimes
      .filter(runtime => textUsers.has(runtime.name) || before.get(runtime.name) !== JSON.stringify(runtime))
      .map(runtime => ({ name: runtime.name, harness: runtime.harness, agent: runtime.agent, launch: runtime.launch }));
  }

  async #stageSignOut(id: string): Promise<{ readonly payload: ChangePayload; readonly summary: string }> {
    let list: FleetCredentialList;
    try {
      list = await this.deps.credentials.list();
    } catch (error) {
      throw new FleetCatalogRefusal('fleet_change_refused', errorMessage(error));
    }
    const row = list.credentials.find(credential => credential.id === id);
    if (row === undefined)
      throw new FleetCatalogRefusal('fleet_change_refused', `no login ${id} exists on this machine`);
    if (!row.signOut.available) {
      throw new FleetCatalogRefusal('fleet_change_refused', `Login ${id} cannot be signed out from here.`);
    }
    return {
      summary: `Sign out of login ${id}`,
      payload: {
        kind: 'sign-out',
        // E25: the confirm card's question is the credentials surface's own sentence.
        consequences: [row.signOut.sentence],
        preview: {
          kind: 'sign-out',
          credential: id,
          runtimesAffected: row.signOut.runtimesAffected,
          signsOutTerminal: row.signOut.signsOutTerminal,
        },
      },
    };
  }

  async #stageExecutor<Change extends SetupChange | CloneChange>(
    executor: 'setup' | 'clone',
    change: Change,
    port: AccountChangeExecutor<Change> | undefined,
  ): Promise<{ readonly payload: ChangePayload; readonly summary: string }> {
    const what = executor === 'setup' ? 'Importing a setup' : 'Cloning another machine';
    if (port === undefined) {
      throw new FleetCatalogRefusal('fleet_change_refused', `${what} is not available on this machine yet.`);
    }
    const description = await port.describe(change);
    return {
      summary: executor === 'setup' ? 'Import this machine’s setup' : 'Clone another machine’s setup',
      payload: {
        kind: 'executor',
        consequences: [],
        preview: { kind: 'executor', executor, description },
        run: async () => await port.execute(change),
      },
    };
  }

  // ── Applying ───────────────────────────────────────────────────────────────────────────────────

  /** Refuse a change whose configuration moved since it was reviewed. */
  /** Refuses a change whose configuration moved since it was reviewed; otherwise answers the model
   *  AS IT IS RIGHT NOW, so `apply` never judges the fresh-step-up rule against a stale one. */
  async #assertCurrent(record: Pick<ChangeRecord, 'revision'>): Promise<AccountModel> {
    const reading = await this.#read(true);
    if (reading.revision !== record.revision) {
      throw new FleetCatalogRefusal(
        'fleet_change_stale',
        'the fleet configuration changed on this machine after this change was previewed; review it again',
      );
    }
    return reading.model;
  }

  async #execute(record: {
    readonly payload: ChangePayload;
    readonly mutation: FleetAccountChange | FleetCatalogInstallChange;
  }): Promise<FleetAccountChangeOutcome> {
    const payload = record.payload;
    if (payload.kind === 'apply') {
      try {
        const result = await this.deps.provisioner.apply(payload.plan, payload.documents);
        if (record.mutation.kind === 'runtime.rename') await this.#renameSessions(record.mutation);
        return { outcome: 'applied', apply: { outcome: 'committed', result: applyResultSummary(result) } };
      } catch (error) {
        if (error instanceof FleetApplyFailureError) return { outcome: 'applied', apply: applyFailureSummary(error) };
        throw new FleetCatalogRefusal('fleet_change_failed', errorMessage(error));
      }
    }
    if (payload.kind === 'sign-out') {
      let outcome: FleetCredentialSignOutOutcome;
      try {
        // U13's executor: the harness's own logout against the one store. Never re-implemented here.
        outcome = await this.deps.credentials.signOut(payload.preview.credential);
      } catch (error) {
        throw error instanceof FleetCredentialRefusal
          ? new FleetCatalogRefusal('fleet_change_failed', error.message)
          : error;
      }
      return outcome.outcome === 'signed-out'
        ? { outcome: 'signed-out', credential: outcome.credential }
        : { outcome: 'sign-out-failed', reason: outcome.reason, credential: outcome.credential };
    }
    return { outcome: 'executed', executor: payload.preview.executor, summary: await payload.run() };
  }

  /**
   * Re-point the session records on a renamed runtime, once the rename is on disk. Best effort, and
   * never a reason to report the rename as failed: a record left on the old name still resolves
   * through `ids.json`, and the next rename or restart finds it the same way.
   */
  async #renameSessions(change: Extract<FleetAccountChange, { kind: 'runtime.rename' }>): Promise<void> {
    const bin = this.deps.layout.binDirectory;
    await this.deps
      .renameSessions?.({
        from: change.name,
        to: change.to,
        fromWrapper: joinPath(bin, change.name),
        toWrapper: joinPath(bin, change.to),
      })
      .catch(() => 0);
  }

  // ── Views ──────────────────────────────────────────────────────────────────────────────────────

  #proposals<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      throw error instanceof FleetProposalRefusal
        ? new FleetCatalogRefusal(PROPOSAL_CODES[error.problem], error.message)
        : error;
    }
  }

  #view(record: ChangeRecord): FleetAccountChangeView {
    const view = redactProposal(record, payload => payload);
    return {
      id: view.id,
      revision: view.revision,
      change: stagedChange(view.mutation),
      summary: view.summary,
      consequences: [...view.preview.consequences],
      expiresAt: view.expiresAt,
      state: view.state,
      preview: view.preview.preview,
    };
  }
}
