/**
 * A machine's setup, as this daemon serves it (docs/design/account-model.md §4.3, §4.7, §7, §10.3):
 * the first-run scan and import, Import again, installing a harness tool, the Clone export and the
 * Clone import.
 *
 * ## The import and the clone are reviewed changes
 *
 * Neither has a route of its own that writes. Each is an EXECUTOR the catalogue's change flow runs
 * (`catalog-service.ts`): `POST /v1/fleet/proposals` with `setup.import` or `clone.import` stages it and
 * {@link FleetSetupService.executors} describes what applying would do; the apply runs it, after the
 * same revision check and `fleet.configure` step-up every change gets. What is described is
 * what runs: the plan is composed again at the apply and refused when it no longer matches the one the
 * person reviewed, because the host's own setup — or the target machine — can move in between.
 *
 * ## One apply boundary
 *
 * An import or a clone writes the configuration files, every component document it brings, and the plan the
 * fleet library materialises from the new model, inside the provisioner's single rollback boundary —
 * the same boundary every other change uses. Secret values an import found go into the secret store
 * first: a reference with no value only refuses a launch, while a value with no reference is harmless.
 *
 * ## A configuration in the old account format
 *
 * Is refused as unreadable, never converted and never touched: the scan and the import say so with the
 * sentence that tells a person to move it aside and set the machine up again. Installing a tool
 * writes no configuration, so it asks only for the `fleet.configure` step-up.
 *
 * ## Nothing is imported at boot
 *
 * A fresh machine is "not set up" until somebody chooses: the app opens the first run when it finds
 * one, and `fy daemon setup` asks the same questions in a terminal. Starting the daemon imports nothing.
 *
 * ## Nothing here leaves on a timer
 *
 * The scan reads files and resolves commands; a package manager starts only inside an explicit install
 * request; nothing is launched to find anything out, and no provider is called.
 */
import {
  type AccountModel,
  buildCloneBundle,
  type ClonePlan,
  CloneRefusal,
  cloneSources,
  describeClone,
  EMPTY_RUNTIME_IDS,
  expandAssetPath,
  FleetApplyFailureError,
  type FleetDocumentWrite,
  type FleetModelApplyPlan,
  freeName,
  HARNESS_DISPLAY_NAMES,
  type HarnessKind,
  type HostHarnessScan,
  type ImportPlan,
  type ImportRecord,
  isRuntimeName,
  type LayerReferenceText,
  type MaterialiseBodies,
  materialiseFleet,
  type ModelCatalogSources,
  mergeImport,
  mergeImportRecord,
  parseCloneBundle,
  parseSettings,
  planClone,
  planImport,
  type SettingsObject,
  skillFrontmatterKeys,
  skillSourceReference,
} from '@ferretry/fleet';
import type {
  FleetAccountChange,
  FleetCloneBundle,
  FleetCloneFile,
  FleetSetupRefusalCode,
  FleetSetupScan,
  FleetSetupTool,
  FleetToolInstallRequest,
  FleetToolInstallResult,
} from '@ferretry/protocol';
import type { CallerGovernance } from '../api/capability.ts';
import {
  type AccountChangeExecutor,
  type AccountDocumentReading,
  FleetCatalogRefusal,
  type FleetCatalogServiceDeps,
  harnessCommandsOf,
} from './catalog-service.ts';
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
interface FolderFile {
  readonly path: string;
  readonly content: string;
}

/** A folder read as text, with every file that could not be carried and why. */
export interface FolderReading {
  readonly files: readonly FolderFile[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

/** The catalogue's collaborators this service shares, so both read and write one machine the same way. */
export type SetupCatalogDeps = Pick<
  FleetCatalogServiceDeps,
  | 'document'
  | 'readAsset'
  | 'documentRevision'
  | 'ids'
  | 'locate'
  | 'machineName'
  | 'credentials'
  | 'provisioner'
  | 'layout'
  | 'mint'
  | 'now'
  | 'claudeStatusline'
  | 'fyCommand'
  | 'hostCodexHome'
  | 'acceptsAutoPermissionMode'
  | 'modelCatalogs'
>;

export interface FleetSetupServiceDeps {
  readonly catalog: SetupCatalogDeps;
  /** Read this machine's own Claude Code and Codex setup. Reads files and resolves commands only. */
  scan(): Promise<readonly HostHarnessScan[]>;
  /** The tool installer (`tool-install.ts`): its plans, and an install a person asked for. */
  readonly tools: {
    plans(harnesses: readonly HarnessKind[]): readonly ToolInstallPreview[];
    install(
      request: FleetToolInstallRequest,
      governance: CallerGovernance | undefined,
    ): Promise<readonly ToolInstallOutcome[]>;
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
  /** A content digest (sha256). */
  digest(text: string): string;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────

/** Where the import record lives, in the fleet directory: what each import made and from what. */
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

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

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
    components[reference] = {
      sources: entry.sources.filter(source => typeof source === 'string'),
      digest: entry.digest,
    };
  }
  const profiles = isRecord(raw.profiles)
    ? Object.fromEntries(
        (['claude', 'codex'] as const).flatMap(harness => {
          const name = (raw.profiles as Readonly<Record<string, unknown>>)[harness];
          return typeof name === 'string' ? [[harness, name]] : [];
        }),
      )
    : {};
  return {
    version: 1,
    components,
    ...(typeof raw.profile === 'string' ? { profile: raw.profile } : {}),
    ...(Object.keys(profiles).length === 0 ? {} : { profiles }),
  };
}

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
  constructor(private readonly deps: FleetSetupServiceDeps) {}

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
      importing: { available: true },
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
    const asset = (path: string): string =>
      expandAssetPath(path, catalog.layout.userHome, catalog.layout.assetsDirectory);
    for (const path of sources.documents) {
      const content = await catalog.readAsset(asset(path));
      if (content === undefined) notCopied.push({ path, reason: 'it could not be read' });
      else carry(path, content);
    }
    for (const directory of sources.directories) {
      const folder = await this.deps.readFolder(asset(directory));
      for (const file of folder.files) carry(`${directory}/${file.path}`, file.content);
      for (const skipped of folder.skipped)
        notCopied.push({ path: `${directory}/${skipped.path}`, reason: skipped.reason });
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
      model = mergeImport(
        existing,
        plan,
        updates.map(update => update.reference),
      );
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
    const record = mergeImportRecord(
      plan,
      updates.map(update => update.reference),
    );
    const documents = await this.#documents(reading, model, assets, [
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
      fingerprint: this.#fingerprint(
        documents,
        secrets.map(secret => this.deps.digest(`${secret.name}\n${secret.value}`)),
      ),
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
      const harness =
        plan.credentials[runtime.credential]?.harness ?? existing.credentials[runtime.credential]?.harness;
      return harness === undefined ? [] : [{ harness, name, profile: runtime.profile }];
    });
  }

  // ── Clone ──────────────────────────────────────────────────────────────────────────────────────

  async #composeClone(change: CloneChange): Promise<Composed> {
    const catalog = this.deps.catalog;
    const host = catalog.machineName();
    // The person's names for the two machines, when the app sent them; the hostnames are only what each calls itself.
    const machine = change.names?.target ?? host;
    let bundle: FleetCloneBundle;
    let plan: ClonePlan;
    const reading = await this.#read();
    try {
      bundle = parseCloneBundle(change.bundle);
      if (bundle.machine === host) {
        throw new CloneRefusal(`That setup was exported from ${machine} itself; pick another machine to copy from.`);
      }
      plan = planClone(reading.model, bundle, {
        mode: change.mode,
        machine,
        installed: HARNESSES.filter(harness => catalog.locate(harness) !== undefined),
        existingSkillItems: await this.deps.skillItems(),
        existingSecrets: await this.deps.secrets.names().catch(() => []),
        ...(change.skip === undefined ? {} : { skip: change.skip }),
        ...(change.source === undefined ? {} : { sourceDaemon: change.source.daemonId }),
        ...(change.names === undefined ? {} : { sourceName: change.names.source }),
        ...(change.defaultRuntime === undefined ? {} : { defaultRuntime: change.defaultRuntime }),
      });
    } catch (error) {
      if (error instanceof CloneRefusal) throw new FleetCatalogRefusal('fleet_change_refused', error.message);
      throw error;
    }
    const documents = await this.#documents(reading, plan.model, plan.files, []);
    const busiest = plan.slots.toSorted((left, right) => right.runtimes.length - left.runtimes.length)[0];
    return {
      model: plan.model,
      documents,
      secrets: [],
      lines: describeClone(plan, bundle, machine, change.names?.source),
      summary: [
        `Copied ${plural(plan.copied.runtimes, 'runtime')} from ${change.names?.source ?? bundle.machine}.`,
        ...(busiest === undefined || busiest.runtimes.length === 0
          ? []
          : [
              `Sign in once for ${plural(busiest.runtimes.length, 'runtime')}: ${busiest.email ?? busiest.label ?? busiest.id}.`,
            ]),
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

  /** The configuration files, then the asset documents, then any document by absolute path — each with what it expects. */
  async #documents(
    reading: AccountDocumentReading,
    model: AccountModel,
    assets: readonly FleetCloneFile[],
    absolute: readonly { readonly path: string; readonly content: string }[],
  ): Promise<FleetDocumentWrite[]> {
    const { catalog } = this.deps;
    const documents: FleetDocumentWrite[] = [...reading.documents(model)];
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

  /** The catalogs an apply reads (docs/model-catalog.md), or nothing on a machine wired without them. */
  async #modelCatalogs(): Promise<{ readonly modelCatalogs?: ModelCatalogSources }> {
    const sources = await this.deps.catalog.modelCatalogs?.();
    return sources === undefined ? {} : { modelCatalogs: sources };
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
        harnessCommands: harnessCommandsOf(harness => catalog.locate(harness)),
        ...(catalog.hostCodexHome === undefined ? {} : { hostCodexHome: catalog.hostCodexHome }),
        acceptsAutoPermissionMode: catalog.acceptsAutoPermissionMode,
        ...(await this.#modelCatalogs()),
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
}

/** Builds the setup subsystem the composition root mounts. */
export function createFleetSetupSubsystem(deps: FleetSetupServiceDeps): FleetSetupService {
  return new FleetSetupService(deps);
}
