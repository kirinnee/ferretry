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
  analyseCloneSettings,
  applyControls,
  type CloneSettingsAnalysis,
  type CloneSettingsInput,
  type CloneSettingsPlan,
  controlsDocument,
  EMPTY_CLONE_SETTINGS_PLAN,
  planCloneSettings,
  reviewCloneSettings,
} from '../account/clone-settings.ts';
import {
  analyseCloneUpdate,
  type CloneAnalysis,
  cloneBaseFor,
  type CloneUpdatePlan,
  describeCloneUpdate,
  planCloneUpdate,
  resolveCloneLogins,
  reviewCloneUpdate,
} from '../account/clone-update.ts';
import {
  applyCloneToBase,
  CloneSourceIdSchema,
  CLONE_BASE_FILE,
  cloneSourceIdentity,
  CloneSourceMismatch,
  findCloneSources,
  forgetCloneSource,
  parseCloneBase,
  serializeCloneBase,
} from '../account/clone-base.ts';
import { parseAccountModel, type AccountModel, isRuntimeName, type LayerReferenceText } from '../account/schema.ts';
import { classifyCloneKeys, recordCloneKeys } from '../account/clone-keys.ts';
import { assignOriginKeys, EXPORT_KEYS_FILE, parseExportKeys, serializeExportKeys } from '../account/export-keys.ts';
import {
  buildCloneBundle,
  type ClonePlan,
  cloneSources,
  describeClone,
  parseCloneBundle,
  planClone,
} from '../account/clone.ts';
import { CloneRefusal } from '../account/clone-parts.ts';
import { EMPTY_RUNTIME_IDS } from '../account/ids.ts';
import { FleetApplyFailureError, type FleetDocumentWrite, type FleetModelApplyPlan } from '../provisioning.ts';
import {
  freeName,
  type HostHarnessScan,
  type ImportPlan,
  type ImportRecord,
  mergeImport,
  mergeImportRecord,
  planImport,
} from '../account/import.ts';
import { HARNESS_DISPLAY_NAMES } from '../account/layering.ts';
import type { HarnessKind } from '../manifest.ts';
import { type MaterialiseBodies, materialiseFleet } from '../account/materialise.ts';
import { parseSettings, type SettingsObject } from '../settings.ts';
import { skillFrontmatterKeys, skillSourceReference } from '../account/adapt.ts';
import {
  CLONE_BUNDLE_KEYS_LIMIT,
  CLONE_REVIEW_STALE,
  type CloneSettingsDoc,
  type CloneSettingsText,
  type AccountChange,
  type CloneBundle,
  type CloneFile,
  type CloneKeysRecordRequest,
  type CloneKeysRecordResult,
  type CloneReview,
  type CloneReviewRequest,
  type SetupRefusalCode,
  type SetupScan,
  type SetupTool,
  type ToolInstallRequest,
  type ToolInstallResult,
} from '../../../contract/index.ts';
import { instantFromEpochMs } from '@ferretry/std';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import { secretReferencesIn } from '@ferretry/core-vault/contract';
import { ApiError } from '@ferretry/kernel/contract';
import type { ConfigText } from '../ports.ts';
import { CREDENTIALS_DIRECTORY, harnessKey, harnessKind } from './foreign.ts';
import type { ModelCatalogSources } from '../models/catalog.ts';
import { expandAssetPath } from '../paths.ts';
import { ConfigWriteConflict, ConfigWriteInvalid, configFileWriteRefusal } from './ports.ts';
import {
  type AccountChangeExecutor,
  type AccountDocumentReading,
  budgetHoldsOf,
  type ExecutorCaller,
  FleetCatalogFreshStepUpRequired,
  FleetCatalogRefusal,
  type FleetCatalogServiceDeps,
  harnessCommandsOf,
} from './catalog-service.ts';
import { type ToolInstallOutcome, type ToolInstallPreview, ToolInstallRefusal } from './tool-install.ts';

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

/** A bundle compared against this machine, with what the apply needs to record it. */
interface UpdateAnalysis {
  readonly analysis: CloneAnalysis;
  readonly bundle: CloneBundle;
  readonly machine: string;
  readonly source: ReturnType<typeof cloneSourceIdentity>;
  readonly record: ReturnType<typeof parseCloneBase>;
  /** Whether the record already holds this source, verified the way it is now. */
  readonly known: boolean;
  /** The settings documents the source sent, merged key by key against this machine's own. */
  readonly settings?: {
    readonly analysis: CloneSettingsAnalysis;
    /** The version of each file the comparison read: what the write is made against. */
    readonly etags: ReadonlyMap<CloneSettingsDoc, string>;
  };
}

/** The singleton each settings file is, for judging what a write would loosen. */
const SETTINGS_KIND = { 'warden.yaml': 'warden', 'learning.yaml': 'learning', 'voice.yaml': 'voice' } as const;

/**
 * This machine's configuration files as a copy reads and writes them: the door `PUT /v1/config/file` is.
 * A write is validated, refused if the file moved since it was read, and HELD when it loosens and the caller
 * may not confirm it in the same act.
 */
export interface CloneConfigFiles {
  file(path: string): Promise<{ readonly exists: boolean; readonly text: string; readonly etag: string }>;
  /** What is in effect now, for judging a loosening. */
  effective(): Promise<Readonly<Record<'warden' | 'learning' | 'voice', unknown>>>;
  validate(
    path: string,
    text: string,
  ): Promise<readonly { readonly severity: 'error' | 'warning'; readonly message: string; readonly line?: number }[]>;
  write(
    path: string,
    text: string,
    ifMatch: string,
    mayLoosen: boolean,
  ): Promise<{ readonly outcome: 'applied' | 'pending' }>;
}

/**
 * What a failed apply says it left behind. A document of the fleet folder rides the provisioner's own boundary and rolls
 * back with the plan. A configuration file is written BEFORE the plan (the files are the source of truth, and the next
 * republish retries the plan from them) and is NOT rolled back with it, so the sentence names what was written: the
 * words "nothing was left half-changed" are said only when no configuration file landed first.
 */
export function failedApplySentence(
  failure: string,
  documents: readonly FleetDocumentWrite[],
  fleetDirectory: string,
): string {
  const written = documents.filter(document => !document.path.startsWith(`${fleetDirectory}/`)).map(({ path }) => path);
  if (written.length === 0) return `${failure}; nothing was left half-changed`;
  const named =
    written.length === 1 ? `the configuration ${written[0]} was` : `the configuration files ${written.join(', ')} were`;
  return `${failure}; ${named} written first and is NOT rolled back with the fleet`;
}

/** Every refusal the setup routes answer with, so a client branches on cause rather than on prose. */
export class FleetSetupRefusal extends Error {
  constructor(
    readonly code: SetupRefusalCode,
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
  | 'budgetHolds'
>;

export interface FleetSetupServiceDeps {
  readonly catalog: SetupCatalogDeps;
  /** Read this machine's own Claude Code and Codex setup. Reads files and resolves commands only. */
  scan(): Promise<readonly HostHarnessScan[]>;
  /** The tool installer (`tool-install.ts`): its plans, and an install a person asked for. */
  readonly tools: {
    plans(harnesses: readonly HarnessKind[]): readonly ToolInstallPreview[];
    install(
      request: ToolInstallRequest,
      governance: CallerGovernance | undefined,
    ): Promise<readonly ToolInstallOutcome[]>;
  };
  /** The secret store's management side: names in, values in, never a value out. */
  readonly secrets: {
    names(): Promise<readonly string[]>;
    /** Each secret's name and when it was made and last changed: what a repeat copy compares. Never a value. */
    held(): Promise<readonly { readonly name: string; readonly createdAt: string; readonly updatedAt: string }[]>;
    put(name: string, value: string): Promise<void>;
  };
  /** One folder, read as text: a host skill folder, or a folder of the asset tree. */
  readFolder(path: string): Promise<FolderReading>;
  /** The skill items the asset tree's store already holds. */
  skillItems(): Promise<readonly string[]>;
  /** A content digest (sha256). */
  digest(text: string): string;
  /**
   * This daemon's own id, as it reports itself to a machine that copies from it. Absent while pairing
   * identity is not open yet, and then there is nothing to say a copy came from.
   */
  daemonId(): string | undefined;
  /** Cryptographically random bytes: an origin key is 16 of them. */
  randomBytes(length: number): Uint8Array;
  /** `setup/export-keys.json`: the origin keys this machine gave what it exported (state, never configuration). */
  readonly exportKeys: {
    read(path: string): Promise<string | undefined>;
    write(path: string, text: string): Promise<void>;
  };
  /**
   * The configuration files a settings merge reads and writes. Absent on a machine wired without them: a copy
   * that carries `warden.yaml`, `learning.yaml` or `voice.yaml` is then refused rather than half applied.
   */
  readonly configFiles?: CloneConfigFiles;
  /** Reads and edits a settings file's YAML text, keeping its comments. Needed with `configFiles`. GAP(kernel): the config layer's. */
  readonly configText?: ConfigText;
  /**
   * `setup/clone-base.json` outside a copy: forgetting a source and remembering the keys a copy filed write it on
   * their own (a copy writes it in its own batch, which checks the revision it planned against).
   */
  readonly cloneBase: {
    read(path: string): Promise<string | undefined>;
    /**
     * One read-modify-write of the record with no other writer of it between the read and the write — this
     * daemon's fleet applies included: `change` gets the text on disk NOW (`undefined` when there is none) and
     * answers the text to write, or `undefined` to write nothing. Answers whether it wrote.
     */
    update(path: string, change: (current: string | undefined) => string | undefined): Promise<boolean>;
  };
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────

/** Where the import record lives, in the fleet directory: what each import made and from what. */
const IMPORT_RECORD_FILE = 'setup/import.json';

/**
 * The most document text one Clone bundle carries. The bundle travels back as a change body, which
 * has its own ceiling, so a larger setup is copied without the documents that do not fit and says so.
 */
const CLONE_BUNDLE_MAX_BYTES = 384 * 1024;

const DOCUMENT_MODE = 0o600;
const HARNESSES: readonly HarnessKind[] = ['claude', 'codex'];
const SETTINGS_FORMAT = { claude: 'json', codex: 'toml' } as const satisfies Record<HarnessKind, 'json' | 'toml'>;

type SetupChange = Extract<AccountChange, { kind: 'setup.import' }>;
type CloneChange = Extract<AccountChange, { kind: 'clone.import' }>;

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The import record, or none when what is stored cannot be read: then nothing is ever offered as an update. */
function parseImportRecord(text: string | undefined): ImportRecord | undefined {
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

/** One settings file to write: the text, the version it was compared with, and the port's own way to write it. */
interface ConfigWrite {
  readonly path: string;
  readonly text: string;
  readonly etag: string;
  readonly put: CloneConfigFiles['write'];
}

interface Composed {
  readonly model: AccountModel;
  readonly documents: readonly FleetDocumentWrite[];
  /** Values to store before the apply. Never in a description, a digest or a log. */
  readonly secrets: readonly { readonly name: string; readonly value: string }[];
  readonly lines: readonly string[];
  readonly summary: string;
  /** What the person reviewed, so the apply runs that and nothing else. Holds no value. */
  readonly fingerprint: string;
  /** Configuration files the copy writes through the owner's door, each against the version it was compared with. */
  readonly configWrites?: readonly ConfigWrite[];
}

// ── The service ──────────────────────────────────────────────────────────────────────────────────

export class FleetSetupService {
  /** The fingerprint each staged change was described with, keyed by the staged change itself. */
  readonly #described = new WeakMap<object, string>();
  constructor(private readonly deps: FleetSetupServiceDeps) {}

  // ── Scan ───────────────────────────────────────────────────────────────────────────────────────

  /** `GET /v1/fleet/setup/scan`: what the first run and Import again would find. No value of anything. */
  async scan(): Promise<SetupScan> {
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
        harness: harnessKey(harness.harness),
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
      runtimes: this.#runtimesOf(plan, reading.model).map(entry => ({ ...entry, harness: harnessKey(entry.harness) })),
      updates: plan.updates.map(update => ({ reference: update.reference, sources: [...update.sources] })),
      duplicates: plan.duplicates.map(duplicate => ({ ...duplicate, harness: harnessKey(duplicate.harness) })),
      notes: plan.notes.map(note => ({ ...note, harness: harnessKey(note.harness) })),
      importing: { available: true },
    };
  }

  #tools(): SetupTool[] {
    return this.deps.tools.plans(HARNESSES).map(preview => {
      const label = HARNESS_DISPLAY_NAMES[preview.harness];
      if (preview.installed) return { harness: harnessKey(preview.harness), label, installed: true };
      const plan = preview.plan;
      return {
        harness: harnessKey(preview.harness),
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
    request: ToolInstallRequest,
    governance: CallerGovernance | undefined,
  ): Promise<ToolInstallResult> {
    let outcomes: readonly ToolInstallOutcome[];
    try {
      outcomes = await this.deps.tools.install(request, governance);
    } catch (error) {
      if (!(error instanceof ToolInstallRefusal)) throw error;
      const code: SetupRefusalCode =
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
          ? { harness: harnessKey(outcome.harness), outcome: 'already-installed' }
          : outcome.outcome === 'installed'
            ? { harness: harnessKey(outcome.harness), outcome: 'installed', command: outcome.command }
            : { ...outcome, harness: harnessKey(outcome.harness) },
      ),
    };
  }

  // ── Export ─────────────────────────────────────────────────────────────────────────────────────

  /** `GET /v1/fleet/export`: the Clone bundle. No credential, no history, no secret value. */
  async exportBundle(): Promise<CloneBundle> {
    const catalog = this.deps.catalog;
    const reading = await this.#read();
    if (Object.keys(reading.model.runtimes).length === 0) {
      throw new FleetSetupRefusal(
        'fleet_setup_refused',
        `${catalog.machineName()} isn't set up yet, so there is nothing to copy from it.`,
      );
    }
    const sources = cloneSources(reading.model);
    const files: CloneFile[] = [];
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
    const daemon = this.deps.daemonId();
    if (daemon === undefined) {
      throw new FleetSetupRefusal(
        'fleet_setup_refused',
        `${catalog.machineName()} is still starting, so it cannot be copied from yet. Try again in a moment.`,
      );
    }
    const bundle = buildCloneBundle({
      model: reading.model,
      machine: catalog.machineName(),
      exportedAt: new Date(catalog.now()).toISOString(),
      emails: await this.#emails(),
      files,
      notCopied,
    });
    const path = `${catalog.layout.fleetDirectory}/${EXPORT_KEYS_FILE}`;
    const remembered = await this.#storedKeys(path);
    const { keys, stored } = assignOriginKeys({
      bundle,
      previous: parseExportKeys(remembered.text),
      runtimeIds: Object.fromEntries(
        Object.entries(((await catalog.ids()) ?? EMPTY_RUNTIME_IDS).runtimes).map(([name, entry]) => [name, entry.id]),
      ),
      randomBytes: length => this.deps.randomBytes(length),
    });
    if (Object.keys(keys).length > CLONE_BUNDLE_KEYS_LIMIT) {
      throw new FleetSetupRefusal(
        'fleet_setup_refused',
        `${catalog.machineName()} has more than ${String(CLONE_BUNDLE_KEYS_LIMIT)} items, which is more than one copy can carry. Remove some, then try again.`,
      );
    }
    // Bookkeeping: an export that cannot remember its keys still answers with the ones it minted. A file
    // that is merely absent or invalid is replaced; one that could not be READ is left alone, because it
    // may hold keys every target already stamped, and writing fresh ones over it would lose them for good.
    if (remembered.readable) {
      try {
        await this.deps.exportKeys.write(path, serializeExportKeys(stored));
      } catch {
        // The next export re-derives what it can; a renamed item then looks new rather than copying wrongly.
      }
    }
    return { ...bundle, daemon, keys };
  }

  async #storedKeys(path: string): Promise<{ readonly text: string | undefined; readonly readable: boolean }> {
    try {
      return { text: await this.deps.exportKeys.read(path), readable: true };
    } catch {
      return { text: undefined, readable: false };
    }
  }

  async #emails(): Promise<Record<string, string | undefined>> {
    try {
      const list = await this.deps.catalog.credentials.list();
      return Object.fromEntries(list.logins.map(login => [login.id, login.email]));
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
      describe: async (change, caller) =>
        await this.#describe(change, await this.#composeClone(change, caller, 'describe')),
      execute: async (change, caller) =>
        await this.#execute(change, await this.#composeClone(change, caller, 'apply'), caller),
    },
  };

  async #describe(change: object, composed: Composed): Promise<string> {
    this.#described.set(change, composed.fingerprint);
    return composed.lines.join(' ');
  }

  async #execute(change: object, composed: Composed, caller?: ExecutorCaller): Promise<string> {
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
    // Settings files go first, each through the owner's door and against the version it was compared with. The
    // record rides the batch after them, so it can only claim less than landed, never more. A write that loosens
    // is held unless the caller is at this machine (`governed: false`); a remote caller confirms it as for any
    // other held edit.
    const mayLoosen = caller?.governance?.governed === false;
    let held = 0;
    for (const write of composed.configWrites ?? []) held += await this.#writeConfigFile(write, mayLoosen);
    await this.#applyModel(composed.model, composed.documents);
    return held === 0
      ? composed.summary
      : `${composed.summary} ${plural(held, 'settings file')} held until you confirm ${held === 1 ? 'it' : 'them'}.`;
  }

  /** One settings file through `PUT /v1/config/file`'s semantics. Answers 1 when the write was held. */
  async #writeConfigFile(write: ConfigWrite, mayLoosen: boolean): Promise<number> {
    try {
      return (await write.put(write.path, write.text, write.etag, mayLoosen)).outcome === 'pending' ? 1 : 0;
    } catch (error) {
      if (error instanceof ConfigWriteConflict) {
        throw new FleetCatalogRefusal(
          'fleet_change_stale',
          `${write.path} changed on this machine after it was reviewed; review it again`,
        );
      }
      if (error instanceof ConfigWriteInvalid) {
        throw new FleetCatalogRefusal(
          'fleet_change_refused',
          `${write.path} would not check on this machine, so it was not written: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
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
      ...(change.include === undefined ? {} : { include: change.include.map(harnessKind) }),
      ...(existing === undefined ? {} : { existing }),
      ...(await this.#recordOption()),
      existingSecrets,
      addDuplicates: change.addDuplicates === true ? installed : [],
      digest: text => this.deps.digest(text),
    });
    // The wire keys the names by the Ferrets harness key; the library keys them by its own word.
    const given = change.names;
    const plan = this.#named(
      raw,
      {
        ...(given?.['claude-code'] === undefined ? {} : { claude: given['claude-code'] }),
        ...(given?.codex === undefined ? {} : { codex: given.codex }),
      },
      reading.model,
    );
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
    const assets: CloneFile[] = [];
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

  async #composeClone(
    change: CloneChange,
    caller?: ExecutorCaller,
    stage: 'describe' | 'apply' = 'apply',
  ): Promise<Composed> {
    if (change.mode === 'update') return await this.#composeUpdate(change, caller, stage);
    // Settings are merged key by key against a record of the last copy, which only a repeat copy has. Carrying them
    // on another mode would be ignored, and a person who sent them would think they had been merged.
    if ((change.settings?.length ?? 0) > 0 || change.settingsDecisions !== undefined) {
      throw new FleetCatalogRefusal(
        'fleet_change_refused',
        'Settings are merged key by key only when a copy is repeated (update). Nothing was changed.',
      );
    }
    const catalog = this.deps.catalog;
    const host = catalog.machineName();
    // The person's names for the two machines, when the app sent them; the hostnames are only what each calls itself.
    const machine = change.names?.target ?? host;
    let bundle: CloneBundle;
    let plan: ClonePlan;
    let source: ReturnType<typeof cloneSourceIdentity>;
    const reading = await this.#read();
    try {
      bundle = parseCloneBundle(change.bundle);
      if (bundle.machine === host) {
        throw new CloneRefusal(`That setup was exported from ${machine} itself; pick another machine to copy from.`);
      }
      source = cloneSourceIdentity(bundle, change.source?.daemonId, change.names?.source);
      plan = planClone(reading.model, bundle, {
        mode: change.mode,
        machine,
        installed: HARNESSES.filter(harness => catalog.locate(harness) !== undefined),
        existingSkillItems: await this.deps.skillItems(),
        existingSecrets: await this.deps.secrets.names().catch(() => []),
        targetEmails: await this.#emails(),
        ...(change.skip === undefined ? {} : { skip: change.skip }),
        ...(change.source === undefined ? {} : { sourceDaemon: change.source.daemonId }),
        ...(change.names === undefined ? {} : { sourceName: change.names.source }),
        ...(change.defaultRuntime === undefined ? {} : { defaultRuntime: change.defaultRuntime }),
      });
    } catch (error) {
      if (error instanceof CloneRefusal || error instanceof CloneSourceMismatch) {
        throw new FleetCatalogRefusal('fleet_change_refused', error.message);
      }
      throw error;
    }
    // The record of what was copied rides this batch, so it can never claim a copy that did not land.
    const { record, unreadable } = await this.#cloneBaseDocument(change, plan, source);
    const documents = await this.#documents(reading, plan.model, plan.files, record === undefined ? [] : [record]);
    const busiest = plan.slots.toSorted((left, right) => right.runtimes.length - left.runtimes.length)[0];
    const reused = plan.logins.filter(login => login.outcome === 'matched').map(login => login.name);
    return {
      model: plan.model,
      documents,
      secrets: [],
      lines: [
        ...describeClone(plan, bundle, machine, change.names?.source),
        ...(unreadable === undefined
          ? []
          : [
              `The record of what was last copied (${unreadable}) cannot be read, so this copy is made without it and is not added to it. Nothing there is changed.`,
            ]),
      ],
      summary: [
        `Copied ${plural(plan.copied.runtimes, 'runtime')} from ${change.names?.source ?? bundle.machine}.`,
        ...(reused.length === 0 ? [] : [`Already signed in here, no new sign-in: ${reused.join(', ')}.`]),
        ...(busiest === undefined || busiest.runtimes.length === 0
          ? []
          : [
              `Sign in once for ${plural(busiest.runtimes.length, 'runtime')}: ${busiest.email ?? busiest.label ?? busiest.id}.`,
            ]),
      ].join(' '),
      fingerprint: this.#fingerprint(documents, [], record === undefined ? [] : [record.path]),
    };
  }

  /** `POST /v1/fleet/clone/review`: what a copy from this source would change here, and why. Writes nothing. */
  async reviewClone(request: CloneReviewRequest, governance?: CallerGovernance): Promise<CloneReview> {
    const reading = await this.#read();
    try {
      const found = await this.#analyseUpdate(request, reading);
      const review = {
        ...reviewCloneUpdate(found.analysis),
        keys: [...(await this.#reviewKeys(request, found))],
      };
      if (found.settings === undefined) return review;
      // A settings file this caller may not write is listed as refused, with the sentence the apply would give.
      const settings = reviewCloneSettings(found.settings.analysis).map(entry => {
        const why = this.#settingsRefusal(governance, entry.path, 'describe');
        return why === undefined ? entry : { path: entry.path, refused: why, keys: [] };
      });
      return { ...review, settings, fingerprint: this.#reviewFingerprint(found) };
    } catch (error) {
      if (error instanceof CloneRefusal || error instanceof CloneSourceMismatch) {
        throw new FleetSetupRefusal('fleet_setup_refused', error.message);
      }
      throw error;
    }
  }

  /**
   * How each API key the copy concerns stands, from `updatedAt` alone (docs/secrets.md): the keys the bundle's
   * logins name and the ones the last copy from this source recorded, against what the source listed. Nothing
   * is answered without a list from the source, and no value is read to answer.
   */
  async #reviewKeys(request: CloneReviewRequest, found: UpdateAnalysis): Promise<CloneReview['keys']> {
    if (request.sourceSecrets === undefined) return [];
    const wanted = found.bundle.credentials.flatMap(credential =>
      secretReferencesIn(JSON.stringify([credential.env ?? {}, credential.claude ?? {}, credential.codex ?? {}])),
    );
    return classifyCloneKeys({
      source: request.sourceSecrets,
      target: await this.deps.secrets.held().catch(() => []),
      wanted,
      recorded: found.source === undefined ? undefined : cloneBaseFor(found.record, found.source)?.keys,
    });
  }

  /**
   * `POST /v1/fleet/clone/keys`: a sealed copy filed these keys here at `filedAt`; remember when the source last
   * changed each and the instant this machine filed it. A key is recorded only if its own store entry was CREATED
   * at `filedAt` — the one thing that proves it is the entry that copy made: a key the person deleted and made
   * again since is a different key and is left unrecorded. The entry's later edits do not matter and must not:
   * the baseline is the copy's instant, never the store's current `updatedAt`, so a key the person edited after
   * the copy still reads as changed here. Only the `keys` of a source this machine already has a record of
   * change; a source with no record and a name no copy can carry are skipped. The read-modify-write of the record
   * is one step with no other writer between (`cloneBase.update`). Timestamps only: nothing here reads a secret.
   */
  async recordCloneKeys(request: CloneKeysRecordRequest): Promise<CloneKeysRecordResult> {
    if (!CloneSourceIdSchema.safeParse(request.source.daemonId).success) return { recorded: 0 };
    const filedAt = Date.parse(request.filedAt);
    const made = new Map((await this.deps.secrets.held()).map(secret => [secret.name, secret.createdAt] as const));
    const recorded = request.keys.flatMap(key => {
      const createdAt = made.get(key.name);
      return createdAt !== undefined && Date.parse(createdAt) === filedAt
        ? [{ name: key.name, sourceUpdatedAt: key.sourceUpdatedAt, targetUpdatedAt: request.filedAt }]
        : [];
    });
    const wrote = await this.deps.cloneBase.update(this.#cloneBasePath(), current => {
      const before = parseCloneBase(current);
      const after = recordCloneKeys(before, request.source.daemonId, recorded);
      return after === before ? undefined : serializeCloneBase(after);
    });
    // Counted from the update that committed, never from a change that was handed a record and wrote nothing.
    return { recorded: wrote ? recorded.length : 0 };
  }

  /** The three-way comparison of a bundle against this machine, from what is on disk now. */
  async #analyseUpdate(
    request: {
      readonly bundle: unknown;
      readonly source?: { readonly daemonId: string };
      readonly names?: { readonly source: string; readonly target: string };
      readonly settings?: readonly CloneSettingsText[];
    },
    reading: AccountDocumentReading,
  ): Promise<UpdateAnalysis> {
    const catalog = this.deps.catalog;
    const host = catalog.machineName();
    const machine = request.names?.target ?? host;
    const bundle = parseCloneBundle(request.bundle);
    if (bundle.machine === host) {
      throw new CloneRefusal(`That setup was exported from ${machine} itself; pick another machine to copy from.`);
    }
    const source = cloneSourceIdentity(bundle, request.source?.daemonId, request.names?.source);
    const record = parseCloneBase(await this.deps.cloneBase.read(this.#cloneBasePath()));
    const base = cloneBaseFor(record, source);
    const analysis = analyseCloneUpdate({
      target: reading.model,
      bundle,
      machine,
      ...(request.names === undefined ? {} : { sourceName: request.names.source }),
      ...(source === undefined ? {} : { source }),
      ...(base === undefined ? {} : { base }),
      targetFiles: await this.#targetFiles(reading.model),
      logins: resolveCloneLogins(bundle, reading.model, base, await this.#emails()),
      installed: HARNESSES.filter(harness => catalog.locate(harness) !== undefined),
      existingSkillItems: await this.deps.skillItems(),
      existingSecrets: await this.deps.secrets.names().catch(() => []),
      roots: { userHome: catalog.layout.userHome, assetsDirectory: catalog.layout.assetsDirectory },
      ...(request.source === undefined ? {} : { sourceDaemon: request.source.daemonId }),
    });
    const settings =
      request.settings === undefined || request.settings.length === 0
        ? undefined
        : await this.#analyseSettings(request.settings, reading.model, base?.settings);
    return {
      analysis,
      bundle,
      machine,
      source,
      record,
      known: base !== undefined,
      ...(settings === undefined ? {} : { settings }),
    };
  }

  /** What the review is bound to: the items' comparison, and the settings' when the source sent any. */
  #reviewFingerprint(found: UpdateAnalysis): string {
    return found.settings === undefined
      ? found.analysis.fingerprint
      : this.deps.digest(`${found.analysis.fingerprint}\n${found.settings.analysis.fingerprint}`);
  }

  /** Each settings document the source sent, against this machine's own file (or its controls). */
  async #analyseSettings(
    sent: readonly CloneSettingsText[],
    model: AccountModel,
    base: Parameters<typeof analyseCloneSettings>[1],
  ): Promise<NonNullable<UpdateAnalysis['settings']>> {
    const inputs: CloneSettingsInput[] = [];
    const etags = new Map<CloneSettingsDoc, string>();
    let effective: Awaited<ReturnType<CloneConfigFiles['effective']>> | undefined;
    for (const document of sent) {
      if (document.path === 'controls') {
        inputs.push({
          path: 'controls',
          theirs: document.text,
          mine: controlsDocument(model.machine),
          mineExists: true,
        });
        continue;
      }
      const files = this.deps.configFiles;
      if (files === undefined) {
        throw new CloneRefusal(`This machine cannot merge ${document.path} yet. Leave it out and copy the rest.`);
      }
      const here = await files.file(document.path);
      effective ??= await files.effective();
      etags.set(document.path, here.etag);
      inputs.push({
        path: document.path,
        theirs: document.text,
        mine: here.exists ? here.text : '',
        mineExists: here.exists,
        effective: effective[SETTINGS_KIND[document.path]],
      });
    }
    const config = this.deps.configText;
    return { analysis: analyseCloneSettings(inputs, base, config), etags };
  }

  /** Why this caller may not write a settings file, in words; none when it may (or, staging, only needs a passkey). */
  #settingsRefusal(
    governance: CallerGovernance | undefined,
    path: CloneSettingsDoc,
    stage: 'describe' | 'apply',
  ): string | undefined {
    // The controls are the machine's own settings: `fleet.configure`, which the change already demanded.
    return path === 'controls' ? undefined : configFileWriteRefusal(governance, path, stage);
  }

  /** The documents this machine's own items own, as the export would carry them: what an update compares against. */
  async #targetFiles(model: AccountModel): Promise<CloneFile[]> {
    const catalog = this.deps.catalog;
    const sources = cloneSources(model);
    const asset = (path: string): string =>
      expandAssetPath(path, catalog.layout.userHome, catalog.layout.assetsDirectory);
    const files: CloneFile[] = [];
    for (const path of sources.documents) {
      const content = await catalog.readAsset(asset(path));
      if (content !== undefined) files.push({ path, content });
    }
    for (const directory of sources.directories) {
      const folder = await this.deps.readFolder(asset(directory));
      for (const file of folder.files) files.push({ path: `${directory}/${file.path}`, content: file.content });
    }
    return files;
  }

  /** `clone.import` with `mode: 'update'`: re-plan, refuse a review that has moved, write only what was chosen. */
  async #composeUpdate(
    change: CloneChange,
    caller: ExecutorCaller | undefined,
    stage: 'describe' | 'apply',
  ): Promise<Composed> {
    const reading = await this.#read();
    let plan: CloneUpdatePlan;
    let found: UpdateAnalysis;
    let settingsPlan: CloneSettingsPlan = EMPTY_CLONE_SETTINGS_PLAN;
    try {
      found = await this.#analyseUpdate(change, reading);
      if (change.reviewed === undefined || change.reviewed !== this.#reviewFingerprint(found)) {
        throw new CloneRefusal(CLONE_REVIEW_STALE);
      }
      plan = planCloneUpdate(found.analysis, {
        decisions: change.decisions ?? {},
        ...(change.logins === undefined ? {} : { logins: change.logins }),
        ...(change.skip === undefined ? {} : { skip: change.skip }),
      });
      if (found.settings !== undefined) {
        // Each carried file passes the check `PUT /v1/config/file` makes, so a device that may not write
        // `warden.yaml` directly cannot write it by copying either.
        for (const file of found.settings.analysis.files) {
          const why = this.#settingsRefusal(caller?.governance, file.input.path, stage);
          if (why !== undefined)
            throw new CloneRefusal(
              `${why}. Leave ${file.input.path} out, or copy from a device that may. Nothing was changed.`,
            );
        }
        settingsPlan = planCloneSettings(found.settings.analysis, change.settingsDecisions);
      } else if (change.settingsDecisions !== undefined && Object.keys(change.settingsDecisions).length > 0) {
        throw new CloneRefusal('Settings were decided, but no settings were sent. Review them again.');
      }
    } catch (error) {
      if (error instanceof CloneRefusal || error instanceof CloneSourceMismatch) {
        throw new FleetCatalogRefusal('fleet_change_refused', error.message);
      }
      throw error;
    }
    // The controls taken are a smaller `machine.settings` change: only those fields, in the same batch.
    let nextModel = plan.model;
    const controls = settingsPlan.controls;
    if (controls !== undefined) {
      try {
        nextModel = parseAccountModel({ ...plan.model, machine: applyControls(plan.model.machine, controls.taken) });
      } catch (error) {
        const first =
          (error as { issues?: readonly { message: string }[] }).issues?.[0]?.message ?? errorMessage(error);
        throw new FleetCatalogRefusal(
          'fleet_change_refused',
          `Taking those controls would leave ${found.machine} with a setup it cannot read: ${first}. Nothing was changed.`,
        );
      }
      // Turning what agents may control back ON needs a passkey proved for it from a remote device, and never
      // a ferret: the rule `machine.settings` applies (docs/grants.md). Describing writes nothing, so it only says so.
      if (stage === 'apply' && controls.widensAgentControl) {
        if (caller?.agent === true) {
          throw new ApiError(
            403,
            'a ferret cannot widen what ferrets may drive on this machine; the owner does',
            'owner_only',
          );
        }
        if (caller?.governance === undefined) {
          throw new FleetCatalogRefusal(
            'fleet_change_refused',
            'this daemon cannot say whether this caller may widen what agents may control, so nothing was changed',
          );
        }
        // CLAIMED before any file or the model is written, never read off the snapshot and spent after.
        if (caller.governance.governed && !caller.claim()) throw new FleetCatalogFreshStepUpRequired();
      }
    }
    const configWrites: ConfigWrite[] = [];
    const settingsFiles = this.deps.configFiles;
    for (const file of settingsPlan.files) {
      const etag = found.settings?.etags.get(file.path);
      // A file with an etag was read through the port, so the port is there; the controls have neither.
      if (etag === undefined || settingsFiles === undefined) continue;
      const issues = await settingsFiles.validate(file.path, file.text);
      const broken = issues.filter(issue => issue.severity === 'error');
      if (broken.length > 0) {
        throw new FleetCatalogRefusal(
          'fleet_change_refused',
          `${file.path} from ${change.names?.source ?? found.bundle.machine} would not check on ${found.machine}: ${broken
            .slice(0, 3)
            .map(issue => `${issue.line === undefined ? '' : `line ${String(issue.line)}: `}${issue.message}`)
            .join('; ')}. Nothing was changed.`,
        );
      }
      configWrites.push({ path: file.path, text: file.text, etag, put: settingsFiles.write.bind(settingsFiles) });
    }
    const path = this.#cloneBasePath();
    const record =
      found.source === undefined || (plan.sourceKeys.size === 0 && Object.keys(settingsPlan.recorded).length === 0)
        ? undefined
        : {
            path,
            content: serializeCloneBase(
              applyCloneToBase(found.record, {
                source: found.source,
                at: instantFromEpochMs(this.deps.catalog.now()),
                replace: !found.known,
                copied: plan.base,
                sourceKeys: plan.sourceKeys,
                model: nextModel,
                settled: new Set(plan.settled),
                settings: settingsPlan.recorded,
              }),
            ),
          };
    const removals = plan.removals.map(file => this.#removableAsset(file));
    const documents = await this.#documents(
      reading,
      nextModel,
      plan.files,
      record === undefined ? [] : [record],
      removals,
    );
    const sourceName = change.names?.source ?? found.bundle.machine;
    const settingsWords = this.#settingsLines(settingsPlan, found.machine, caller?.governance?.governed !== false);
    return {
      model: nextModel,
      documents,
      secrets: [],
      lines: [...describeCloneUpdate(plan, found.machine, sourceName), ...settingsWords],
      summary: `Updated ${found.machine} from ${sourceName}: ${plural(plan.done.taken.length, 'item')} updated, ${plural(plan.done.added.length, 'item')} added, ${plural(plan.done.removed.length, 'item')} removed${
        settingsPlan.done.taken.length === 0 ? '' : `, ${plural(settingsPlan.done.taken.length, 'setting')} taken`
      }.`,
      fingerprint: this.#fingerprint(documents, [], record === undefined ? [] : [record.path], configWrites),
      configWrites,
    };
  }

  /**
   * The "last copied" record after this copy (`clone-base.json`, docs/design/account-model.md §3.8), as a
   * document for the copy's own batch. None for a bundle that carries no origin keys (version 1) or no
   * source identity: there is then nothing to link a later copy to. A record that exists but cannot be read
   * (no permission, a folder in its place) never blocks a copy and is never written over: the copy goes
   * ahead without it, and `unreadable` names the file so the review can say so (design §8c).
   */
  async #cloneBaseDocument(
    change: CloneChange,
    plan: ClonePlan,
    source: ReturnType<typeof cloneSourceIdentity>,
  ): Promise<{
    readonly record?: { readonly path: string; readonly content: string };
    readonly unreadable?: string;
  }> {
    if (source === undefined || plan.sourceKeys.size === 0) return {};
    const path = this.#cloneBasePath();
    let stored: string | undefined;
    try {
      stored = await this.deps.cloneBase.read(path);
      await this.deps.catalog.documentRevision(path);
    } catch {
      return { unreadable: CLONE_BASE_FILE };
    }
    const next = applyCloneToBase(parseCloneBase(stored), {
      source,
      at: instantFromEpochMs(this.deps.catalog.now()),
      replace: change.mode === 'replace',
      copied: plan.base,
      sourceKeys: plan.sourceKeys,
      model: plan.model,
    });
    return { record: { path, content: serializeCloneBase(next) } };
  }

  /**
   * Forget one source: the next copy from it starts as if there had been none. Only the record changes —
   * nothing copied, no login, no secret. Answers whether there was anything to forget.
   */
  async forgetCloneSource(source: string): Promise<boolean> {
    return await this.deps.cloneBase.update(this.#cloneBasePath(), current => {
      const before = parseCloneBase(current);
      // A person names a source the way they know it: the id, the bare id an export carries, or its name.
      const found = findCloneSources(before, source);
      if (found.length === 0) return undefined;
      const [only] = found;
      if (found.length > 1 || only === undefined) {
        throw new FleetSetupRefusal(
          'fleet_setup_refused',
          `More than one source is called ${source}: ${found.join(', ')}. Name one by its id.`,
        );
      }
      return serializeCloneBase(forgetCloneSource(before, only));
    });
  }

  // ── Writing ────────────────────────────────────────────────────────────────────────────────────

  #cloneBasePath(): string {
    return `${this.deps.catalog.layout.fleetDirectory}/${CLONE_BASE_FILE}`;
  }

  #recordPath(): string {
    return `${this.deps.catalog.layout.fleetDirectory}/${IMPORT_RECORD_FILE}`;
  }

  async #recordOption(): Promise<{ record?: ImportRecord }> {
    const record = parseImportRecord(await this.deps.catalog.readAsset(this.#recordPath()));
    return record === undefined ? {} : { record };
  }

  /** The configuration files, then the asset documents, then any document by absolute path — each with what it expects. */
  /**
   * Where a document an update removes lives, refused unless it is inside the asset tree and outside every
   * place a login keeps its sign-in: the credential store, the runtime homes and the harnesses' own homes.
   * The planner only ever names files inside a folder a taken item alone owns; this holds even if it did not.
   */
  #removableAsset(file: string): string {
    const { layout } = this.deps.catalog;
    const absolute = expandAssetPath(file, layout.userHome, layout.assetsDirectory);
    const inside = (root: string): boolean => absolute.startsWith(`${root.replace(/\/+$/u, '')}/`);
    const fenced = [
      `${layout.fleetDirectory.replace(/\/+$/u, '')}/${CREDENTIALS_DIRECTORY}`,
      layout.homesDirectory,
      ...Object.values(layout.defaultHomeDirectories),
    ];
    if (file.split('/').includes('..') || !inside(layout.assetsDirectory) || fenced.some(inside)) {
      throw new FleetCatalogRefusal(
        'fleet_change_refused',
        `${file} is not one of this machine's own setup documents, so an update never removes it. Nothing was changed.`,
      );
    }
    return absolute;
  }

  async #documents(
    reading: AccountDocumentReading,
    model: AccountModel,
    assets: readonly CloneFile[],
    absolute: readonly { readonly path: string; readonly content: string }[],
    removals: readonly string[] = [],
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
    // Removed in the same batch, each only if it is still exactly what the review compared.
    for (const path of removals) {
      documents.push({
        path,
        content: '',
        mode: DOCUMENT_MODE,
        expect: await catalog.documentRevision(path),
        remove: true,
      });
    }
    return documents;
  }

  /**
   * What a person reviewed. A document in `timed` holds the instant of the apply, which differs between the
   * review and the apply, so it counts by the revision it replaces rather than by its text.
   */
  #fingerprint(
    documents: readonly FleetDocumentWrite[],
    secrets: readonly string[],
    timed: readonly string[] = [],
    writes: readonly Pick<ConfigWrite, 'path' | 'text' | 'etag'>[] = [],
  ): string {
    return this.deps.digest(
      JSON.stringify({
        documents: documents.map(document => [
          document.path,
          timed.includes(document.path) ? '' : this.deps.digest(document.content),
          document.expect,
          document.remove === true,
        ]),
        secrets,
        writes: writes.map(write => [write.path, this.deps.digest(write.text), write.etag]),
      }),
    );
  }

  /** What the settings merge does, as the confirm card says it. Keys and counts only: no value is spelled out. */
  #settingsLines(plan: CloneSettingsPlan, machine: string, heldHere: boolean): readonly string[] {
    const { taken, kept } = plan.done;
    if (taken.length === 0 && kept.length === 0) return [];
    const lines = [
      `Settings: ${plural(taken.length, 'key')} taken from the other machine${taken.length === 0 ? '' : ` (${taken.join(', ')})`}, ${plural(kept.length, 'key')} kept as ${machine} has ${kept.length === 1 ? 'it' : 'them'}.`,
    ];
    const loosening = plan.files.filter(file => file.loosens).map(file => file.path);
    if (loosening.length > 0) {
      lines.push(
        `${loosening.join(' and ')} would loosen what ${machine} may spend or do; ${
          heldHere ? 'it is written but held until you confirm it' : 'you are at the machine, so it takes effect now'
        }.`,
      );
    }
    if (plan.controls?.widensAgentControl === true) {
      lines.push(
        `It turns on something agents may control on ${machine}, which asks for a passkey from another device.`,
      );
    }
    return lines;
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
        // An import or a clone publishes the logins a budget holds unavailable too, like every other publish.
        ...budgetHoldsOf(catalog),
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
          ? failedApplySentence(errorMessage(error), documents, catalog.layout.fleetDirectory)
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
