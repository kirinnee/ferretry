/**
 * A machine's setup, as this daemon serves it (docs/design/account-model.md §4.3, §4.7, §7, §10.3):
 * the first-run scan and import, Import again, installing a harness tool, the Clone export and the
 * Clone import, and migrating a machine that still has the old account format.
 *
 * ## The import and the clone are reviewed changes
 *
 * Neither has a route of its own that writes. Each is an EXECUTOR the catalogue's change flow runs
 * (`catalog-service.ts`): `POST /v1/fleet/changes` with `setup.import` or `clone.import` stages it and
 * {@link FleetSetupService.executors} describes what applying would do; the apply runs it, after the
 * same switch, format, revision and operator-password checks every change gets. What is described is
 * what runs: the plan is composed again at the apply and refused when it no longer matches the one the
 * person reviewed, because the host's own setup — or the target machine — can move in between.
 *
 * ## One apply boundary
 *
 * An import or a clone writes `config.yaml`, every component document it brings, and the plan the
 * fleet library materialises from the new model, inside the provisioner's single rollback boundary —
 * the same boundary every other change uses. Secret values an import found go into the secret store
 * first: a reference with no value only refuses a launch, while a value with no reference is harmless.
 *
 * ## Every write asks the switch
 *
 * The import, the clone and the migration are refused while `accountModel.enabled` is off, through the
 * catalogue's own check for the two executors and {@link FleetSetupServiceDeps.writesRefusal} for the
 * migration and the first run at boot. The scan, the export and the migration's dry run are reads and
 * answer either way. Installing a tool writes no configuration, so it asks only for the operator
 * password.
 *
 * ## Nothing here leaves on a timer
 *
 * The scan reads files and resolves commands; a package manager starts only inside an explicit install
 * request; nothing is launched to find anything out, and no provider is called.
 */
import {
  type AccountModel,
  type ClonePlan,
  CloneRefusal,
  cloneSources,
  describeClone,
  expandAssetPath,
  FleetApplyFailureError,
  type FleetDocumentWrite,
  type FleetModelApplyPlan,
  HARNESS_DISPLAY_NAMES,
  type HarnessKind,
  type HostHarnessScan,
  type ImportPlan,
  type ImportRecord,
  isRuntimeName,
  type LayerReferenceText,
  type MaterialiseBodies,
  materialiseFleet,
  mergeImport,
  mergeImportRecord,
  parseCloneBundle,
  parseSettings,
  planClone,
  planImport,
  EMPTY_RUNTIME_IDS,
  type SettingsObject,
  skillFrontmatterKeys,
  skillSourceReference,
  buildCloneBundle,
  freeName,
} from '@ferretry/fleet';
import { renderConfig } from '@ferretry/fleet/adapters';
import type {
  FleetAccountChange,
  FleetCatalogAct,
  FleetCloneBundle,
  FleetCloneFile,
  FleetMigrationApplyRequest,
  FleetMigrationOutcome,
  FleetMigrationView,
  FleetSetupRefusalCode,
  FleetSetupScan,
  FleetSetupTool,
  FleetToolInstallRequest,
  FleetToolInstallResult,
} from '@ferretry/protocol';
import type { CallerGovernance } from '../api/capability.ts';
import { type AccountChangeExecutor, FleetCatalogRefusal, type FleetCatalogServiceDeps } from './catalog-service.ts';
import { type ToolInstallOutcome, type ToolInstallPreview, ToolInstallRefusal } from './tool-install.ts';

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

/** Every refusal the setup routes answer with, so a client branches on cause rather than on prose. */
export class FleetSetupRefusal extends Error {
  constructor(
    readonly code: FleetSetupRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'FleetSetupRefusal';
  }
}

// ── Ports ────────────────────────────────────────────────────────────────────────────────────────

/** One file of a folder, relative to that folder, as text. */
export interface FolderFile {
  readonly path: string;
  readonly content: string;
}

/** A folder read as text, with every file that could not be carried and why. */
export interface FolderReading {
  readonly files: readonly FolderFile[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

/** What the migration executor offers here (`@ferretry/fleet/adapters` `FleetMigration`). */
export interface SetupMigration {
  status(): Promise<
    | { readonly kind: 'version-1' }
    | { readonly kind: 'version-2' }
    | { readonly kind: 'in-progress'; readonly digest: string; readonly startedAt: number }
    | { readonly kind: 'no-fleet' }
  >;
  dryRun(): Promise<{
    readonly plan: { readonly digest: string; readonly blockers: readonly { readonly message: string }[] };
    readonly lines: readonly string[];
  }>;
  migrate(approve: string): Promise<
    | {
        readonly kind: 'migrated';
        readonly resumed: boolean;
        readonly report: {
          readonly credentials: readonly {
            readonly id: string;
            readonly harness: string;
            readonly store: string;
            readonly retired: readonly string[];
          }[];
          readonly runtimes: readonly { readonly name: string; readonly formerName?: string | undefined }[];
        };
      }
    | { readonly kind: 'refused'; readonly reasons: readonly string[] }
    | { readonly kind: 'rolled-back'; readonly reason: string; readonly unrestored: readonly string[] }
  >;
}

/** How a migrated model is applied: the same materialise-and-apply every change goes through. */
export interface SetupModelApply {
  apply(model: AccountModel): Promise<void>;
}

/** The catalogue's collaborators this service shares, so both read and write one machine the same way. */
export type SetupCatalogDeps = Pick<
  FleetCatalogServiceDeps,
  | 'document'
  | 'readAsset'
  | 'documentRevision'
  | 'ids'
  | 'writesRefusal'
  | 'locate'
  | 'machineName'
  | 'credentials'
  | 'confirmChange'
  | 'provisioner'
  | 'layout'
  | 'mint'
  | 'now'
  | 'claudeStatusline'
  | 'fyCommand'
  | 'hostCodexHome'
  | 'acceptsAutoPermissionMode'
>;

export interface FleetSetupServiceDeps {
  readonly catalog: SetupCatalogDeps;
  /** Read this machine's own Claude Code and Codex setup. Reads files and resolves commands only. */
  scan(): Promise<readonly HostHarnessScan[]>;
  /** The tool installer (`tool-install.ts`): its plans, and an install a person asked for. */
  readonly tools: {
    plans(harnesses: readonly HarnessKind[]): readonly ToolInstallPreview[];
    install(request: FleetToolInstallRequest, governance: CallerGovernance | undefined): Promise<readonly ToolInstallOutcome[]>;
  };
  /** The secret store's management side: names in, values in, never a value out. */
  readonly secrets: {
    names(): Promise<readonly string[]>;
    put(name: string, value: string): Promise<void>;
  };
  /** One folder, read as text: a host skill folder, or a folder of the asset tree. */
  readFolder(path: string): Promise<FolderReading>;
  /** The skill items the asset tree's store already holds. */
  skillItems(): Promise<readonly string[]>;
  /** The migration executor, bound to the apply this service owns. Absent when it cannot be built here. */
  migration?(apply: SetupModelApply): SetupMigration;
  /** A content digest (sha256). */
  digest(text: string): string;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────

/** Where the import record lives, beside `config.yaml`: what each import made and from what. */
export const IMPORT_RECORD_FILE = 'setup/import.json';

/**
 * The most document text one Clone bundle carries. The bundle travels back as a change body, which
 * has its own ceiling, so a larger setup is copied without the documents that do not fit and says so.
 */
export const CLONE_BUNDLE_MAX_BYTES = 384 * 1024;

const DOCUMENT_MODE = 0o600;
const HARNESSES: readonly HarnessKind[] = ['claude', 'codex'];
const SETTINGS_FORMAT = { claude: 'json', codex: 'toml' } as const satisfies Record<HarnessKind, 'json' | 'toml'>;

type SetupChange = Extract<FleetAccountChange, { kind: 'setup.import' }>;
type CloneChange = Extract<FleetAccountChange, { kind: 'clone.import' }>;

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The import record, or none when what is stored cannot be read: then nothing is ever offered as an update. */
export function parseImportRecord(text: string | undefined): ImportRecord | undefined {
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.components)) return undefined;
  const components: Record<string, { sources: string[]; digest: string }> = {};
  for (const [reference, entry] of Object.entries(raw.components)) {
    if (!isRecord(entry) || typeof entry.digest !== 'string' || !Array.isArray(entry.sources)) continue;
    components[reference] = { sources: entry.sources.filter(source => typeof source === 'string'), digest: entry.digest };
  }
  return {
    version: 1,
    components,
    ...(typeof raw.profile === 'string' ? { profile: raw.profile } : {}),
  };
}

// ── The first run at boot ────────────────────────────────────────────────────────────────────────

/**
 * Which first run a booting daemon gives a host. While the account model is switched off, today's
 * first run (the version-1 scaffold and its credential seed) is the released behaviour; once it is on,
 * the version-2 import replaces it, so the two never both run. The operator's opt-out wins over both.
 */
export type BootFirstRunChoice = 'version-1' | 'version-2' | 'none';

export function bootFirstRunChoice(input: {
  readonly prepareDefaults: boolean;
  readonly accountModelEnabled: boolean;
}): BootFirstRunChoice {
  if (!input.prepareDefaults) return 'none';
  return input.accountModelEnabled ? 'version-2' : 'version-1';
}

/** How the version-2 first run at boot ended. Every ending is a value: a boot never refuses over it. */
export type BootFirstRun =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'imported'; readonly summary: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** What a boot says about its version-2 first run. Built from the verdict, so no value can reach it. */
export function bootFirstRunSentence(result: BootFirstRun): string {
  if (result.kind === 'imported') return `first run: ${result.summary}`;
  if (result.kind === 'skipped') return `first run: nothing was imported, because ${lowerFirst(result.reason)}`;
  return `first run: importing this machine's own setup failed, so it has no runtimes yet: ${result.reason}`;
}

const lowerFirst = (text: string): string => (text === '' ? text : `${text[0]?.toLowerCase() ?? ''}${text.slice(1)}`);

// ── What a staged import or clone holds ──────────────────────────────────────────────────────────

interface Composed {
  readonly model: AccountModel;
  readonly documents: readonly FleetDocumentWrite[];
  /** Values to store before the apply. Never in a description, a digest or a log. */
  readonly secrets: readonly { readonly name: string; readonly value: string }[];
  readonly lines: readonly string[];
  readonly summary: string;
  /** What the person reviewed, so the apply runs that and nothing else. Holds no value. */
  readonly fingerprint: string;
}

// ── The service ──────────────────────────────────────────────────────────────────────────────────

export class FleetSetupService {
  /** The fingerprint each staged change was described with, keyed by the staged change itself. */
  readonly #described = new WeakMap<object, string>();
  readonly #migration: SetupMigration | undefined;
  #migrating = false;

  constructor(private readonly deps: FleetSetupServiceDeps) {
    this.#migration = deps.migration?.({ apply: async model => await this.#applyModel(model, []) });
  }

  // ── Scan ───────────────────────────────────────────────────────────────────────────────────────

  /** `GET /v1/fleet/setup/scan`: what the first run and Import again would find. No value of anything. */
  async scan(): Promise<FleetSetupScan> {
    const catalog = this.deps.catalog;
    const reading = await this.#read();
    const scans = await this.#scans();
    const plan = planImport(scans, {
      ...(reading.format === 'none' ? {} : { existing: reading.model }),
      ...(await this.#recordOption()),
      digest: text => this.deps.digest(text),
    });
    const refusal = await this.#importRefusal(reading.format);
    return {
      machine: catalog.machineName(),
      format: reading.format,
      tools: this.#tools(),
      harnesses: plan.preview.harnesses.map(harness => ({
        harness: harness.harness,
        installed: harness.installed,
        account: { ...harness.account },
        ...(harness.instructions === undefined ? {} : { instructions: { ...harness.instructions } }),
        ...(harness.settings === undefined ? {} : { settings: { ...harness.settings } }),
        mcpServers: [...harness.mcpServers],
        skills: [...harness.skills],
        secretKeys: [...harness.secretKeys],
        missingCommands: [...harness.missingCommands],
        problems: [...harness.problems],
      })),
      ...(plan.preview.instructionsIdentical === undefined
        ? {}
        : { instructionsIdentical: plan.preview.instructionsIdentical }),
      runtimes: this.#runtimesOf(plan, reading.model).map(entry => ({ ...entry })),
      updates: plan.updates.map(update => ({ reference: update.reference, sources: [...update.sources] })),
      duplicates: plan.duplicates.map(duplicate => ({ ...duplicate })),
      notes: plan.notes.map(note => ({ ...note })),
      importing: refusal === undefined ? { available: true } : { available: false, reason: refusal },
    };
  }

  #tools(): FleetSetupTool[] {
    return this.deps.tools.plans(HARNESSES).map(preview => {
      const label = HARNESS_DISPLAY_NAMES[preview.harness];
      if (preview.installed) return { harness: preview.harness, label, installed: true };
      const plan = preview.plan;
      return {
        harness: preview.harness,
        label,
        installed: false,
        install:
          plan.kind === 'runnable'
            ? { kind: 'runnable', command: plan.command }
            : { kind: 'no-package-manager', reason: plan.reason, manualCommand: plan.manualCommand },
      };
    });
  }

  // ── Tools ──────────────────────────────────────────────────────────────────────────────────────

  /** `POST /v1/fleet/machine/tools/install`: the installer's own refusals, in this surface's codes. */
  async installTools(
    request: FleetToolInstallRequest,
    governance: CallerGovernance | undefined,
  ): Promise<FleetToolInstallResult> {
    let outcomes: readonly ToolInstallOutcome[];
    try {
      outcomes = await this.deps.tools.install(request, governance);
    } catch (error) {
      if (!(error instanceof ToolInstallRefusal)) throw error;
      const code: FleetSetupRefusalCode =
        error.code === 'tool_install_unauthorized'
          ? 'fleet_setup_unauthorized'
          : error.code === 'tool_install_in_progress'
            ? 'fleet_setup_busy'
            : 'fleet_setup_refused';
      throw new FleetSetupRefusal(code, error.message);
    }
    // Where a tool landed is a path, and paths are not shown (§4.1 rule 8): the outcome is the word.
    return {
      outcomes: outcomes.map(outcome =>
        outcome.outcome === 'already-installed'
          ? { harness: outcome.harness, outcome: 'already-installed' }
          : outcome.outcome === 'installed'
            ? { harness: outcome.harness, outcome: 'installed', command: outcome.command }
            : { ...outcome },
      ),
    };
  }

  // ── Export ─────────────────────────────────────────────────────────────────────────────────────

  /** `GET /v1/fleet/export`: the Clone bundle. No credential, no history, no secret value. */
  async exportBundle(): Promise<FleetCloneBundle> {
    const catalog = this.deps.catalog;
    const reading = await this.#read();
    if (Object.keys(reading.model.runtimes).length === 0) {
      throw new FleetSetupRefusal(
        'fleet_setup_refused',
        `${catalog.machineName()} isn't set up yet, so there is nothing to copy from it.`,
      );
    }
    const sources = cloneSources(reading.model);
    const files: FleetCloneFile[] = [];
    const notCopied: { path: string; reason: string }[] = sources.outside.map(path => ({
      path,
      reason: "it is outside Ferretry's own files",
    }));
    let budget = CLONE_BUNDLE_MAX_BYTES;
    const carry = (path: string, content: string): void => {
      const size = bytesOf(content);
      if (size > budget) {
        notCopied.push({ path, reason: 'the setup is too large to copy in one go' });
        return;
      }
      budget -= size;
      files.push({ path, content });
    };
    const asset = (path: string): string => expandAssetPath(path, catalog.layout.userHome, catalog.layout.assetsDirectory);
    for (const path of sources.documents) {
      const content = await catalog.readAsset(asset(path));
      if (content === undefined) notCopied.push({ path, reason: 'it could not be read' });
      else carry(path, content);
    }
    for (const directory of sources.directories) {
      const folder = await this.deps.readFolder(asset(directory));
      for (const file of folder.files) carry(`${directory}/${file.path}`, file.content);
      for (const skipped of folder.skipped) notCopied.push({ path: `${directory}/${skipped.path}`, reason: skipped.reason });
    }
    return buildCloneBundle({
      model: reading.model,
      machine: catalog.machineName(),
      exportedAt: new Date(catalog.now()).toISOString(),
      emails: await this.#emails(),
      files,
      notCopied,
    });
  }

  async #emails(): Promise<Record<string, string | undefined>> {
    try {
      const list = await this.deps.catalog.credentials.list();
      return Object.fromEntries(list.credentials.map(credential => [credential.id, credential.email]));
    } catch {
      return {};
    }
  }

  // ── Migration ──────────────────────────────────────────────────────────────────────────────────

  /** `GET /v1/fleet/migration`: where this machine is, and the dry run a migration must name. */
  async migration(): Promise<FleetMigrationView> {
    const migration = this.#requireMigration();
    const status = await this.#safely(() => migration.status());
    const disabled = await this.deps.catalog.writesRefusal();
    const view = { status: status.kind };
    if (status.kind === 'in-progress') {
      return {
        ...view,
        inProgress: { digest: status.digest, startedAt: new Date(status.startedAt).toISOString() },
        migrate: disabled === undefined ? { available: true } : { available: false, reason: disabled },
      };
    }
    if (status.kind !== 'version-1') {
      return {
        ...view,
        migrate: {
          available: false,
          reason:
            status.kind === 'no-fleet'
              ? 'This machine has no setup to migrate.'
              : 'This machine already uses the new account format.',
        },
      };
    }
    const dryRun = await this.#safely(() => migration.dryRun());
    const blockers = dryRun.plan.blockers.map(blocker => blocker.message);
    const migrate: FleetCatalogAct =
      disabled !== undefined
        ? { available: false, reason: disabled }
        : blockers.length > 0
          ? { available: false, reason: blockers[0] as string }
          : { available: true };
    return { ...view, dryRun: { digest: dryRun.plan.digest, lines: [...dryRun.lines], blockers }, migrate };
  }

  /** `POST /v1/fleet/migration/apply`: migrate exactly the dry run that was shown, named by its digest. */
  async migrate(
    request: FleetMigrationApplyRequest,
    governance: CallerGovernance | undefined,
  ): Promise<FleetMigrationOutcome> {
    const migration = this.#requireMigration();
    if (governance === undefined) {
      throw new FleetSetupRefusal(
        'fleet_setup_unauthorized',
        'this daemon cannot say whether this caller may change this machine',
      );
    }
    const disabled = await this.deps.catalog.writesRefusal();
    if (disabled !== undefined) throw new FleetSetupRefusal('fleet_setup_disabled', disabled);
    if (this.#migrating) {
      throw new FleetSetupRefusal('fleet_setup_busy', 'a migration is already running on this machine');
    }
    this.#migrating = true;
    try {
      if (governance.confirmChange) await this.#confirm(request.operatorPassword, 'nothing was migrated');
      const outcome = await this.#safely(() => migration.migrate(request.digest));
      if (outcome.kind === 'refused') return { outcome: 'refused', reasons: [...outcome.reasons] };
      if (outcome.kind === 'rolled-back') {
        return { outcome: 'rolled-back', reason: outcome.reason, unrestored: [...outcome.unrestored] };
      }
      return {
        outcome: 'migrated',
        resumed: outcome.resumed,
        credentials: outcome.report.credentials.map(credential => ({
          id: credential.id,
          harness: credential.harness === 'codex' ? 'codex' : 'claude',
          store: credential.store === 'host' || credential.store === 'environment' ? credential.store : 'ferretry',
          retired: credential.retired.length,
        })),
        runtimes: outcome.report.runtimes.map(runtime => ({
          name: runtime.name,
          ...(runtime.formerName === undefined ? {} : { formerName: runtime.formerName }),
        })),
      };
    } finally {
      this.#migrating = false;
    }
  }

  #requireMigration(): SetupMigration {
    if (this.#migration === undefined) {
      throw new FleetSetupRefusal('fleet_setup_refused', 'Migrating is not available on this machine.');
    }
    return this.#migration;
  }

  async #confirm(password: string | undefined, consequence: string): Promise<void> {
    const refuse = (message: string): never => {
      throw new FleetSetupRefusal('fleet_setup_unauthorized', message);
    };
    if (password === undefined) {
      refuse("doing this from off this machine needs this machine's operator password, entered for this one change");
    }
    const outcome = await this.deps.catalog.confirmChange(password as string);
    if (outcome.kind === 'confirmed') return;
    if (outcome.reason === 'rate-limited') {
      refuse(
        `too many wrong operator passwords have been tried on this machine, so it is not checking any more for now; ${consequence}`,
      );
    }
    if (outcome.reason === 'no-password') {
      refuse(`this machine has no operator password, so this could not be confirmed; ${consequence}`);
    }
    refuse(`that is not this machine's operator password, so ${consequence}`);
  }

  // ── The executors ──────────────────────────────────────────────────────────────────────────────

  /** The first-run import and the clone, as the catalogue's change flow runs them. */
  readonly executors: {
    readonly setup: AccountChangeExecutor<SetupChange>;
    readonly clone: AccountChangeExecutor<CloneChange>;
  } = {
    setup: {
      describe: async change => await this.#describe(change, await this.#composeImport(change)),
      execute: async change => await this.#execute(change, await this.#composeImport(change)),
    },
    clone: {
      describe: async change => await this.#describe(change, await this.#composeClone(change)),
      execute: async change => await this.#execute(change, await this.#composeClone(change)),
    },
  };

  async #describe(change: object, composed: Composed): Promise<string> {
    this.#described.set(change, composed.fingerprint);
    return composed.lines.join(' ');
  }

  async #execute(change: object, composed: Composed): Promise<string> {
    if (this.#described.get(change) !== composed.fingerprint) {
      throw new FleetCatalogRefusal(
        'fleet_change_stale',
        'what this would add changed on this machine after it was previewed; review it again',
      );
    }
    for (const secret of composed.secrets) {
      try {
        await this.deps.secrets.put(secret.name, secret.value);
      } catch (error) {
        throw new FleetCatalogRefusal(
          'fleet_change_failed',
          `the secret store could not take ${secret.name}, so nothing was changed: ${errorMessage(error)}`,
        );
      }
    }
    await this.#applyModel(composed.model, composed.documents);
    return composed.summary;
  }

  // ── Import ─────────────────────────────────────────────────────────────────────────────────────

  async #composeImport(change: SetupChange): Promise<Composed> {
    const catalog = this.deps.catalog;
    const reading = await this.#read();
    const existing = reading.format === 'none' ? undefined : reading.model;
    const scans = await this.#scans();
    const installed = scans.filter(scan => scan.command !== undefined).map(scan => scan.harness);
    let existingSecrets: readonly string[];
    try {
      existingSecrets = await this.deps.secrets.names();
    } catch (error) {
      throw new FleetCatalogRefusal(
        'fleet_change_refused',
        `this machine's secret store could not be read, so nothing can be imported yet: ${errorMessage(error)}`,
      );
    }
    const raw = planImport(scans, {
      ...(change.include === undefined ? {} : { include: change.include }),
      ...(existing === undefined ? {} : { existing }),
      ...(await this.#recordOption()),
      existingSecrets,
      addDuplicates: change.addDuplicates === true ? installed : [],
      digest: text => this.deps.digest(text),
    });
    const plan = this.#named(raw, change.names ?? {}, reading.model);
    const accepted = change.acceptedUpdates ?? [];
    const offered = new Set(plan.updates.map(update => update.reference));
    const unknown = accepted.filter(reference => !offered.has(reference as LayerReferenceText));
    if (unknown.length > 0) {
      throw new FleetCatalogRefusal(
        'fleet_change_refused',
        `there is no newer version of ${unknown.join(', ')} to import; scan again to see what changed`,
      );
    }
    const updates = plan.updates.filter(update => accepted.includes(update.reference));
    const adds =
      Object.keys(plan.credentials).length +
      plan.components.length +
      Object.keys(plan.profiles).length +
      Object.keys(plan.runtimes).length +
      updates.length;
    if (adds === 0) {
      throw new FleetCatalogRefusal(
        'fleet_change_refused',
        existing === undefined ? 'Nothing was found to import.' : 'Nothing new to import.',
      );
    }
    let model: AccountModel;
    try {
      model = mergeImport(existing, plan, updates.map(update => update.reference));
    } catch (error) {
      throw new FleetCatalogRefusal(
        'fleet_change_refused',
        `importing would leave ${catalog.machineName()} with a setup it cannot read: ${errorMessage(error)}`,
      );
    }
    const assets: FleetCloneFile[] = [];
    for (const file of [...plan.files, ...updates.flatMap(update => update.files)]) {
      if (file.kind === 'write') {
        assets.push({ path: file.path, content: file.content });
        continue;
      }
      const folder = await this.deps.readFolder(file.from);
      for (const entry of folder.files) assets.push({ path: `${file.path}/${entry.path}`, content: entry.content });
    }
    const record = mergeImportRecord(plan, updates.map(update => update.reference));
    const documents = await this.#documents(reading.revision, model, assets, [
      { path: this.#recordPath(), content: `${JSON.stringify(record, null, 2)}\n` },
    ]);
    const secrets = [...plan.secrets, ...updates.flatMap(update => update.secrets)].map(secret => ({
      name: secret.name,
      value: secret.value,
    }));
    const runtimes = Object.keys(plan.runtimes).toSorted();
    const lines = [
      ...Object.entries(plan.credentials).map(([id, credential]) =>
        credential.store === 'host'
          ? `Login ${id}: shared with ${credential.harness} in your terminal — signing out in one signs out both.`
          : `Login ${id}: a new ${HARNESS_DISPLAY_NAMES[credential.harness]} login that needs sign-in.`,
      ),
      ...(plan.components.length > 0 ? [`Adds ${plural(plan.components.length, 'part')} of your setup.`] : []),
      ...updates.map(update => `Updates ${update.reference} from its changed source.`),
      ...Object.keys(plan.profiles).map(name => `Profile ${name}.`),
      ...(runtimes.length > 0 ? [`Runtimes: ${runtimes.join(', ')}.`] : []),
      ...plan.notes.map(note => note.text),
    ];
    return {
      model,
      documents,
      secrets,
      lines,
      summary:
        runtimes.length > 0
          ? `${catalog.machineName()} is ready · ${plural(runtimes.length, 'runtime')} created: ${runtimes.join(', ')}.`
          : `Imported into ${catalog.machineName()}.`,
      fingerprint: this.#fingerprint(documents, secrets.map(secret => this.deps.digest(`${secret.name}\n${secret.value}`))),
    };
  }

  /** The plan with each runtime under the name the person gave it (§4.3 step 4, E16). */
  #named(plan: ImportPlan, names: Partial<Record<HarnessKind, string>>, existing: AccountModel): ImportPlan {
    const harnessOf = (credential: string): HarnessKind | undefined =>
      plan.credentials[credential]?.harness ?? existing.credentials[credential]?.harness;
    const runtimes: Record<string, ImportPlan['runtimes'][string]> = {};
    for (const [suggested, runtime] of Object.entries(plan.runtimes)) {
      const harness = harnessOf(runtime.credential);
      const wanted = harness === undefined ? undefined : names[harness];
      if (wanted === undefined || wanted === suggested) {
        runtimes[suggested] = runtime;
        continue;
      }
      const taken = (candidate: string): boolean =>
        existing.runtimes[candidate] !== undefined || runtimes[candidate] !== undefined;
      if (!isRuntimeName(wanted)) {
        throw new FleetCatalogRefusal(
          'fleet_change_refused',
          `Use only letters, digits and dashes. Use ${freeName(suggested, taken)}?`,
        );
      }
      if (taken(wanted)) {
        throw new FleetCatalogRefusal(
          'fleet_change_refused',
          `${wanted} is already a runtime on ${this.deps.catalog.machineName()}. Use ${freeName(wanted, taken)}?`,
        );
      }
      runtimes[wanted] = runtime;
    }
    return { ...plan, runtimes };
  }

  /** The runtimes an import would create, by harness, for the naming step. */
  #runtimesOf(plan: ImportPlan, existing: AccountModel): { harness: HarnessKind; name: string; profile: string }[] {
    return Object.entries(plan.runtimes).flatMap(([name, runtime]) => {
      const harness = plan.credentials[runtime.credential]?.harness ?? existing.credentials[runtime.credential]?.harness;
      return harness === undefined ? [] : [{ harness, name, profile: runtime.profile }];
    });
  }

  // ── Clone ──────────────────────────────────────────────────────────────────────────────────────

  async #composeClone(change: CloneChange): Promise<Composed> {
    const catalog = this.deps.catalog;
    const machine = catalog.machineName();
    let bundle: FleetCloneBundle;
    let plan: ClonePlan;
    const reading = await this.#read();
    try {
      bundle = parseCloneBundle(change.bundle);
      if (bundle.machine === machine) {
        throw new CloneRefusal(`That setup was exported from ${machine} itself; pick another machine to copy from.`);
      }
      plan = planClone(reading.model, bundle, {
        mode: change.mode,
        machine,
        installed: HARNESSES.filter(harness => catalog.locate(harness) !== undefined),
        existingSkillItems: await this.deps.skillItems(),
        existingSecrets: await this.deps.secrets.names().catch(() => []),
      });
    } catch (error) {
      if (error instanceof CloneRefusal) throw new FleetCatalogRefusal('fleet_change_refused', error.message);
      throw error;
    }
    const documents = await this.#documents(reading.revision, plan.model, plan.files, []);
    const busiest = plan.slots.toSorted((left, right) => right.runtimes.length - left.runtimes.length)[0];
    return {
      model: plan.model,
      documents,
      secrets: [],
      lines: describeClone(plan, bundle, machine),
      summary: [
        `Copied ${plural(plan.copied.runtimes, 'runtime')} from ${bundle.machine}.`,
        ...(busiest === undefined || busiest.runtimes.length === 0
          ? []
          : [`Sign in once for ${plural(busiest.runtimes.length, 'runtime')}: ${busiest.email ?? busiest.label ?? busiest.id}.`]),
      ].join(' '),
      fingerprint: this.#fingerprint(documents, []),
    };
  }

  // ── Writing ────────────────────────────────────────────────────────────────────────────────────

  #recordPath(): string {
    return `${this.deps.catalog.layout.fleetDirectory}/${IMPORT_RECORD_FILE}`;
  }

  async #recordOption(): Promise<{ record?: ImportRecord }> {
    const record = parseImportRecord(await this.deps.catalog.readAsset(this.#recordPath()));
    return record === undefined ? {} : { record };
  }

  /** `config.yaml`, then the asset documents, then any document by absolute path — each with what it expects. */
  async #documents(
    revision: string,
    model: AccountModel,
    assets: readonly FleetCloneFile[],
    absolute: readonly { readonly path: string; readonly content: string }[],
  ): Promise<FleetDocumentWrite[]> {
    const { catalog } = this.deps;
    const documents: FleetDocumentWrite[] = [
      {
        path: `${catalog.layout.fleetDirectory}/config.yaml`,
        content: renderConfig(model),
        mode: DOCUMENT_MODE,
        expect: revision,
      },
    ];
    const targets = [
      ...assets.map(file => ({
        path: expandAssetPath(file.path, catalog.layout.userHome, catalog.layout.assetsDirectory),
        content: file.content,
      })),
      ...absolute,
    ];
    for (const target of targets) {
      documents.push({
        path: target.path,
        content: target.content,
        mode: DOCUMENT_MODE,
        expect: await catalog.documentRevision(target.path),
      });
    }
    return documents;
  }

  #fingerprint(documents: readonly FleetDocumentWrite[], secrets: readonly string[]): string {
    return this.deps.digest(
      JSON.stringify({
        documents: documents.map(document => [document.path, this.deps.digest(document.content), document.expect]),
        secrets,
      }),
    );
  }

  /** Materialise the model and apply it with these documents, inside the provisioner's one boundary. */
  async #applyModel(model: AccountModel, documents: readonly FleetDocumentWrite[]): Promise<void> {
    const { catalog } = this.deps;
    let plan: FleetModelApplyPlan;
    try {
      plan = materialiseFleet({
        model,
        layout: catalog.layout,
        ids: (await catalog.ids()) ?? EMPTY_RUNTIME_IDS,
        mint: () => catalog.mint(),
        generatedAt: new Date(catalog.now()).toISOString(),
        bodies: await this.#bodies(model, documents),
        claudeStatusline: catalog.claudeStatusline,
        fyCommand: catalog.fyCommand,
        ...(catalog.hostCodexHome === undefined ? {} : { hostCodexHome: catalog.hostCodexHome }),
        acceptsAutoPermissionMode: catalog.acceptsAutoPermissionMode,
      });
    } catch (error) {
      throw new FleetCatalogRefusal('fleet_change_refused', errorMessage(error));
    }
    try {
      await catalog.provisioner.apply(plan, documents);
    } catch (error) {
      const reason =
        error instanceof FleetApplyFailureError
          ? `${errorMessage(error)}; nothing was left half-changed`
          : errorMessage(error);
      throw new FleetCatalogRefusal('fleet_change_failed', reason);
    }
  }

  /** The component bodies the model names, with the documents about to be written in their place. */
  async #bodies(model: AccountModel, documents: readonly FleetDocumentWrite[]): Promise<MaterialiseBodies> {
    const { catalog } = this.deps;
    const overlay = new Map(documents.map(document => [document.path, document.content]));
    const text = async (file: string): Promise<string | undefined> => {
      const path = expandAssetPath(file, catalog.layout.userHome, catalog.layout.assetsDirectory);
      return overlay.get(path) ?? (await catalog.readAsset(path));
    };
    const parsed = (body: string | undefined, format: 'json' | 'toml'): SettingsObject | undefined => {
      if (body === undefined) return undefined;
      try {
        return parseSettings(body, format);
      } catch {
        return undefined;
      }
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

  // ── The first run at boot ──────────────────────────────────────────────────────────────────────

  /**
   * The version-2 first run a booting daemon gives a host with no fleet: import every installed
   * harness under the suggested names. Only ever called when {@link bootFirstRunChoice} said so, and
   * asks the switch again anyway, because a write must never go ahead on somebody else's say-so.
   */
  async firstRunAtBoot(): Promise<BootFirstRun> {
    try {
      const disabled = await this.deps.catalog.writesRefusal();
      if (disabled !== undefined) return { kind: 'skipped', reason: disabled };
      const reading = await this.#read();
      if (reading.format !== 'none') {
        return { kind: 'skipped', reason: 'this machine already has a fleet configuration, so it was left as it is' };
      }
      const change: SetupChange = { kind: 'setup.import' };
      const composed = await this.#composeImport(change);
      this.#described.set(change, composed.fingerprint);
      return { kind: 'imported', summary: await this.#execute(change, composed) };
    } catch (error) {
      if (error instanceof FleetCatalogRefusal && error.code === 'fleet_change_refused') {
        return { kind: 'skipped', reason: error.message };
      }
      return { kind: 'failed', reason: errorMessage(error) };
    }
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────────

  async #read(): Promise<Awaited<ReturnType<SetupCatalogDeps['document']>>> {
    try {
      return await this.deps.catalog.document();
    } catch (error) {
      throw new FleetSetupRefusal(
        'fleet_setup_unreadable',
        `this machine's fleet configuration could not be read: ${errorMessage(error)}`,
      );
    }
  }

  async #scans(): Promise<readonly HostHarnessScan[]> {
    try {
      return await this.deps.scan();
    } catch (error) {
      throw new FleetSetupRefusal(
        'fleet_setup_unreadable',
        `this machine's own Claude Code and Codex setup could not be read: ${errorMessage(error)}`,
      );
    }
  }

  async #importRefusal(format: FleetSetupScan['format']): Promise<string | undefined> {
    const disabled = await this.deps.catalog.writesRefusal();
    if (disabled !== undefined) return disabled;
    return format === 'version-1'
      ? 'This machine still uses the old account format, so its setup cannot be imported until it is migrated.'
      : undefined;
  }

  async #safely<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof FleetSetupRefusal) throw error;
      throw new FleetSetupRefusal('fleet_setup_refused', errorMessage(error));
    }
  }
}

/** Builds the setup subsystem the composition root mounts. */
export function createFleetSetupSubsystem(deps: FleetSetupServiceDeps): FleetSetupService {
  return new FleetSetupService(deps);
}
