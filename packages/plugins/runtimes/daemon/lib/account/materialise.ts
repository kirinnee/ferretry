/**
 * Materialisation — a format-1 fleet as the writes an apply performs
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
 * WHAT IS NEVER REMOVED OR REPLACED. A config directory is shared with the harness and the person: Claude's
 * `/memory` writes `CLAUDE.md` there, and the person adds skills, notes and servers. ONE rule covers every removal and
 * every replacement: an entry is taken away only when what is there NOW is provably what Ferretry wrote there — the
 * record of THIS runtime (`.fy/materialised.json`) names the exact path, and the entry still matches what it recorded
 * (a file: the same hash; a link: the same stamp; a folder: written by Ferretry). Anything else stays, and is named.
 * Neither a link, nor a header, nor text that matches what would be written proves anything. Codex's own
 * `skills/.system` is never swept.
 *
 * A runtime that cannot launch — Auto mode on a Claude that does not accept it (O4), a profile with
 * nothing for its harness (P5), a credential with no store to reach (G5) — still materialises. Its
 * wrapper says why and exits, and its published row is unavailable with the same sentence. Everything
 * else that is wrong is a configuration to fix, and is refused while planning, every problem at once.
 *
 * Pure: bodies are read by the caller, an id is minted by an injected function, the clock is a string.
 */
import { secretReferencesIn } from '@ferretry/core-vault/contract';
import type { LoginLaunchStore } from '@ferretry/plugin-logins/contract';
import { looksSecret, namesCredential } from '@ferretry/std/credential-words';
import type { z } from 'zod';
import type { CompactAtSchema, RuntimesHarnessKit } from '../../../contract/index.ts';
import { HARNESS_ASSETS, HARNESS_OWNED_SKILL_ENTRIES, harnessAsset } from '../assets.ts';
import {
  buildFleetManifest,
  type FleetManifestModel,
  type FleetManifestModelCatalog,
  type HarnessKind,
} from '../manifest.ts';
import { loginModelCatalog, type ModelCatalogSources } from '../models/catalog.ts';
import { CODEX_CATALOG_FORMAT, CODEX_MODEL_CATALOG_FILE } from '../models/codex-catalog.ts';
import { type RuntimeModels, runtimeModels } from '../models/runtime.ts';
import { expandAssetPath, expandHomePath, joinPath } from '../paths.ts';
import type { FleetLayout, FleetModelApplyPlan, FleetWriteOperation, MaterialisedRecord } from '../provisioning.ts';
import { type SettingsObject, serializeSettings } from '../settings.ts';
import { sharedHistoryPoolRequests } from '../shared-history.ts';
import { CREDENTIAL_ENV } from '../foreign.ts';
import { harnessKeyOfKind, isKind, unsupportedHarnessSentence } from '../harness-kind.ts';
import {
  MANAGED_MARKER,
  RUNTIME_NAME_ENV,
  renderCommandScript,
  autonomousPreparation,
  renderRuntimeWrapperScript,
  STATE_HOME_ENV,
} from '../wrappers.ts';
import {
  type AdaptedEntry,
  adaptProfile,
  CLAUDE_JSON_FILE,
  type ClaudeStatuslineCommand,
  componentPartialSupport,
  type KitRefusal,
  kitlessAdaptation,
  missingKitRefusal,
  plumbingOf,
  priorServersOf,
  SKILLS_STORE_DIRECTORY,
} from './adapt.ts';
import {
  CODEX_CREDENTIAL_FILE,
  codexCredentialLink,
  codexWrapperLink,
  credentialLaunchArguments,
  credentialLaunchEnvironment,
  resolveCredentialStore,
} from './credentials.ts';
import { type BudgetHolds, binaryNameOf, runtimeDisable } from './disabled-runtime.ts';
import { applyFixedLayer, CODEX_KILL_RULES_FILE, type FixedLayer, fixedLayerOf } from './fixed-layer.ts';
import { assignRuntimeIds, type RuntimeIds, runtimeIdsPath, serializeRuntimeIds } from './ids.ts';
import { HARNESS_DISPLAY_NAMES, resolveProfile } from './layering.ts';
import type { AccountModel } from './schema.ts';
import { runtimeHarness } from './scope.ts';
import { runtimeExtras, sqliteHomeOf, usesSqliteHome } from './runtime-extras.ts';

const DIRECTORY_MODE = 0o700;
const EXECUTABLE_MODE = 0o755;
const PRIVATE_FILE_MODE = 0o600;

/** Ferretry's own corner of a runtime's config directory: its record and the fixed-layer overlay. */
export const RUNTIME_STATE_DIRECTORY = '.fy';

/** What the previous apply put in a config directory, so the next can tell its leftovers from the person's. */
export const MATERIALISED_RECORD_FILE = 'materialised.json';

/** The `--settings` overlay a Claude agent runtime launches with when the fixed layer needs one. */
export const FIXED_SETTINGS_FILE = 'fixed.json';

/** The folder of a Codex home Codex reads its rules from: the one place a rule outranks the approval policy. */
const CODEX_RULES_DIRECTORY = 'rules';

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
  /** What each harness's own plugin hands Runtimes (`RuntimesHarnessKit`); a harness with none has no entry. */
  readonly kits?: ReadonlyMap<HarnessKind, RuntimesHarnessKit>;
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
  /**
   * Where Logins keeps each Ferretry-kept login (`LoginsApi.launchStores`): the one place a runtime's wrapper and home
   * learn the store, so a person-run wrapper is signed in where a ferret is. Absent: no `ferretry` login is reachable.
   */
  readonly loginStores?: readonly LoginLaunchStore[];
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
  readonly home: string;
  readonly wrapper: string;
  readonly models: readonly FleetManifestModel[];
  readonly modelCatalog?: FleetManifestModelCatalog;
  /** The format of the Codex model catalog file its wrapper points Codex at, when it has one. */
  readonly codexCatalog?: number;
  readonly defaultModel: string | null;
  /** The runtime's own `compactAt`, else its profile's. Absent is `auto`. */
  readonly compactAt?: z.infer<typeof CompactAtSchema>;
  readonly secretEnv: Readonly<Record<string, string>>;
  /** The login's, profile's and model variables whose value names no secret (an MCP check fills `${VAR}` from them). */
  readonly launchEnv?: Readonly<Record<string, string>>;
  /** Why it cannot launch at all, when it cannot. */
  readonly blocked?: string;
  /** Why it cannot start an AUTO ferret only: every other launch is still admitted. */
  readonly autoRefusal?: string;
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

/**
 * Plan the whole format-1 fleet. Throws {@link FleetMaterialiseError} naming every problem when the
 * configuration asks for something no apply can write; never writes anything itself.
 */
export function materialiseFleet(input: MaterialiseInput): FleetModelApplyPlan {
  const { model, layout } = input;
  const problems: MaterialiseProblem[] = [];
  const runtimeNames = Object.keys(model.runtimes).toSorted();
  const ids = assignRuntimeIds(runtimeNames, input.ids, input.mint);
  const fleet = layout.fleetDirectory;
  const sqliteHome = sqliteHomeOf(fleet);
  const loginStores = new Map((input.loginStores ?? []).map(store => [store.id, store] as const));
  const credentialStorePaths = {
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

  // A Ferretry-kept login's store is Logins' (it makes the directory a sign-in writes into): nothing is created for one here.
  if (
    runtimeNames.some(name => usesSqliteHome(model.credentials[model.runtimes[name]?.credential ?? '']?.harness ?? ''))
  ) {
    operations.push({ kind: 'directory', path: sqliteHome, mode: DIRECTORY_MODE });
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
    // A derived runtime whose pinned model is gone, or whose pins nobody could read, is refused by name: never moved to the live default.
    if (runtime.refused !== undefined) reasons.push(runtime.refused);

    const store = resolveCredentialStore(
      runtime.credential,
      credential,
      credentialStorePaths,
      input.kits,
      harness,
      loginStores,
    );
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

    // The fixed layer: computed for a placeholder folder, which never reaches a file.
    let fixed: FixedLayer | undefined;
    // What this harness's own plugin hands Runtimes (absent when its plugin is off); every group below is given it.
    const kit = input.kits?.get(harness);
    // A Claude runtime whose plugin gives no kit is published unavailable and writes nothing; every other runtime is planned as usual.
    // ...and so is one whose kit gives no launch line (E-276 PR 8), in the same words.
    const kitMissing: KitRefusal | undefined =
      missingKitRefusal(harness, kit) ??
      (isKind(harness, 'claude') && kit?.wrapper === undefined
        ? { kind: 'harness-unsupported', message: unsupportedHarnessSentence(harnessKeyOfKind('claude')) }
        : undefined);
    // (A login whose own store already says so is not said twice.)
    if (kitMissing !== undefined && !('unavailable' in store)) reasons.push(kitMissing.message);
    const result = fixedLayerOf(
      harness,
      {
        agentPermissions: model.machine.agentPermissions,
        cwd: LAUNCH_FOLDER_PLACEHOLDER,
        acceptsAutoPermissionMode: input.acceptsAutoPermissionMode,
        fyCommand: input.fyCommand,
      },
      kit,
    );
    if (result.ok) fixed = withoutLaunchFolder(result.layer);
    // A missing kit (`harness-unsupported`) refuses the WHOLE runtime above, so it is never also an auto refusal. Any other
    // refusal is an auto launch the harness cannot honour: it refuses THAT launch only, so the person's own run and an
    // interactive ferret never get the fixed layer and are not stopped by it.
    const autoRefusal = result.ok || result.refusal.kind === 'harness-unsupported' ? undefined : result.refusal.message;
    const launch = fixed === undefined ? undefined : applyFixedLayer(resolved, fixed);

    const adapted =
      kitMissing !== undefined
        ? kitlessAdaptation(harness)
        : adaptProfile({
            resolved,
            plumbing: plumbingOf(
              harness,
              { claudeStatusline: input.claudeStatusline, codexSqliteHome: sqliteHome },
              kit,
            ),
            kit,
            bodies: {
              ...(input.bodies?.instructions === undefined ? {} : { instructions: input.bodies.instructions }),
              ...(input.bodies?.hooks === undefined ? {} : { hooks: input.bodies.hooks }),
              // A skill item whose `SKILL.md` the caller could not read has no copy in the asset tree: nothing to link.
              ...(input.bodies?.skillFrontmatter === undefined
                ? {}
                : { skillItems: new Set(Object.keys(input.bodies.skillFrontmatter)) }),
            },
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
      ...credentialLaunchEnvironment(store, input.kits),
      ...derived.env,
      ...profileEnv,
      ...adapted.launchEnv,
    };
    for (const [variable, reason] of Object.entries(REFUSED_LAUNCH_VARIABLES)) {
      if (variable in env) problems.push({ runtime: name, message: `it may not set ${variable}: ${reason}` });
    }
    // The variables a person's own configuration sets that carry no secret: what a check may fill from. A name that is a
    // credential's (a token, a key) or a value that looks like one is never published, whether or not it names a secret.
    const plainLaunchEnv: Record<string, string> = Object.fromEntries(
      // The login's OWN variables (an environment login's), not Ferretry's credential-store plumbing.
      Object.entries({ ...(store.store === 'environment' ? store.env : {}), ...derived.env, ...profileEnv }).filter(
        ([variable, value]) =>
          secretReferencesIn(value).length === 0 && !namesCredential(variable) && !looksSecret(variable, value),
      ),
    );
    env[CREDENTIAL_ENV] = runtime.credential;
    env[RUNTIME_NAME_ENV] = name;
    env[STATE_HOME_ENV] = layout.stateHome;
    // What only this harness's runtime has (Codex's shared history database, and a catalog of the login's own models).
    const extras = runtimeExtras(
      harness,
      {
        sqliteHome,
        statePath: joinPath(home, RUNTIME_STATE_DIRECTORY),
        derived,
        settings: adapted.settings.value,
      },
      kit,
    );
    Object.assign(env, extras.env);
    const codexCatalog = extras.catalog?.text;

    // An unavailable runtime for want of its kit writes nothing into its home.
    if (kitMissing === undefined)
      operations.push(
        ...configDirectoryOperations({
          home,
          harness,
          codexCatalog,
          entries: adapted.entries,
          absent: adapted.absent,
          settings: adapted.settings,
          claudeJson: adapted.claudeJson,
          // A callback: a harness whose document keeps no prior servers never filters them.
          priorServers: priorServersOf(
            harness,
            () =>
              Object.fromEntries(
                Object.entries(model.components.mcp).filter(
                  ([serverName]) => !resolved.mcp.some(contribution => contribution.layer.name === serverName),
                ),
              ),
            kit,
          ),
          overlay: fixed?.claudeSettingsOverlay,
          codexRules: fixed?.codexRules,
          credentialLink: codexCredentialLink(home, store),
          layout,
        }),
      );

    const fixedSettingsArgs =
      fixed?.claudeSettingsOverlay === undefined
        ? []
        : ['--settings', joinPath(joinPath(home, RUNTIME_STATE_DIRECTORY), FIXED_SETTINGS_FILE)];
    const { models, modelCatalog, defaultModel } = publishedModels(derived);
    const compactAt = runtime.compactAt ?? model.profiles[runtime.profile]?.compactAt;
    const launchPrefix = [...credentialLaunchArguments(store, defaultModel !== null), ...(extras.catalog?.args ?? [])];
    // The wrapper refuses only what stops EVERY launch. An auto launch the harness cannot honour is refused inside the
    // wrapper's auto block and published as `autoRefusal`, so a start admits it per launch mode and the runtime stays
    // available for every other mode.
    const blocked = reasons.length === 0 ? undefined : reasons.join('; ');
    const wrapperBlocked = blocked;
    operations.push({
      kind: 'file',
      path: wrapper,
      content: renderRuntimeWrapperScript({
        name,
        id: entry.id,
        harness,
        configDirectory: home,
        env,
        // What the person's own run, and an interactive ferret, gets: the profile's flags and nothing of the fixed layer.
        args: [...launchPrefix, ...resolved.flags.map(flag => flag.flag)],
        defaultModel: defaultModel ?? undefined,
        // What a ferret started in auto mode gets instead (the wrapper runs it only for FY_SESSION_MODE=auto).
        autonomous:
          launch === undefined || kitMissing !== undefined
            ? { refusal: result.ok ? '' : result.refusal.message }
            : {
                args: [...launchPrefix, ...launch.args, ...fixedSettingsArgs],
                ...autonomousPreparation(harness, kit),
              },
        fyCommand: input.fyCommand,
        secretsFile: model.advanced.secretsFile,
        harnessCommand: input.harnessCommands?.[harness],
        kit,
        signInLink: codexWrapperLink(home, store),
        refusal: wrapperBlocked,
      }),
      mode: EXECUTABLE_MODE,
    });

    planned.push({
      name,
      id: entry.id,
      harness,
      credential: runtime.credential,
      profile: runtime.profile,
      home,
      wrapper,
      models,
      ...(modelCatalog === undefined ? {} : { modelCatalog }),
      ...(codexCatalog === undefined ? {} : { codexCatalog: CODEX_CATALOG_FORMAT }),
      defaultModel,
      ...(compactAt === undefined ? {} : { compactAt }),
      secretEnv: sorted(
        Object.fromEntries(Object.entries(env).filter(([, value]) => secretReferencesIn(value).length > 0)),
      ),
      ...(Object.keys(plainLaunchEnv).length === 0 ? {} : { launchEnv: sorted(plainLaunchEnv) }),
      ...(blocked === undefined ? {} : { blocked }),
      ...(autoRefusal === undefined ? {} : { autoRefusal }),
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
        // Every runtime is launched by Ferretry; the session's own mode (auto | interactive) is chosen per launch.
        mode: 'auto',
        wrapper: runtime.wrapper,
        home: runtime.home,
        displayName: runtime.name,
        defaultModel: runtime.defaultModel,
        models: runtime.models,
        ...(runtime.modelCatalog === undefined ? {} : { modelCatalog: runtime.modelCatalog }),
        ...(runtime.codexCatalog === undefined ? {} : { codexCatalog: runtime.codexCatalog }),
        ...(runtime.compactAt === undefined ? {} : { compactAt: runtime.compactAt }),
        available: reason === undefined,
        unavailableReason: reason ?? null,
        secretEnv: runtime.secretEnv,
        ...(runtime.launchEnv === undefined ? {} : { launchEnv: runtime.launchEnv }),
        ...(runtime.autoRefusal === undefined ? {} : { autoRefusal: runtime.autoRefusal }),
      };
    }),
    runtimes: planned.map(runtime => ({
      id: runtime.id,
      name: runtime.name,
      harness: runtime.harness,
      credential: runtime.credential,
      profile: runtime.profile,
      wrapper: runtime.wrapper,
      models: runtime.models,
      defaultModel: runtime.defaultModel,
      ...(runtime.compactAt === undefined ? {} : { compactAt: runtime.compactAt }),
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
    sharedHistoryRequests: sharedHistoryPoolRequests(fleet, homesOf),
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
  /** The machine's MCP servers the profile in effect does not have, as they would be written. */
  readonly priorServers: Readonly<Record<string, SettingsObject>>;
  readonly overlay: SettingsObject | undefined;
  /** The text of the rules file a Codex agent runtime's home holds (`rules/ferretry.rules`: the commands it forbids). */
  readonly codexRules: string | undefined;
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
    // Ferretry's corner is a folder the person can write in too (a note, a log): only the names the last apply recorded
    // may go, down to what this apply writes.
    {
      kind: 'prune-directory',
      path: state,
      keep: [
        MATERIALISED_RECORD_FILE,
        ...(input.overlay === undefined ? [] : [FIXED_SETTINGS_FILE]),
        ...(input.codexCatalog === undefined ? [] : [CODEX_MODEL_CATALOG_FILE]),
      ],
      record,
      recordedAs: RUNTIME_STATE_DIRECTORY,
    },
    // The config directory is not Ferretry's either: only a name the last apply recorded, still as it was written.
    {
      kind: 'prune-directory',
      path: home,
      keep: [],
      only: input.absent,
      record,
      // A link an earlier Ferretry made, before the record held links, is still provably its own.
      ownLinksUnder: layout.assetsDirectory,
    },
  ];

  for (const entry of ownEntries) operations.push(entryOperation(entry, home, layout, record));

  operations.push({ kind: 'directory', path: skillsContainer, mode: DIRECTORY_MODE });
  for (const entry of skillEntries) operations.push(entryOperation(entry, home, layout, record));
  operations.push({
    kind: 'prune-directory',
    path: skillsContainer,
    keep: [
      ...skillEntries.map(entry => entry.dest.slice(skillsDest.length + 1)),
      ...HARNESS_OWNED_SKILL_ENTRIES[harness],
    ],
    // Skills the person or the harness added by hand live here too: only what the last apply recorded may go.
    record,
    recordedAs: skillsDest,
    // A link to a skill that an earlier Ferretry made, before the record held links, is still provably Ferretry's.
    ownLinksUnder: expandAssetPath(SKILLS_STORE_DIRECTORY, layout.userHome, layout.assetsDirectory),
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
      // Claude keeps its own state in this file, and so does the person (their own MCP servers): all of it survives.
      // The MCP servers the profile wrote are folded in by name, so one the profile drops leaves too — and only that one.
      preserveExisting: true,
      replaceKeys: Object.keys(input.claudeJson),
      record,
      priorMembers: { mcpServers: input.priorServers },
    });
  }
  if (input.overlay !== undefined) {
    operations.push({
      kind: 'file',
      path: joinPath(state, FIXED_SETTINGS_FILE),
      content: serializeSettings(input.overlay, 'json'),
      mode: PRIVATE_FILE_MODE,
      unlessUnrecorded: { record, key: `${RUNTIME_STATE_DIRECTORY}/${FIXED_SETTINGS_FILE}`, byName: true },
    });
  }
  if (input.codexRules !== undefined) {
    operations.push(
      { kind: 'directory', path: joinPath(home, CODEX_RULES_DIRECTORY), mode: DIRECTORY_MODE },
      {
        kind: 'file',
        path: joinPath(home, CODEX_KILL_RULES_FILE),
        content: input.codexRules,
        mode: PRIVATE_FILE_MODE,
        unlessUnrecorded: { record, key: CODEX_KILL_RULES_FILE, byName: true },
      },
    );
  }
  if (input.codexCatalog !== undefined) {
    operations.push({
      kind: 'file',
      path: joinPath(state, CODEX_MODEL_CATALOG_FILE),
      content: input.codexCatalog,
      mode: PRIVATE_FILE_MODE,
      unlessUnrecorded: { record, key: `${RUNTIME_STATE_DIRECTORY}/${CODEX_MODEL_CATALOG_FILE}`, byName: true },
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
      unlessUnrecorded: { record, key: CODEX_CREDENTIAL_FILE, namedLinkIsOurs: true },
    });
  }

  // The names this apply puts in the home. What each one IS — a file's hash, a link's stamp, a folder — is read off the disk by
  // the provisioner when it writes this record, so the record can only ever vouch for what is really there.
  const recorded: MaterialisedRecord = {
    version: 1,
    entries: [
      ...new Set([
        ...[...ownEntries, ...skillEntries].map(entry => entry.dest),
        ...(input.overlay === undefined ? [] : [`${RUNTIME_STATE_DIRECTORY}/${FIXED_SETTINGS_FILE}`]),
        ...(input.codexCatalog === undefined ? [] : [`${RUNTIME_STATE_DIRECTORY}/${CODEX_MODEL_CATALOG_FILE}`]),
        ...(input.codexRules === undefined ? [] : [CODEX_KILL_RULES_FILE]),
        ...(input.credentialLink === undefined ? [] : [CODEX_CREDENTIAL_FILE]),
      ]),
    ].toSorted(),
  };
  // After the sweep, so the sweep read the PREVIOUS apply's record.
  operations.push({
    kind: 'file',
    path: record,
    content: `${JSON.stringify(recorded)}\n`,
    mode: PRIVATE_FILE_MODE,
    recordsMaterialised: true,
  });
  return operations;
}

/** One adapted entry as the write that puts it in the config directory. */
function entryOperation(entry: AdaptedEntry, home: string, layout: FleetLayout, record: string): FleetWriteOperation {
  const path = joinPath(home, entry.dest);
  // Nothing the plan did not put there is replaced: a file edited since it was written, or one somebody else made.
  const unlessUnrecorded = { record, key: entry.dest, ownLinksUnder: layout.assetsDirectory };
  if (entry.kind === 'generated') {
    return {
      kind: 'file',
      path,
      content: entry.content,
      mode: PRIVATE_FILE_MODE,
      unlessUnrecorded,
    };
  }
  const source = expandAssetPath(entry.source, layout.userHome, layout.assetsDirectory);
  return entry.kind === 'link'
    ? { kind: 'symlink', source, path, unlessUnrecorded }
    : { kind: 'copy', source, path, unlessUnrecorded };
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
  for (const [alias, perHarness] of Object.entries(advanced.aliases).toSorted(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    for (const runtime of planned) {
      const flags = perHarness[runtime.harness];
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
