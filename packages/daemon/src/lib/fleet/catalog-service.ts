/**
 * The account model's catalogue and its reviewed changes, as this daemon serves them
 * (docs/design/account-model.md §4, §7): what the machine has, read fresh on every call, and every
 * change a person can make to it, staged as a preview and applied in a second, explicit step.
 *
 * ## Reads never ask the switch
 *
 * The machine, components, profile-stack and runtime reads answer whichever document the machine has:
 * a version-2 configuration as it is, a version-1 one through the in-memory conversion (§10.4), and no
 * configuration at all as an empty model. Nothing is launched and no provider is called; the only
 * facts outside the configuration are the component files it names, the harness commands this
 * daemon's one rule resolves, and the credential statuses the credentials surface already knows.
 *
 * ## Every write asks the switch, then the format
 *
 * A change is refused while `accountModel.enabled` is off ({@link accountModelWritesRefusal}), and on a
 * version-1 machine, whose every other reader would fail on the version-2 document this writes. Both
 * are asked when the change is staged AND again when it is applied, because either can change in the
 * fifteen minutes a staged change lives.
 *
 * ## One change, one plan, one boundary
 *
 * A caller names ONE intent; {@link deriveAccountChange} derives the next model from the current one.
 * The model is materialised by the fleet library into the exact plan the provisioner previews, and the
 * apply writes `config.yaml`, every component document the change carries, and that plan inside the
 * provisioner's single rollback boundary — so a machine is never left declaring a runtime whose
 * directory was never made, or a component whose file was never written. Each document carries the
 * digest it was composed against, and the provisioner refuses one that moved.
 *
 * Sign-out, first-run import and clone are not configuration edits: they run their own executors
 * (U13's sign-out, and the setup and clone ports U15 fills), reviewed and confirmed the same way.
 *
 * ## Governed like every fleet change
 *
 * Who may stage or apply is the route's `fleet.configure`. A caller the boundary says owes a
 * per-change confirmation gives the operator password with the apply, and the order is the old
 * fleet mount's: read the change, confirm, consume synchronously, check it is still current, then
 * act — restoring it only while it is certain nothing was attempted.
 */
import {
  type AccountModel,
  type ClaudeStatuslineCommand,
  expandAssetPath,
  FleetApplyFailureError,
  type FleetApplyPreview,
  type FleetDocumentWrite,
  type FleetLayout,
  type FleetModelApplyPlan,
  type FleetProvisioner,
  type HarnessKind,
  type MaterialiseBodies,
  materialiseFleet,
  parseSettings,
  type RuntimeIds,
  EMPTY_RUNTIME_IDS,
  type SettingsObject,
  skillFrontmatterKeys,
  skillSourceReference,
} from '@ferretry/fleet';
import { renderConfig } from '@ferretry/fleet/adapters';
import type {
  FleetAccountChange,
  FleetAccountChangeOutcome,
  FleetAccountChangePreview,
  FleetAccountChangeView,
  FleetCatalogFormat,
  FleetCatalogRefusalCode,
  FleetComponentCatalog,
  FleetCredentialList,
  FleetLayeredProfileCatalog,
  FleetMachineView,
  FleetProposalApplyRequest,
  FleetRuntimeCatalog,
  SessionStatus,
} from '@ferretry/protocol';
import type { CallerGovernance, ChangeConfirmation } from '../api/capability.ts';
import { ApiError } from '../api/error.ts';
import {
  type CatalogFacts,
  componentCatalog,
  machineView,
  profileCatalog,
  runtimeCatalog,
} from './catalog.ts';
import { FleetCredentialRefusal, type FleetCredentialSignOutOutcome } from './credentials-service.ts';
import {
  type AccountComponentFile,
  type AccountPlanChange,
  deriveAccountChange,
  FleetMutationRefusal,
  isAccountPlanChange,
} from './mutations.ts';
import { FleetProposalRefusal, type FleetProposalRecord, FleetProposalStore, redactProposal } from './proposals.ts';
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

/** What a write says on a machine that still has the old account format. */
export const VERSION_ONE_WRITES_SENTENCE =
  'This machine still uses the old account format, so its setup cannot be changed here until it is migrated.';

// ── Ports ────────────────────────────────────────────────────────────────────────────────────────

/** The machine's configuration as one read: its format, its model, and the digest it was read at. */
export interface AccountDocumentReading {
  readonly format: FleetCatalogFormat;
  /** The model itself, the version-1 conversion's, or an empty one when there is no configuration. */
  readonly model: AccountModel;
  /** sha256 of the raw file, or `ABSENT_DOCUMENT_REVISION` when there is none. */
  readonly revision: string;
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
  /** The configuration, read fresh. Throws when it exists and cannot be read. */
  document(): Promise<AccountDocumentReading>;
  /** One file a component names, by absolute path. `undefined` when it is absent or cannot be read. */
  readAsset(path: string): Promise<string | undefined>;
  /** What a document is now: its sha256, or `ABSENT_DOCUMENT_REVISION`. */
  documentRevision(path: string): Promise<string>;
  /** `ids.json`; `undefined` when there is none yet. */
  ids(): Promise<RuntimeIds | undefined>;
  /** Why account-model writes are refused right now ({@link accountModelWritesRefusal}), read fresh. */
  writesRefusal(): Promise<string | undefined>;
  /** The harness command this daemon's one rule resolves. Nothing is launched to find it. */
  locate(harness: HarnessKind): string | undefined;
  /** Whether an MCP server's command resolves on this machine (K6). */
  commandExists(command: string): boolean;
  /** Every session's status, to count the running ones (E20, E32). */
  sessionStatuses(): Promise<readonly SessionStatus[]>;
  machineName(): string;
  /** The credentials surface: its list for status words and sign-out sentences, its sign-out executor. */
  readonly credentials: {
    list(): Promise<FleetCredentialList>;
    signOut(id: string): Promise<FleetCredentialSignOutOutcome>;
  };
  /** Proves the operator password for ONE change: the same closure every confirmed act takes. */
  confirmChange(password: string): Promise<ChangeConfirmation>;
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
  /** The first-run import and clone executors. Absent means "not available on this machine yet". */
  readonly executors?: {
    readonly setup?: AccountChangeExecutor<SetupChange>;
    readonly clone?: AccountChangeExecutor<CloneChange>;
  };
}

// ── Running sessions ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a session with this status is still running, keyed exhaustively so a new status cannot
 * fall silently into either answer. A session that has ended — or whose kill failed and is being
 * reaped — keeps no setup a change could leave behind.
 */
const SESSION_RUNNING: { readonly [K in SessionStatus]: boolean } = {
  created: true,
  starting: true,
  running: true,
  thinking: true,
  tool_running: true,
  awaiting_question: true,
  awaiting_user: true,
  interrupted: true,
  rate_limited: true,
  retrying: true,
  waiting: true,
  kill_failed: false,
  completed: false,
  failed: false,
  stalled: false,
  stopped: false,
};

/** How many of these sessions are still running. */
export const countRunningSessions = (statuses: readonly SessionStatus[]): number =>
  statuses.filter(status => SESSION_RUNNING[status]).length;

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
      readonly consequences: readonly string[];
    };

type ChangeRecord = FleetProposalRecord<ChangePayload, FleetAccountChange>;

const PROPOSAL_CODES = {
  unknown: 'fleet_change_unknown',
  expired: 'fleet_change_expired',
  consumed: 'fleet_change_consumed',
  exhausted: 'fleet_change_refused',
} as const satisfies Record<FleetProposalRefusal['problem'], FleetCatalogRefusalCode>;

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

// ── The service ──────────────────────────────────────────────────────────────────────────────────

export class FleetCatalogService {
  readonly #changes: FleetProposalStore<ChangePayload, FleetAccountChange>;

  constructor(private readonly deps: FleetCatalogServiceDeps) {
    this.#changes = new FleetProposalStore<ChangePayload, FleetAccountChange>({
      now: () => deps.now(),
      mintId: () => deps.mintId(),
    });
  }

  /** `GET /v1/fleet/machine`. */
  async machine(): Promise<FleetMachineView> {
    const reading = await this.#read();
    return machineView(reading.model, await this.#facts(reading));
  }

  /** `GET /v1/fleet/components`. */
  async components(): Promise<FleetComponentCatalog> {
    const reading = await this.#read();
    return componentCatalog(reading.model, await this.#facts(reading));
  }

  /** `GET /v1/fleet/profile-stacks`. */
  async profiles(): Promise<FleetLayeredProfileCatalog> {
    const reading = await this.#read();
    return profileCatalog(reading.model, await this.#facts(reading));
  }

  /** `GET /v1/fleet/runtimes`. */
  async runtimes(): Promise<FleetRuntimeCatalog> {
    const reading = await this.#read();
    return runtimeCatalog(reading.model, await this.#facts(reading));
  }

  /**
   * Stage one change: derive it, plan it, preview it, and hold it — writing nothing. A change that
   * cannot be applied is refused now rather than stored, because a proposal nobody can apply is
   * worse than a refusal nobody stored.
   */
  async propose(change: FleetAccountChange): Promise<FleetAccountChangeView> {
    const reading = await this.#writable();
    const staged = await this.#stage(reading, change);
    const record = this.#proposals(() =>
      this.#changes.open({
        revision: reading.revision,
        mutation: change,
        assetEdits: [],
        assetRevisions: [],
        payload: staged.payload,
        summary: staged.summary,
      }),
    );
    return this.#view(record);
  }

  /** `GET /v1/fleet/changes/:id`. */
  async read(id: string): Promise<FleetAccountChangeView> {
    return this.#view(this.#proposals(() => this.#changes.require(id)));
  }

  /**
   * Apply exactly the change that was reviewed.
   *
   * Confirm, then spend, then await: a wrong password must not burn a change the caller was entitled
   * to apply, and two applies arriving together must not both find it pending. If it never reaches
   * the host — the switch went off, the configuration moved — it is put back, because nothing about
   * the host changed.
   */
  async apply(
    id: string,
    request: FleetProposalApplyRequest,
    governance: CallerGovernance | undefined,
  ): Promise<FleetAccountChangeOutcome> {
    if (governance === undefined) {
      throw new ApiError(403, 'this daemon cannot say whether this caller may change the fleet', 'forbidden');
    }
    this.#proposals(() => this.#changes.require(id));
    if (governance.confirmChange) await this.#confirm(id, request.operatorPassword);
    const record = this.#proposals(() => this.#changes.consume(id));
    try {
      await this.#assertCurrent(record);
    } catch (error) {
      this.#changes.restore(record);
      throw error;
    }
    return await this.#execute(record);
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────────

  async #read(): Promise<AccountDocumentReading> {
    try {
      return await this.deps.document();
    } catch (error) {
      throw new FleetCatalogRefusal(
        'fleet_catalog_unreadable',
        `this machine's fleet configuration could not be read: ${errorMessage(error)}`,
      );
    }
  }

  /** Why a change is refused on this reading, or `undefined` when it may go ahead. */
  async #changesRefusal(reading: AccountDocumentReading): Promise<string | undefined> {
    const disabled = await this.deps.writesRefusal();
    if (disabled !== undefined) return disabled;
    return reading.format === 'version-1' ? VERSION_ONE_WRITES_SENTENCE : undefined;
  }

  async #writable(): Promise<AccountDocumentReading> {
    const disabled = await this.deps.writesRefusal();
    if (disabled !== undefined) throw new FleetCatalogRefusal('fleet_change_disabled', disabled);
    const reading = await this.#read();
    if (reading.format === 'version-1') throw new FleetCatalogRefusal('fleet_change_refused', VERSION_ONE_WRITES_SENTENCE);
    return reading;
  }

  /** The component bodies the model names, with the documents a change is about to write in their place. */
  async #bodies(model: AccountModel, pending: readonly AccountComponentFile[] = []): Promise<MaterialiseBodies> {
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
    for (const [name, component] of Object.entries(model.components.hooks)) {
      if (component.file === undefined) continue;
      const body = parsed(await text(component.file), 'json');
      if (body !== undefined) hooks[name] = body;
    }
    const skillFrontmatter: Record<string, readonly string[]> = {};
    const items = new Set(Object.values(model.components.skills).flatMap(component => component.items));
    for (const item of [...items].toSorted()) {
      const body = await text(`${skillSourceReference(item)}/SKILL.md`);
      if (body !== undefined) skillFrontmatter[item] = skillFrontmatterKeys(body);
    }
    return { instructions, settings, hooks, skillFrontmatter };
  }

  async #runningSessions(): Promise<number> {
    return countRunningSessions(await this.deps.sessionStatuses());
  }

  async #facts(reading: AccountDocumentReading, read?: MaterialiseBodies): Promise<CatalogFacts> {
    const bodies = read ?? (await this.#bodies(reading.model));
    const missingCommands = new Set(
      Object.values(reading.model.components.mcp)
        .flatMap(component => (component.command === undefined ? [] : [component.command]))
        .filter(command => !this.deps.commandExists(command)),
    );
    const changesRefusal = await this.#changesRefusal(reading);
    return {
      format: reading.format,
      machineName: this.deps.machineName(),
      tools: { claude: this.deps.locate('claude'), codex: this.deps.locate('codex') },
      runningSessions: await this.#runningSessions(),
      ...(changesRefusal === undefined ? {} : { changesRefusal }),
      settingsBodies: bodies.settings ?? {},
      instructionBodies: bodies.instructions ?? {},
      skillFrontmatter: bodies.skillFrontmatter ?? {},
      missingCommands,
      credentialStatus: await this.#credentialStatus(),
      acceptsAutoPermissionMode: this.deps.acceptsAutoPermissionMode,
    };
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
    if (change.kind === 'credential.signout') return await this.#stageSignOut(change.id);
    if (change.kind === 'setup.import') return await this.#stageExecutor('setup', change, this.deps.executors?.setup);
    if (change.kind === 'clone.import') return await this.#stageExecutor('clone', change, this.deps.executors?.clone);
    if (!isAccountPlanChange(change)) throw new FleetCatalogRefusal('fleet_change_refused', 'this change cannot be staged');
    return await this.#stagePlan(reading, change);
  }

  async #stagePlan(
    reading: AccountDocumentReading,
    change: AccountPlanChange,
  ): Promise<{ readonly payload: ChangePayload; readonly summary: string }> {
    let edit: ReturnType<typeof deriveAccountChange>;
    try {
      edit = deriveAccountChange(reading.model, change, {
        machineName: this.deps.machineName(),
        runningSessions: await this.#runningSessions(),
      });
    } catch (error) {
      if (error instanceof FleetMutationRefusal) throw new FleetCatalogRefusal('fleet_change_refused', error.message);
      throw error;
    }
    const bodies = await this.#bodies(edit.model, edit.files);
    const layout = this.deps.layout;
    let plan: FleetModelApplyPlan;
    let preview: FleetApplyPreview;
    try {
      plan = materialiseFleet({
        model: edit.model,
        layout,
        ids: (await this.deps.ids()) ?? EMPTY_RUNTIME_IDS,
        mint: () => this.deps.mint(),
        generatedAt: new Date(this.deps.now()).toISOString(),
        bodies,
        claudeStatusline: this.deps.claudeStatusline,
        fyCommand: this.deps.fyCommand,
        ...(this.deps.hostCodexHome === undefined ? {} : { hostCodexHome: this.deps.hostCodexHome }),
        acceptsAutoPermissionMode: this.deps.acceptsAutoPermissionMode,
      });
      preview = await this.deps.provisioner.preview(plan);
    } catch (error) {
      if (error instanceof Error) {
        throw new FleetCatalogRefusal('fleet_change_refused', errorMessage(error));
      }
      throw error;
    }
    const documents: FleetDocumentWrite[] = [
      {
        path: `${layout.fleetDirectory}/config.yaml`,
        content: renderConfig(edit.model),
        mode: DOCUMENT_MODE,
        expect: reading.revision,
      },
    ];
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
          runtimes: await this.#changedRuntimes(reading, edit.model, bodies),
        },
      },
    };
  }

  /**
   * The runtimes this change adds or alters, as it would publish them: every runtime whose catalogue
   * row reads differently afterwards — its own entry, or anything its stack reaches — so an edit to a
   * component names exactly the runtimes it lands on.
   */
  async #changedRuntimes(
    reading: AccountDocumentReading,
    candidate: AccountModel,
    bodies: MaterialiseBodies,
  ): Promise<Extract<FleetAccountChangePreview, { kind: 'apply' }>['runtimes']> {
    const rows = (catalog: FleetRuntimeCatalog): ReadonlyMap<string, string> =>
      new Map(catalog.runtimes.map(runtime => [runtime.name, JSON.stringify(runtime)]));
    const before = rows(runtimeCatalog(reading.model, await this.#facts(reading)));
    const after = runtimeCatalog(candidate, await this.#facts({ ...reading, model: candidate }, bodies));
    return after.runtimes
      .filter(runtime => before.get(runtime.name) !== JSON.stringify(runtime))
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
    if (row === undefined) throw new FleetCatalogRefusal('fleet_change_refused', `no login ${id} exists on this machine`);
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
      payload: { kind: 'executor', consequences: [], preview: { kind: 'executor', executor, description } },
    };
  }

  // ── Applying ───────────────────────────────────────────────────────────────────────────────────

  async #confirm(id: string, password: string | undefined): Promise<void> {
    const refuse = (message: string): never => {
      throw new FleetCatalogRefusal('fleet_change_unauthorized', message);
    };
    if (password === undefined) {
      refuse(`applying change "${id}" from off this machine needs its operator password, entered against this change`);
    }
    const outcome = await this.deps.confirmChange(password as string);
    if (outcome.kind === 'confirmed') return;
    if (outcome.reason === 'rate-limited') {
      refuse(
        `too many wrong operator passwords have been tried on this machine, so it is not checking any more for now; change "${id}" was not applied`,
      );
    }
    if (outcome.reason === 'no-password') {
      refuse(`this machine has no operator password, so change "${id}" could not be confirmed; review it again`);
    }
    refuse(`that is not this machine's operator password, so change "${id}" was not applied and is still open`);
  }

  /** Refuse a change whose machine moved since it was reviewed: the switch, or the configuration. */
  async #assertCurrent(record: ChangeRecord): Promise<void> {
    const disabled = await this.deps.writesRefusal();
    if (disabled !== undefined) throw new FleetCatalogRefusal('fleet_change_disabled', disabled);
    if ((await this.#read()).revision !== record.revision) {
      throw new FleetCatalogRefusal(
        'fleet_change_stale',
        'the fleet configuration changed on this machine after this change was previewed; review it again',
      );
    }
  }

  async #execute(record: ChangeRecord): Promise<FleetAccountChangeOutcome> {
    const payload = record.payload;
    const change = record.mutation;
    if (payload.kind === 'apply') {
      try {
        const result = await this.deps.provisioner.apply(payload.plan, payload.documents);
        return { outcome: 'applied', apply: { outcome: 'committed', result: applyResultSummary(result) } };
      } catch (error) {
        if (error instanceof FleetApplyFailureError) return { outcome: 'applied', apply: applyFailureSummary(error) };
        throw new FleetCatalogRefusal('fleet_change_failed', errorMessage(error));
      }
    }
    if (payload.kind === 'sign-out' && change.kind === 'credential.signout') {
      try {
        const outcome = await this.deps.credentials.signOut(change.id);
        return outcome.outcome === 'signed-out'
          ? { outcome: 'signed-out', credential: outcome.credential }
          : { outcome: 'sign-out-failed', reason: outcome.reason, credential: outcome.credential };
      } catch (error) {
        if (error instanceof FleetCredentialRefusal) throw new FleetCatalogRefusal('fleet_change_failed', error.message);
        throw error;
      }
    }
    if (change.kind === 'setup.import' && this.deps.executors?.setup !== undefined) {
      return { outcome: 'executed', executor: 'setup', summary: await this.deps.executors.setup.execute(change) };
    }
    if (change.kind === 'clone.import' && this.deps.executors?.clone !== undefined) {
      return { outcome: 'executed', executor: 'clone', summary: await this.deps.executors.clone.execute(change) };
    }
    throw new FleetCatalogRefusal('fleet_change_failed', 'this change has nothing to run it on this machine');
  }

  // ── Views ──────────────────────────────────────────────────────────────────────────────────────

  #proposals<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof FleetProposalRefusal) {
        throw new FleetCatalogRefusal(PROPOSAL_CODES[error.problem], error.message);
      }
      throw error;
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
