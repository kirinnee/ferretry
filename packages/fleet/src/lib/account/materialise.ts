/**
 * Materialisation — a version-2 fleet as the writes an apply performs
 * (docs/design/account-model.md §5.4, §8, R6, H1).
 *
 * Every runtime becomes two things: a hidden config directory, `<homes>/<runtime id>` (the internal
 * word is "home"; the product never shows it), and a wrapper named after the runtime. This module
 * decides both, as one pure plan the existing provisioner writes inside its rollback boundary:
 *
 * - **ids** — `ids.json` is planned here and written by the same apply, so a runtime and its id land
 *   together. A runtime whose `ids.json` entry names a `home` keeps that config directory.
 * - **credential** — Claude reaches its store through `CLAUDE_SECURESTORAGE_CONFIG_DIR` (`""` for the
 *   person's own login); Codex through its `auth.json`, a link to the one canonical file. A Claude
 *   credential is never linked (§8.1.1). The person's real `HOME` is kept, and a profile that tried to
 *   set it is refused.
 * - **profile** — resolved by `./layering.ts`, adapted by `./adapt.ts`; this module only turns the
 *   result into operations.
 * - **fixed layer** — an agent runtime's launch arguments (`./fixed-layer.ts`), with the launch folder
 *   filled in by the wrapper at launch, because only then is it known.
 * - **history** — one pool per harness, always (`sharedHistoryPoolRequests`).
 *
 * WHAT IS NEVER REMOVED. A config directory is shared with the harness and the person: Claude's
 * `/memory` writes `CLAUDE.md` there. So a destination the profile no longer fills is swept only on
 * evidence it is this plan's own — a link (only the plan makes links there), or a name the previous
 * apply recorded in `.fy/materialised.json`. A regular file or directory with neither stays. Codex's
 * own `skills/.system` is never swept.
 *
 * A runtime that cannot launch — Auto mode on a Claude that does not accept it (O4), a profile with
 * nothing for its harness (P5), a credential with no store to reach (G5) — still materialises. Its
 * wrapper says why and exits, and its published row is unavailable with the same sentence. Everything
 * else that is wrong is a configuration to fix, and is refused while planning, every problem at once.
 *
 * Pure: bodies are read by the caller, an id is minted by an injected function, the clock is a string.
 */
import { secretReferencesIn } from '@ferretry/protocol';
import { HARNESS_ASSETS, HARNESS_OWNED_SKILL_ENTRIES, harnessAsset } from '../assets.ts';
import {
  buildFleetManifest,
  type FleetManifestModel,
  type FleetManifestModelCatalog,
  type HarnessKind,
} from '../manifest.ts';
import { loginModelCatalog, type ModelCatalogSources } from '../models/catalog.ts';
import {
  CODEX_CATALOG_FORMAT,
  CODEX_MODEL_CATALOG_FILE,
  codexCatalogArguments,
  codexCatalogModels,
  renderCodexModelCatalog,
} from '../models/codex-catalog.ts';
import { type RuntimeModels, runtimeModels } from '../models/runtime.ts';
import { expandAssetPath, expandHomePath, joinPath } from '../paths.ts';
import type { FleetLayout, FleetModelApplyPlan, FleetWriteOperation, MaterialisedRecord } from '../provisioning.ts';
import { type SettingsObject, serializeSettings } from '../settings.ts';
import { sharedHistoryPoolDirectory, sharedHistoryPoolRequests } from '../shared-history.ts';
import { CREDENTIAL_ENV } from '../usage.ts';
import {
  MANAGED_MARKER,
  RUNTIME_NAME_ENV,
  renderCommandScript,
  renderRuntimeWrapperScript,
  STATE_HOME_ENV,
} from '../wrappers.ts';
import {
  type AdaptedEntry,
  adaptProfile,
  CLAUDE_JSON_FILE,
  type ClaudeStatuslineCommand,
  componentPartialSupport,
} from './adapt.ts';
import {
  CODEX_CREDENTIAL_FILE,
  codexCredentialLink,
  credentialLaunchArguments,
  credentialLaunchEnvironment,
  resolveCredentialStore,
} from './credentials.ts';
import { type BudgetHolds, binaryNameOf, runtimeDisable } from './disabled-runtime.ts';
import { applyFixedLayer, type FixedLayer, fixedLayerFor } from './fixed-layer.ts';
import { assignRuntimeIds, type RuntimeIds, runtimeIdsPath, serializeRuntimeIds } from './ids.ts';
import { HARNESS_DISPLAY_NAMES, resolveProfile } from './layering.ts';
import type { AccountModel } from './schema.ts';
import { runtimeHarness } from './scope.ts';

const DIRECTORY_MODE = 0o700;
const EXECUTABLE_MODE = 0o755;
const PRIVATE_FILE_MODE = 0o600;

/** Ferretry's own corner of a runtime's config directory: its record and the fixed-layer overlay. */
export const RUNTIME_STATE_DIRECTORY = '.fy';

/** What the previous apply put in a config directory, so the next can tell its leftovers from the person's. */
export const MATERIALISED_RECORD_FILE = 'materialised.json';

/** The `--settings` overlay a Claude agent runtime launches with when the fixed layer needs one. */
export const FIXED_SETTINGS_FILE = 'fixed.json';

/** The folder the fixed layer is computed for while planning; the wrapper fills in the real one. */
const LAUNCH_FOLDER_PLACEHOLDER = '/ferretry-launch-folder';

/**
 * Variables a runtime's launch environment may not carry. `HOME`, because both harnesses find the
 * person's own login under their real home and Claude finds the macOS keychain through it; the config
 * directory is what isolates a runtime. The `FY_*` three, because the wrapper sets them to this
 * runtime's own values and another value would make a statusLine or a claim speak for another one.
 */
const REFUSED_LAUNCH_VARIABLES: Readonly<Record<string, string>> = {
  HOME: 'a runtime keeps your real home, because that is where your own login and keychain are found; its config directory is what keeps it separate',
  [CREDENTIAL_ENV]: "Ferretry sets it to the runtime's own credential",
  [RUNTIME_NAME_ENV]: "Ferretry sets it to the runtime's own name",
  [STATE_HOME_ENV]: 'Ferretry sets it to its own state directory',
};

/** Component bodies the caller read from the asset tree, by component name. */
export interface MaterialiseBodies {
  /** Each settings component's parsed `file`. */
  readonly settings?: Readonly<Record<string, SettingsObject>>;
  /** Instructions text. Needed when a runtime has several to concatenate, and for partial support. */
  readonly instructions?: Readonly<Record<string, string>>;
  /** Each hooks component's parsed `file`. */
  readonly hooks?: Readonly<Record<string, SettingsObject>>;
  /** Each skill item's `SKILL.md` frontmatter keys, by item name, for partial support. */
  readonly skillFrontmatter?: Readonly<Record<string, readonly string[]>>;
}

export interface MaterialiseInput {
  readonly model: AccountModel;
  readonly layout: FleetLayout;
  /** `ids.json` as it is now; {@link EMPTY_RUNTIME_IDS} when there is none. */
  readonly ids: RuntimeIds;
  /** Mints a fresh runtime id (a UUID). */
  readonly mint: () => string;
  readonly generatedAt: string;
  readonly bodies?: MaterialiseBodies;
  /** Claude's statusLine command, bound by the caller to `claudeStatuslineCommand(binary, own)` (`../usage.ts`). */
  readonly claudeStatusline: ClaudeStatuslineCommand;
  /** The `fy` executable a wrapper runs to claim a conversation. */
  readonly fyCommand: string;
  /**
   * Where each harness lives on this host, absolute, as the daemon resolved it. A wrapper execs this
   * path rather than the harness's name, so a session runs the Claude or Codex that was configured and
   * imported, never one a PATH happens to put first (docs/harness-paths.md).
   */
  readonly harnessCommands?: Readonly<Partial<Record<HarnessKind, string>>>;
  /** The person's own Codex home (`hostCodexHome`); absent when it cannot be named. */
  readonly hostCodexHome?: string;
  /** Whether the installed Claude accepts `--permission-mode auto` (O4). */
  readonly acceptsAutoPermissionMode: boolean;
  /** The model ids each credential can use (E23), by credential id. Absent means all of them. */
  readonly availableModels?: Readonly<Record<string, readonly string[]>>;
  /**
   * The logins their spend budget holds now, by credential id (docs/budgets.md): every runtime on one is
   * published unavailable with the budget's sentence, exactly as a `disabled` login is. Absent: none.
   */
  readonly budgetHolds?: BudgetHolds;
  /**
   * The model catalogs and presets in effect (docs/model-catalog.md). A runtime whose login names a
   * catalog offers its models and gets its tier pins; absent, every runtime offers its profile's model set.
   */
  readonly modelCatalogs?: ModelCatalogSources;
}

/** One reason a runtime, or the fleet, cannot be planned. */
export interface MaterialiseProblem {
  /** The runtime or command it is about, or `undefined` for the fleet as a whole. */
  readonly runtime?: string;
  readonly message: string;
}

/** Raised when the configuration asks for something no apply can write, naming every problem at once. */
export class FleetMaterialiseError extends Error {
  constructor(readonly problems: readonly MaterialiseProblem[]) {
    super(
      `the fleet cannot be applied: ${problems.map(problem => (problem.runtime === undefined ? problem.message : `${problem.runtime}: ${problem.message}`)).join('; ')}`,
    );
    this.name = 'FleetMaterialiseError';
  }
}

/** One runtime as the rest of the plan needs it. */
interface PlannedRuntime {
  readonly name: string;
  readonly id: string;
  readonly harness: HarnessKind;
  readonly credential: string;
  readonly profile: string;
  readonly agent: boolean;
  readonly home: string;
  readonly wrapper: string;
  readonly models: readonly FleetManifestModel[];
  readonly modelCatalog?: FleetManifestModelCatalog;
  /** The format of the Codex model catalog file its wrapper points Codex at, when it has one. */
  readonly codexCatalog?: number;
  readonly defaultModel: string | null;
  readonly secretEnv: Readonly<Record<string, string>>;
  /** Why it cannot launch, when it cannot. */
  readonly blocked?: string;
}

const sorted = (record: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));

const UNAVAILABLE_MODEL_REASON = 'Not available on this login';

/** The runtime's models and default as the manifest publishes them (K8, E23, docs/model-catalog.md). */
function publishedModels(derived: RuntimeModels): {
  readonly models: readonly FleetManifestModel[];
  readonly modelCatalog?: FleetManifestModelCatalog;
  readonly defaultModel: string | null;
} {
  return {
    models: derived.models.map(model => {
      const described = {
        id: model.id,
        ...(derived.catalog === undefined ? {} : { displayName: model.label }),
        ...(model.tier === undefined ? {} : { tier: model.tier }),
        ...(model.context === undefined ? {} : { context: model.context }),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        ...(derived.catalog === undefined ? {} : { efforts: model.efforts }),
        ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
      };
      return model.available
        ? { ...described, available: true as const }
        : { ...described, available: false as const, unavailableReason: UNAVAILABLE_MODEL_REASON };
    }),
    ...(derived.catalog === undefined
      ? {}
      : {
          modelCatalog: { id: derived.catalog.id, label: derived.catalog.label, customIds: derived.catalog.customIds },
        }),
    defaultModel: derived.default ?? null,
  };
}

/** The fixed layer without the launch folder: the wrapper trusts the real folder at launch. */
function withoutLaunchFolder(layer: FixedLayer): FixedLayer {
  const args: string[] = [];
  for (let index = 0; index < layer.args.length; index++) {
    const arg = layer.args[index] as string;
    // Codex's trust override is the one argument naming the folder, and always follows its `-c`.
    if (arg === '-c' && (layer.args[index + 1] ?? '').startsWith('projects=')) {
      index++;
      continue;
    }
    args.push(arg);
  }
  const { claudeJson: _seededByTheWrapper, ...rest } = layer;
  return { ...rest, args, entries: layer.entries.filter(entry => entry.purpose !== 'trust') };
}

/** The top-level name an entry occupies in the config directory. */
const topLevel = (dest: string): string => dest.split('/')[0] as string;

/**
 * Plan the whole version-2 fleet. Throws {@link FleetMaterialiseError} naming every problem when the
 * configuration asks for something no apply can write; never writes anything itself.
 */
export function materialiseFleet(input: MaterialiseInput): FleetModelApplyPlan {
  const { model, layout } = input;
  const problems: MaterialiseProblem[] = [];
  const runtimeNames = Object.keys(model.runtimes).toSorted();
  const ids = assignRuntimeIds(runtimeNames, input.ids, input.mint);
  const fleet = layout.fleetDirectory;
  const codexSqliteHome = joinPath(sharedHistoryPoolDirectory(fleet, 'codex'), 'sqlite');
  const credentialStorePaths = {
    fleetRoot: fleet,
    userHome: layout.userHome,
    ...(input.hostCodexHome === undefined ? {} : { hostCodexHome: input.hostCodexHome }),
  };
  const partialSupport = componentPartialSupport({
    components: model.components,
    ...(input.bodies?.skillFrontmatter === undefined ? {} : { skillFrontmatter: input.bodies.skillFrontmatter }),
    ...(input.bodies?.instructions === undefined ? {} : { instructionBodies: input.bodies.instructions }),
  });

  const operations: FleetWriteOperation[] = [
    { kind: 'directory', path: fleet, mode: DIRECTORY_MODE },
    { kind: 'directory', path: layout.binDirectory, mode: DIRECTORY_MODE },
    { kind: 'directory', path: layout.homesDirectory, mode: DIRECTORY_MODE },
    { kind: 'file', path: runtimeIdsPath(fleet), content: serializeRuntimeIds(ids), mode: PRIVATE_FILE_MODE },
  ];

  // Every Ferretry-kept login gets its directory, used or not: an empty slot (C8) has no login yet,
  // and a sign-in needs somewhere to write one.
  for (const [id, credential] of Object.entries(model.credentials).toSorted(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    const resolution = resolveCredentialStore(id, credential, credentialStorePaths);
    if (!('ownedDirectory' in resolution) || resolution.ownedDirectory === undefined) continue;
    operations.push({ kind: 'directory', path: resolution.ownedDirectory, mode: DIRECTORY_MODE });
  }
  if (runtimeNames.some(name => model.credentials[model.runtimes[name]?.credential ?? '']?.harness === 'codex')) {
    operations.push({ kind: 'directory', path: codexSqliteHome, mode: DIRECTORY_MODE });
  }

  const now = Date.parse(input.generatedAt);
  const binary = binaryNameOf(input.fyCommand);
  const planned: PlannedRuntime[] = [];
  const homeOwners = new Map<string, string>();
  for (const name of runtimeNames) {
    const runtime = model.runtimes[name];
    const credential = runtime === undefined ? undefined : model.credentials[runtime.credential];
    // The schema refused both; only a hand-built model could get here.
    if (runtime === undefined || credential === undefined) continue;
    const entry = ids.runtimes[name] as RuntimeIds['runtimes'][string];
    const harness = runtimeHarness(model, runtime) as HarnessKind;
    const home =
      entry.home === undefined
        ? joinPath(layout.homesDirectory, entry.id)
        : expandHomePath(entry.home, layout.userHome, layout.homesDirectory);
    const owner = homeOwners.get(home);
    if (owner !== undefined) {
      problems.push({ runtime: name, message: `its config directory ${home} is already runtime "${owner}"'s` });
      continue;
    }
    homeOwners.set(home, name);
    const wrapper = joinPath(layout.binDirectory, name);
    const reasons: string[] = [];
    reasons.push(...(runtimeDisable(model, name, now, binary, input.budgetHolds)?.clauses ?? []));

    const store = resolveCredentialStore(runtime.credential, credential, credentialStorePaths, harness);
    if ('unavailable' in store)
      reasons.push(`its login "${runtime.credential}" cannot be reached: ${store.unavailable}`);
    if (store.store === 'environment' && store.problem !== undefined) {
      reasons.push(`its login "${runtime.credential}" cannot launch: ${store.problem}`);
    }

    const availableModels = input.availableModels?.[runtime.credential];
    const resolution = resolveProfile({
      model,
      profile: runtime.profile,
      harness,
      ...(input.bodies?.settings === undefined ? {} : { settingsBodies: input.bodies.settings }),
      ...(availableModels === undefined ? {} : { availableModels }),
      partialSupport,
    });
    if (!resolution.ok) {
      problems.push({
        runtime: name,
        message: `profile "${runtime.profile}" cannot be read: ${resolution.failure.kind}`,
      });
      continue;
    }
    const resolved = resolution.resolved;
    if (!resolved.availability.available) {
      reasons.push(
        resolved.availability.reason === 'empty'
          ? `profile "${runtime.profile}" has no layers`
          : `nothing in profile "${runtime.profile}" applies to ${HARNESS_DISPLAY_NAMES[harness]}`,
      );
    }
    for (const unread of resolved.settings.unread) {
      problems.push({ runtime: name, message: `settings "${unread}" could not be read` });
    }

    // The fixed layer, for an agent: computed for a placeholder folder, which never reaches a file.
    let fixed: FixedLayer | undefined;
    if (runtime.agent) {
      const result =
        harness === 'claude'
          ? fixedLayerFor({
              harness,
              agentPermissions: model.machine.agentPermissions,
              cwd: LAUNCH_FOLDER_PLACEHOLDER,
              acceptsAutoPermissionMode: input.acceptsAutoPermissionMode,
              fyCommand: input.fyCommand,
            })
          : fixedLayerFor({
              harness,
              agentPermissions: model.machine.agentPermissions,
              cwd: LAUNCH_FOLDER_PLACEHOLDER,
              fyCommand: input.fyCommand,
            });
      if (result.ok) fixed = withoutLaunchFolder(result.layer);
      else reasons.push(result.refusal.message);
    }
    const launch = fixed === undefined ? undefined : applyFixedLayer(resolved, fixed);

    const adapted = adaptProfile({
      resolved,
      plumbing:
        harness === 'claude'
          ? { harness, statusLine: input.claudeStatusline }
          : { harness, sqliteHome: codexSqliteHome },
      bodies: {
        ...(input.bodies?.instructions === undefined ? {} : { instructions: input.bodies.instructions }),
        ...(input.bodies?.hooks === undefined ? {} : { hooks: input.bodies.hooks }),
      },
      ...(launch === undefined ? {} : { settings: launch.settings }),
    });
    for (const problem of adapted.problems) problems.push({ runtime: name, message: problem.message });

    // The launch environment: the credential's, the profile's, the MCP servers' forwarded secrets,
    // then Ferretry's own. A refused variable is a configuration to fix, never silently dropped.
    const derived = runtimeModels({
      harness,
      modelSet: resolved.modelSet,
      ...(availableModels === undefined ? {} : { availableModels }),
      ...(input.modelCatalogs === undefined ? {} : loginModelCatalog(credential, harness, input.modelCatalogs)),
    });
    const profileEnv = Object.fromEntries(
      Object.entries(resolved.env).map(([variable, { value }]) => [variable, value]),
    );
    const env: Record<string, string> = {
      ...credentialLaunchEnvironment(store),
      ...derived.env,
      ...profileEnv,
      ...adapted.launchEnv,
    };
    for (const [variable, reason] of Object.entries(REFUSED_LAUNCH_VARIABLES)) {
      if (variable in env) problems.push({ runtime: name, message: `it may not set ${variable}: ${reason}` });
    }
    env[CREDENTIAL_ENV] = runtime.credential;
    env[RUNTIME_NAME_ENV] = name;
    env[STATE_HOME_ENV] = layout.stateHome;
    if (harness === 'codex') env.CODEX_SQLITE_HOME = codexSqliteHome;

    // Codex's own picker lists OpenAI's models and knows nothing of this login's provider, so a runtime on
    // a third-party catalog is given the catalog as the list to offer (docs/model-catalog.md). A person's
    // own `model_catalog_json` is theirs, and stands.
    const codexModels = harness === 'codex' ? codexCatalogModels(derived) : undefined;
    const codexCatalog =
      codexModels === undefined || 'model_catalog_json' in adapted.settings.value
        ? undefined
        : renderCodexModelCatalog(codexModels, derived.default);
    const codexCatalogPath = joinPath(joinPath(home, RUNTIME_STATE_DIRECTORY), CODEX_MODEL_CATALOG_FILE);

    operations.push(
      ...configDirectoryOperations({
        home,
        harness,
        codexCatalog,
        entries: adapted.entries,
        absent: adapted.absent,
        settings: adapted.settings,
        claudeJson: adapted.claudeJson,
        overlay: fixed?.claudeSettingsOverlay,
        credentialLink: codexCredentialLink(home, store),
        layout,
      }),
    );

    const fixedSettingsArgs =
      fixed?.claudeSettingsOverlay === undefined
        ? []
        : ['--settings', joinPath(joinPath(home, RUNTIME_STATE_DIRECTORY), FIXED_SETTINGS_FILE)];
    const { models, modelCatalog, defaultModel } = publishedModels(derived);
    const blocked = reasons.length === 0 ? undefined : reasons.join('; ');
    operations.push({
      kind: 'file',
      path: wrapper,
      content: renderRuntimeWrapperScript({
        name,
        id: entry.id,
        harness,
        agent: runtime.agent,
        configDirectory: home,
        env,
        args: [
          ...credentialLaunchArguments(store, defaultModel !== null),
          ...(codexCatalog === undefined ? [] : codexCatalogArguments(codexCatalogPath)),
          ...(launch === undefined ? resolved.flags.map(flag => flag.flag) : [...launch.args, ...fixedSettingsArgs]),
        ],
        defaultModel: defaultModel ?? undefined,
        seedFirstRun: runtime.agent && harness === 'claude',
        trustLaunchFolder: runtime.agent && harness === 'codex',
        fyCommand: input.fyCommand,
        secretsFile: model.advanced.secretsFile,
        harnessCommand: input.harnessCommands?.[harness],
        refusal: blocked,
      }),
      mode: EXECUTABLE_MODE,
    });

    planned.push({
      name,
      id: entry.id,
      harness,
      credential: runtime.credential,
      profile: runtime.profile,
      agent: runtime.agent,
      home,
      wrapper,
      models,
      ...(modelCatalog === undefined ? {} : { modelCatalog }),
      ...(codexCatalog === undefined ? {} : { codexCatalog: CODEX_CATALOG_FORMAT }),
      defaultModel,
      secretEnv: sorted(
        Object.fromEntries(Object.entries(env).filter(([, value]) => secretReferencesIn(value).length > 0)),
      ),
      ...(blocked === undefined ? {} : { blocked }),
    });
  }

  const commandNames = commandOperations(input, planned, operations, problems);
  if (problems.length > 0) throw new FleetMaterialiseError(problems);

  operations.push({
    kind: 'prune',
    path: layout.binDirectory,
    marker: MANAGED_MARKER,
    keep: [...planned.map(runtime => runtime.name), ...commandNames],
  });

  const manifest = buildFleetManifest({
    generatedAt: input.generatedAt,
    // The launch inventory: one row per runtime, the contract every launch reads — start resolution,
    // the boot preflight, doctor and the launch environment's secret variables. A row is a runtime
    // seen as something to launch (its wrapper, config directory, mode and availability);
    // `runtimes` below says what the runtime IS in the account model's words.
    accounts: planned.map(runtime => {
      const reason =
        runtime.blocked ??
        (runtime.defaultModel === null ? `profile "${runtime.profile}" names no model it can use` : undefined);
      return {
        id: runtime.id,
        kind: runtime.harness,
        mode: runtime.agent ? 'auto' : 'interactive',
        wrapper: runtime.wrapper,
        home: runtime.home,
        displayName: runtime.name,
        defaultModel: runtime.defaultModel,
        models: runtime.models,
        ...(runtime.modelCatalog === undefined ? {} : { modelCatalog: runtime.modelCatalog }),
        ...(runtime.codexCatalog === undefined ? {} : { codexCatalog: runtime.codexCatalog }),
        available: reason === undefined,
        unavailableReason: reason ?? null,
        secretEnv: runtime.secretEnv,
      };
    }),
    runtimes: planned.map(runtime => ({
      id: runtime.id,
      name: runtime.name,
      harness: runtime.harness,
      credential: runtime.credential,
      profile: runtime.profile,
      agent: runtime.agent,
      wrapper: runtime.wrapper,
      models: runtime.models,
      defaultModel: runtime.defaultModel,
    })),
  });

  const homesOf = (harness: HarnessKind) =>
    planned
      .filter(runtime => runtime.harness === harness)
      .map(runtime => ({ account: runtime.id, path: runtime.home }));
  return {
    manifest,
    manifestPath: layout.manifestPath,
    operations,
    sharedHistoryRequests: sharedHistoryPoolRequests(fleet, { claude: homesOf('claude'), codex: homesOf('codex') }),
    ids,
  };
}

interface ConfigDirectoryInput {
  readonly home: string;
  readonly harness: HarnessKind;
  readonly entries: readonly AdaptedEntry[];
  readonly absent: readonly string[];
  readonly settings: ReturnType<typeof adaptProfile>['settings'];
  readonly claudeJson: SettingsObject | undefined;
  readonly overlay: SettingsObject | undefined;
  /** The text of the model catalog file a Codex runtime on a third-party provider reads. */
  readonly codexCatalog: string | undefined;
  readonly credentialLink: ReturnType<typeof codexCredentialLink>;
  readonly layout: FleetLayout;
}

/**
 * One runtime's config directory: the directory, the narrowed sweep of what the profile no longer
 * fills, every entry, the skills folder per item, the generated settings, the credential link, and the
 * record the next apply reads.
 */
function configDirectoryOperations(input: ConfigDirectoryInput): readonly FleetWriteOperation[] {
  const { home, harness, layout } = input;
  const state = joinPath(home, RUNTIME_STATE_DIRECTORY);
  const record = joinPath(state, MATERIALISED_RECORD_FILE);
  const skillsDest = (harnessAsset(HARNESS_ASSETS, harness, 'skills') as { readonly dest: string }).dest;
  const skillEntries = input.entries.filter(entry => entry.dest.startsWith(`${skillsDest}/`));
  const ownEntries = input.entries.filter(entry => !entry.dest.startsWith(`${skillsDest}/`));
  const skillsContainer = joinPath(home, skillsDest);

  const operations: FleetWriteOperation[] = [
    { kind: 'directory', path: home, mode: DIRECTORY_MODE },
    { kind: 'directory', path: state, mode: DIRECTORY_MODE },
    // Ferretry's corner is wholly its own, so it is swept outright, down to what this apply writes.
    {
      kind: 'prune-directory',
      path: state,
      keep: [
        MATERIALISED_RECORD_FILE,
        ...(input.overlay === undefined ? [] : [FIXED_SETTINGS_FILE]),
        ...(input.codexCatalog === undefined ? [] : [CODEX_MODEL_CATALOG_FILE]),
      ],
    },
    // The config directory is not: only a link, or a name the last apply recorded, is removed.
    { kind: 'prune-directory', path: home, keep: [], only: input.absent, record },
  ];

  for (const entry of ownEntries) operations.push(entryOperation(entry, home, layout));

  operations.push({ kind: 'directory', path: skillsContainer, mode: DIRECTORY_MODE });
  for (const entry of skillEntries) operations.push(entryOperation(entry, home, layout));
  operations.push({
    kind: 'prune-directory',
    path: skillsContainer,
    keep: [
      ...skillEntries.map(entry => entry.dest.slice(skillsDest.length + 1)),
      ...HARNESS_OWNED_SKILL_ENTRIES[harness],
    ],
  });

  operations.push({
    kind: 'settings',
    path: joinPath(home, input.settings.dest),
    format: input.settings.format,
    layers: [{ from: 'inline', settings: input.settings.value }],
    mode: PRIVATE_FILE_MODE,
    // The harness writes its own keys there (`/effort`), and a re-apply must not reset them.
    preserveExisting: true,
  });
  if (input.claudeJson !== undefined) {
    operations.push({
      kind: 'settings',
      path: joinPath(home, CLAUDE_JSON_FILE),
      format: 'json',
      layers: [{ from: 'inline', settings: input.claudeJson }],
      mode: PRIVATE_FILE_MODE,
      // Claude keeps its own state in this file, so all of it survives — except the keys the profile
      // owns outright, which are replaced whole so a removed MCP server leaves too.
      preserveExisting: true,
      replaceKeys: Object.keys(input.claudeJson),
    });
  }
  if (input.overlay !== undefined) {
    operations.push({
      kind: 'file',
      path: joinPath(state, FIXED_SETTINGS_FILE),
      content: serializeSettings(input.overlay, 'json'),
      mode: PRIVATE_FILE_MODE,
    });
  }
  if (input.codexCatalog !== undefined) {
    operations.push({
      kind: 'file',
      path: joinPath(state, CODEX_MODEL_CATALOG_FILE),
      content: input.codexCatalog,
      mode: PRIVATE_FILE_MODE,
    });
  }
  if (input.credentialLink !== undefined) {
    // The one link to a credential: the canonical file may not exist yet (an empty slot), and Codex
    // writes the login THROUGH the link when somebody signs in.
    operations.push({
      kind: 'symlink',
      source: input.credentialLink.target,
      path: input.credentialLink.path,
      dangling: true,
    });
  }

  const recorded: MaterialisedRecord = {
    version: 1,
    entries: [
      ...new Set([
        ...ownEntries.map(entry => topLevel(entry.dest)),
        ...(input.credentialLink === undefined ? [] : [CODEX_CREDENTIAL_FILE]),
      ]),
    ].toSorted(),
  };
  // After the sweep, so the sweep read the PREVIOUS apply's record.
  operations.push({ kind: 'file', path: record, content: `${JSON.stringify(recorded)}\n`, mode: PRIVATE_FILE_MODE });
  return operations;
}

/** One adapted entry as the write that puts it in the config directory. */
function entryOperation(entry: AdaptedEntry, home: string, layout: FleetLayout): FleetWriteOperation {
  const path = joinPath(home, entry.dest);
  if (entry.kind === 'generated') return { kind: 'file', path, content: entry.content, mode: PRIVATE_FILE_MODE };
  const source = expandAssetPath(entry.source, layout.userHome, layout.assetsDirectory);
  return entry.kind === 'link' ? { kind: 'symlink', source, path } : { kind: 'copy', source, path };
}

/**
 * `advanced.commands` and `advanced.aliases`: thin executables that run one runtime with extra flags
 * first. An alias makes one per runtime of each harness it names, `<alias>-<runtime>`. Returns every
 * name written, for the bin sweep; a name two of them would claim is a problem.
 */
function commandOperations(
  input: MaterialiseInput,
  planned: readonly PlannedRuntime[],
  operations: FleetWriteOperation[],
  problems: MaterialiseProblem[],
): readonly string[] {
  const { advanced } = input.model;
  const byName = new Map(planned.map(runtime => [runtime.name, runtime]));
  const owners = new Map<string, string>(planned.map(runtime => [runtime.name, `runtime ${runtime.name}`]));
  const commands: {
    readonly wrapper: string;
    readonly runtime: PlannedRuntime;
    readonly flags: readonly string[];
    readonly alias?: string;
  }[] = [];
  for (const command of advanced.commands) {
    const runtime = byName.get(command.runtime);
    if (runtime !== undefined) commands.push({ wrapper: command.wrapper, runtime, flags: command.flags });
  }
  for (const [alias, byHarness] of Object.entries(advanced.aliases).toSorted(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    for (const runtime of planned) {
      const flags = byHarness[runtime.harness];
      if (flags === undefined) continue;
      commands.push({
        wrapper: `${alias}-${runtime.name}`,
        runtime,
        flags: typeof flags === 'string' ? flags.trim().split(/\s+/).filter(Boolean) : flags,
        alias,
      });
    }
  }
  const names: string[] = [];
  for (const command of commands) {
    const claimant = command.alias === undefined ? `command ${command.wrapper}` : `alias ${command.alias}`;
    const owner = owners.get(command.wrapper);
    if (owner !== undefined) {
      problems.push({
        runtime: command.wrapper,
        message: `${claimant} and ${owner} would both be the executable "${command.wrapper}"`,
      });
      continue;
    }
    owners.set(command.wrapper, claimant);
    names.push(command.wrapper);
    operations.push({
      kind: 'file',
      path: joinPath(input.layout.binDirectory, command.wrapper),
      content: renderCommandScript({
        command: { wrapper: command.wrapper, target: command.runtime.id, flags: command.flags, alias: command.alias },
        targetWrapper: command.runtime.name,
        binDir: input.layout.binDirectory,
      }),
      mode: EXECUTABLE_MODE,
    });
  }
  return names;
}
