import { posix } from 'node:path';
import { MAX_ROOT_WINDOW_BYTES } from '../contract/ports.ts';
import { beforeListen } from '../host/before-listen.ts';
import { absolute } from '../host/fence-guard.ts';
import { isKernelMadeRoot } from '../host/internal-roots.ts';
import {
  DEFAULT_COPY_ENTRIES,
  isOwnerRoot,
  isReadOnlyRoot,
  mayHoldRoot,
  RootError,
  scopedSubfolder,
} from '../host/roots.ts';
import {
  anchorWalk,
  harnessFileRefusal,
  permittedMode,
  renameNamesRefusal,
  takesAnchor,
  takesLinks,
  takesRenames,
  takesUnlinks,
  unlinkNameRefusal,
} from '../host/root-rules.ts';
import { ownStateTree, receivingRoot, refuseShared, SharedTrees } from '../host/shared-trees.ts';
import type { DaemonContext } from '../manifest/implement.ts';
import { projectFilesScope } from '../manifest/project-files.ts';
import { PROJECT_SOURCES, projectFileKey, projectFilesHandle } from './project-files.ts';
import { failureResponse } from '../host/responses.ts';
import type { ContractSurface, FetchPort, HostFactsPort, UpdateHostPort } from '../contract/ports.ts';
import { undeclaredHostFacts } from '../host/adapters/host-facts.ts';
import { gatedOverrides, gatedPaths, gatedWhich } from '../host/paths.ts';
import { handleReaders, locateCommand, whichCommand, whichForCommand } from '../host/which.ts';
import {
  NO_PROCESS_TABLE,
  PROCESS_FOLDER_ROOTS,
  type ProcessTable,
  processesPortFor,
  processFolderAllowed,
} from '../host/processes.ts';
import { undeclaredUpdateHost } from '../host/adapters/update-host.ts';
import { PRODUCT_BINARIES } from '../host/binaries.ts';
import { NO_HOST_FACTS } from '../host/no-host-facts.ts';
import type { DaemonTimings } from '../contract/ports.ts';
import { DEFAULT_DAEMON_TIMINGS } from '../host/session/timings.ts';
import {
  addedSecretReferenceSentences,
  exactNetworkHosts,
  ownSecretsPort,
  secretReferencesIn,
} from '../host/secrets.ts';
import { outboundSecretTransport } from '../host/adapters/outbound-secret.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { err, hours, instantFromEpochMs, ok } from '@ferretry/std';
import type { Actor, HoldDecision, RefusalCode, TargetRef } from '../contract/act.ts';
import type {
  Admission,
  ChildEnvironment,
  ChildEnvironmentOpener,
  GuardStamp,
  InputHolds,
  OutputGuard,
  Redaction,
  RedactionScope,
  WorkFolders,
} from '../contract/bound.ts';
import { ChildEnvironmentPort, type FencedPath, KERNEL_ONLY_PORTS, WITHHELD_SENTENCE } from '../contract/bound.ts';
import type {
  ConfigCollectionDef,
  ConfigFileDef,
  Contribution,
  DecideAnswer,
  DecideTakerAnswer,
  EventDef,
  HookDecision,
  PortToken,
} from '../contract/define.ts';
import { judgeLoosening } from '../contract/define.ts';
import { SOCKET_CLOSES } from '../contract/socket.ts';
import type { ApiRequest, ApiResponse } from '../contract/http.ts';
import { ApiError, errorResponse, finalised, headersFrom, queryFrom } from '../contract/http.ts';
import type {
  ChildHandle,
  ConfigDocumentRef,
  ConfigFileStatus,
  ConfigPort,
  ConfigStateChange,
  KernelPorts,
  Log,
  LogFields,
  RootDurableHeld,
  RootFileHandle,
  RootHandle,
  RootName,
  SpawnOptions,
  SpawnResult,
  IdentityPort,
  WebSocketClient,
  CarrierListenerPort,
} from '../contract/ports.ts';
import { readConfigText } from '@ferretry/std/yaml';
import { isWithinList, patchedValue } from '../host/config/patch.ts';
import {
  ABSENT_STAMP,
  type ConfigFileStamp,
  configChangedPayload,
  configFileMoves,
  type StampedConfigFile,
} from '../host/config/state-change.ts';
import {
  ALREADY_HELD_ISSUE,
  type DocumentVerdict,
  DUPLICATE_ISSUE,
  firstStop,
  heldSet,
  judgeSet,
  refusedDocument,
  repeatedDocument,
} from '../host/config/write-all.ts';
import { KERNEL_REFUSALS, skeletonSentence } from '../contract/refusals.ts';
import { createIdentitySigner, signerFor } from '../host/session/signer.ts';
import {
  effectivePermissions,
  hostPermitted,
  type ItemReachOf,
  NO_ITEMS,
  PermissionError,
  type ResolverOf,
  spawnPermitted,
} from '../host/permissions.ts';
import { configOwnedKinds, itemReach } from '../host/items.ts';
import { scratchPort } from '../host/scratch.ts';
import { type DetachedCall, detachedAsked, detachedHandle, detachedRefusal } from '../host/detached.ts';
import { PinRegistry } from '../host/pins.ts';
import { type SessionRootPinner, unsupportedPlatform } from '../contract/pinned.ts';
import { matchingHook } from '../host/hooks.ts';
import { CORE_IDS, type FerretId } from '../contract/ids.ts';
import { KERNEL_NEEDER, neederOf, ProvidedPerNeeder } from '../host/needer.ts';
import type { ScratchPort } from '../contract/ports.ts';
import { testIdentity } from './identity.ts';
import type { IdentitySigner } from '../contract/session.ts';
import type {
  CallContext,
  CallStanding,
  MemberRouteHandler,
  RouteDescriptor,
  RouteHandler,
} from '../contract/route.ts';
import type { DoctorFinding } from '../contract/kernel.ts';
import type { PostBuildSnapshot } from '../contract/snapshot.ts';
import type { SocketAccept, SocketDownstream, SocketHandler } from '../contract/socket.ts';
import type { DoctorRun, DaemonImplementation, HookInvoker, ToolHandler, ToolResult } from '../manifest/implement.ts';
import { privacyRefusals } from '../manifest/privacy.ts';
import { reachFaults } from '../manifest/reach.ts';
import type { HookTake, Manifest, Needer, ToolDecl } from '../manifest/types.ts';
import { type ActRecord, TestMintedIds, testActRunner } from './act.ts';
import { type TestCaller, owner, standInAdmission, testArrival, testPrincipal } from './admission.ts';
import { type DrivenClock, fixedClock } from './clock.ts';
import { RouteTable } from './router.ts';
import { MemoryStateFolder, SimulatedCrash } from './state.ts';

// ─── options and results ──────────────────────────────────────────────────────────────────────────────────────────

/** The real host's detached rule (`host/detached.ts`), with its sentence, before anything is started. */
function refuseDetached(
  manifest: Manifest,
  items: ItemReachOf,
  call: DetachedCall,
  program: string,
  spawnOptions: SpawnOptions,
  resolve: ResolverOf,
): void {
  const spawnDeclared = spawnPermitted(
    effectivePermissions(manifest.id, manifest.permissions?.spawn ?? []),
    items,
    program,
    resolve,
  );
  const why = detachedRefusal(manifest.id, manifest.permissions?.detached, spawnDeclared, call, program, spawnOptions);
  if (why !== undefined) throw new PermissionError(why);
}

export interface TestHostOptions {
  /** The halves under test, built in this order. No other plugin's code is loaded. */
  readonly plugins: readonly DaemonImplementation<any>[];
  /** A fake for every required port, by port name (`AsksPort.name`) or by the manifest's `needs` key. */
  readonly fakes?: Readonly<Record<string, unknown>>;
  /** Optional ports; omit one to test "that plugin is off". Same keys as `fakes`. */
  readonly uses?: Readonly<Record<string, unknown>>;
  /** The real admission decision (Gate's), when available; else the stand-in. */
  readonly gate?: Admission;
  readonly holds?: InputHolds;
  readonly outputGuard?: OutputGuard;
  readonly redaction?: Redaction;
  readonly workFolders?: WorkFolders;
  readonly clock?: DrivenClock;
  /** Config values by `file` or `collection` (a collection is `{ name: value }`). Parsed with the declared schema. */
  readonly config?: Readonly<Record<string, unknown>>;
  /**
   * Hears a DETACHED `kernel.spawn.start` the real host's rule allowed (`host/detached.ts`), and answers its pid.
   * Without it an allowed detached start throws, as any `start` here does. A refused one never reaches it.
   */
  readonly detachedStart?: (program: string, args: readonly string[], options: SpawnOptions) => number;
  /** Answers `kernel.spawn.run` for declared programs. Without it a spawn fails. */
  readonly spawn?: (
    program: string,
    args: readonly string[],
    options?: SpawnOptions,
  ) => SpawnResult | Promise<SpawnResult>;
  /** Answers `kernel.fetch.request` for declared hosts. Without it a fetch fails. */
  readonly fetch?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  /** Answers `kernel.websocket.connect` for declared hosts (`ws:`/`wss:`). Without it a dial fails. */
  readonly websocket?: (url: URL) => WebSocketClient;
  /** Answers `kernel.carrierListener.open` (the test host binds no listener of its own). Without it an open fails. */
  readonly carrierListener?: CarrierListenerPort;
  /** Answers `RootHandle.pin` (with the path the test root resolved). Without it a pin is refused. */
  readonly pinner?: SessionRootPinner;
  /** What `kernel.paths.home()` answers. Default: `/home/owner`. */
  readonly ownerHome?: string;
  /**
   * The files `kernel.roots.harnessFile` reads, by absolute path (`/home/owner/.claude.json` → its text). The rule
   * over the path is the real host's (`host/root-rules.ts`); a path not here reads as absent. Default: none.
   */
  readonly harnessFiles?: Readonly<Record<string, string>>;
  /** The kernel home the test roots' fence is judged against (`harnessFile` refuses a path in it). Default: `/test-home`. */
  readonly fenceHome?: string;
  /**
   * A host that cannot reach an entry through a held folder (macOS whose C library or working-directory bracket could
   * not be loaded): the `project-files` root, an owner's root, refuses every remove AND every write `no_descriptor_reach`, as the real
   * host does there. Default: it has reach, as macOS does when both load (a remove goes through the folder's descriptor).
   */
  readonly noDescriptorReach?: true;
  /**
   * Absolute folders of the `project-files` world that are LINKS: the folder → the real path it resolves to (the flat
   * world has no links at a folder level). The spelling rule of the real host (`realpath(folder)` equal to
   * `realpath(within)` joined with the folder below `within`; without `within`, the folder equal to its real path) is
   * then judged over it, so a `project-files` call under a linked folder is refused `link_escape` unless the link is at
   * or above its `within` anchor. Default: none.
   */
  readonly linkedProjectFolders?: ReadonlyMap<string, string>;
  /** The directories `kernel.paths.checkDirectory` accepts: the absolute path asked → its real path. Default: none. */
  readonly directories?: Readonly<Record<string, string>>;
  /** The absolute paths `kernel.paths.which` finds executable. Default: none. */
  readonly executables?: readonly string[];
  /** The `PATH` `kernel.paths.which` searches after the caller's own folders. Default: none. */
  readonly searchPath?: string;
  /**
   * The operator's environment `kernel.paths.locate` reads an override from (`FY_CLOUDFLARED` → its value); only a
   * variable the manifest declared in `permissions.whichOverrides` is ever asked. Default: none set.
   */
  readonly operatorVariables?: Readonly<Record<string, string>>;
  /**
   * The Vault's handle opener, for `kernel.paths.whichFor` (`searchPathOf`). Default: a loaded Vault's provided
   * `childEnvironments`, else none, so every handle is `unprovable`.
   */
  readonly childEnvironments?: ChildEnvironmentOpener;
  /** `kernel.scratch`. Default: real private temp folders, as the daemon's. */
  readonly scratch?: ScratchPort;
  /** What the owner's installed items name, for `permissions.spawn`/`network` `{ items }` entries. Default: none. */
  readonly items?: ItemReachOf;
  /** What `kernel.identity` answers. Default: the throwaway identity's id and `test-daemon`. */
  readonly identity?: IdentityPort;
  /** Text the stand-in redaction masks (same-width `*`). */
  readonly secrets?: readonly string[];
  /** What `kernel.hostFacts` answers to a plugin that declared `permissions.hostFacts`. Absent: every read refuses. */
  readonly hostFacts?: HostFactsPort;
  /**
   * The process table `kernel.processes` asks for a plugin that declared `permissions.processes` (`testProcessTable`).
   * Absent: nothing is listed or signalled. The rule over it is the real host's (`host/processes.ts`).
   */
  readonly processes?: ProcessTable;
  /** What `kernel.updateHost` answers to a plugin that declared `permissions.updateHost`. */
  readonly updateHost?: UpdateHostPort;
  /** What `kernel.timings` answers. Default: the shipped numbers (`DEFAULT_DAEMON_TIMINGS`). */
  readonly timings?: DaemonTimings;
  /** The Vault stand-in for `kernel.secrets` (`resolve` and `send`): name to value. Absent, every declared and configured name is `unknown`. */
  readonly vault?: Readonly<Record<string, string>>;
  /** The contract hash per package, as `kernel.contract.hash()` answers its own plugin (`surface` is `'member'` for the member-surface hash). Default: `unhashed`. */
  readonly contractHash?: (id: string, surface?: ContractSurface) => string;
}

export interface TestResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
  json<T = unknown>(): T;
}

export interface RequestInit2 {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly as?: TestCaller;
}

export interface OpenSocket {
  readonly response?: TestResponse;
  readonly frames: (string | Uint8Array)[];
  readonly closed: { code: number; reason: string } | undefined;
  readonly handler?: SocketHandler;
}

export interface TestHost {
  readonly clock: DrivenClock;
  /** What `kernel.identity` answers; `kernel.signer` signs with this identity's throwaway key (gated as the real host). */
  readonly identity: IdentityPort;
  readonly minted: TestMintedIds;
  /** Every `kernel.act` decision, in order. */
  readonly acts: readonly ActRecord[];
  /** Every event a half published, in order. */
  readonly published: readonly { readonly event: string; readonly payload: unknown }[];
  /**
   * Every `kernel.config-changed` the real host would publish on `GET /v1/bus`, in order: each declared file that moved
   * in state or etag (the shared rule, `host/config/state-change.ts`). The same moves `ConfigPort.watchState` hears.
   */
  readonly configChanges: readonly {
    readonly plugin: string;
    readonly path: string;
    readonly state: ConfigFileStatus['state'];
    readonly etag: string;
  }[];
  readonly logs: readonly {
    readonly level: string;
    readonly scope: string;
    readonly message: string;
    readonly fields?: LogFields;
  }[];
  request(method: string, path: string, init?: RequestInit2): Promise<TestResponse>;
  tool(name: string, input: unknown, init?: { readonly as?: TestCaller }): Promise<ToolResult>;
  socket(
    path: string,
    init?: {
      readonly as?: TestCaller;
      readonly method?: string;
      /** The query the upgrade request carries, as `request` takes it. */
      readonly query?: RequestInit2['query'];
    },
  ): Promise<OpenSocket>;
  /** Delivers an event to every loaded subscriber (a wake-up from a fake). */
  emit<Payload>(event: EventDef<string, Payload>, payload: Payload): void;
  /** Waits until every delivery and hook call started so far has finished. */
  settle(): Promise<void>;
  /** The next state write lands, then the "process" dies: every later port call throws until `restart()`. */
  crashAfterNextWrite(): void;
  /** Builds the same halves again on the same state and clock (a daemon restart after a crash). */
  restart(): Promise<TestHost>;
  /**
   * What a loaded plugin provides for `token`, as the kernel would hand it to `as` (a loaded plugin's id, or a needer):
   * a per-needer entry is built for that needer, once. Omitted, the caller is the kernel, a core caller.
   */
  provided<Api>(token: PortToken<Api>, as?: string | Needer): Api;
  state(pluginId: string): MemoryStateFolder;
  setConfig(fileOrCollection: string, value: unknown): void;
  runJob(id: string): Promise<void>;
  /** Runs a half's declared `doctor` check (manifest `doctor` id) as `fy doctor` would. */
  /** A declared check's finding; `undefined` when it reports no row. */
  doctor(plugin: string, check: string): Promise<DoctorFinding | undefined>;
  jobIds(): readonly string[];
  /** Makes `InputHolds.decide` refuse this target (when the stand-in holds are in use). */
  hold(target: TargetRef, code?: RefusalCode): void;
  release(target: TargetRef): void;
  /** Moves the stand-in output guard's generation: a guarded body built before now is withheld. */
  holdBegins(): void;
  putRoot(name: RootName, relative: string, text: string): void;
  /** The text of the file at `relative` of the test root `name`, or `undefined` when there is none. */
  rootText(name: RootName, relative: string): string | undefined;
  /**
   * A link planted at `relative` of the test root `name` (for `project-files`, `relative` is the ABSOLUTE path of the name:
   * its scope folder and then the name). The kernel never follows it: a root read or write through it is refused.
   */
  putRootLink(name: RootName, relative: string): void;
  /** A file with a second name planted at `relative` of the test root `name` (see {@link TestHost.putRootLink}). */
  putRootHardLink(name: RootName, relative: string, text: string): void;
  stop(): Promise<void>;
}

// ─── shared, restart-surviving world ──────────────────────────────────────────────────────────────────────────────

interface World {
  readonly options: TestHostOptions;
  readonly identity: IdentityPort;
  readonly identitySigner: IdentitySigner;
  readonly clock: DrivenClock;
  readonly states: Map<string, MemoryStateFolder>;
  readonly minted: TestMintedIds;
  readonly holdsMap: Map<string, RefusalCode>;
  generation: number;
  readonly roots: Map<string, string>;
  readonly config: Map<string, unknown>;
}

const actorScope = new AsyncLocalStorage<{ readonly actor: Actor; readonly standing?: CallStanding }>();

function actorOf(caller: TestCaller): Actor {
  if (caller.kind === 'ferret') return 'ferret';
  if (caller.kind === 'warden') return 'warden';
  return 'owner-tools';
}

function targetKey(target: TargetRef): string {
  return `${target.kind}\u0000${target.key}`;
}

function maskScope(secrets: readonly string[]): RedactionScope {
  const text = (s: string): string =>
    secrets.reduce((out, secret) => (secret === '' ? out : out.split(secret).join('*'.repeat(secret.length))), s);
  return {
    text,
    lines: lines => lines.map(text),
    cells: grid => ({ columns: grid.columns, rows: grid.rows.map(row => text(row.join('')).split('')) }),
  };
}

function toTestResponse(response: ApiResponse): TestResponse {
  const final = finalised(response);
  return {
    status: final.status,
    headers: final.headers,
    body: final.body,
    json: <T>() => JSON.parse(final.body) as T,
  };
}

interface Built {
  readonly impl: DaemonImplementation<any>;
  readonly manifest: Manifest;
  readonly half: Record<string, any> | undefined;
}

// ─── the host ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Builds the given plugins with fakes for what they need, a driven clock, an in-memory state folder, the act runner,
 * and the admission decision behind the Admission port (§3.9, §7.8). Real route table (today's router), real final
 * check (`finalised`), real `closeAck`.
 */
/** A name's key in the flat test world: `/<root>/<relative>`; a `project-files` name is keyed by its absolute path. */
const rootKey = (name: RootName, relative: string): string =>
  name === 'project-files' ? projectFileKey(relative) : `/${name}/${relative}`;

export async function testHost(options: TestHostOptions): Promise<TestHost> {
  const throwaway = await testIdentity();
  const identity: IdentityPort =
    options.identity ??
    Object.freeze({ daemonId: throwaway.daemonId, daemonName: 'test-daemon', binaries: PRODUCT_BINARIES });
  const identitySigner = createIdentitySigner(throwaway.key);
  const world: World = {
    options,
    identity,
    identitySigner,
    clock: options.clock ?? fixedClock(),
    states: new Map(),
    minted: new TestMintedIds(),
    holdsMap: new Map(),
    generation: 0,
    roots: new Map(),
    config: new Map(Object.entries(options.config ?? {})),
  };
  return start(world);
}

async function start(world: World): Promise<TestHost> {
  const { options, clock, identity, identitySigner } = world;
  const manifests: readonly Manifest[] = options.plugins.map(plugin => plugin.manifest);
  // As the real host: a plugin's private files must be declared soundly, so a unit test cannot hold a manifest that
  // production refuses at boot.
  const unsound = privacyRefusals(manifests);
  if (unsound.length > 0) throw new TypeError(unsound.join('\n'));
  // The real host refuses a plugin whose reach declarations it does not honour; a suite learns it the same way.
  const fault = reachFaults(manifests)[0];
  if (fault !== undefined) throw new Error(`testHost: ${fault.plugin} ${fault.sentence}`);
  const hookOffers = new Map(
    manifests.flatMap(manifest => (manifest.hooks?.offers ?? []).map(offer => [offer.hook.name, offer.hook] as const)),
  );
  const validTake = (id: string, take: HookTake): boolean => {
    const hook = hookOffers.get(take.hook.name);
    if (hook === undefined) return true;
    if (!matchingHook(hook, take.hook)) return false;
    if (hook.mode === 'provide')
      return (hook.takers === undefined || hook.takers.includes(id)) && hook.key.safeParse(take.key).success;
    return hook.mode !== 'decide' || !hook.securityPath || (CORE_IDS as readonly string[]).includes(id);
  };
  for (const plugin of options.plugins)
    for (const take of plugin.manifest.hooks?.takes ?? [])
      if (!validTake(plugin.manifest.id, take))
        throw new Error(`testHost: ${plugin.manifest.id} takes a refused hook definition`);
  const acts: ActRecord[] = [];
  const published: { event: string; payload: unknown }[] = [];
  const logs: { level: string; scope: string; message: string; fields?: LogFields }[] = [];
  const pending = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>): void => {
    const tracked = promise.catch(error => {
      logs.push({
        level: 'error',
        scope: 'test-host',
        message: error instanceof Error ? error.message : String(error),
      });
    });
    pending.add(tracked);
    void tracked.finally(() => pending.delete(tracked));
  };
  const stopHandlers: (() => void | Promise<void>)[] = [];
  const stopController = new AbortController();
  const jobs = new Map<string, (signal: AbortSignal) => Promise<void>>();
  const configListeners = new Map<string, Set<() => void>>();
  /** The value of the edit held at each config path (`write` keeps it so the next edit is made to it, as on a disk). */
  const heldValues = new Map<string, { readonly etag: string; readonly value: unknown }>();
  // `watchState` over the in-memory world: by file or collection key, the moves the shared rule finds there. The world
  // holds values, not texts, so a file's etag is its value's JSON (as this host's writes answer) and a held edit (which
  // the world never holds) is a stamp kept for its path until that path is written, removed or set again.
  const stateListeners = new Map<string, Set<(change: ConfigStateChange) => void>>();
  const configChanges: { plugin: string; path: string; state: ConfigFileStatus['state']; etag: string }[] = [];
  const configOwners = new Map<
    string,
    { readonly plugin: string; readonly def: ConfigFileDef<any> | ConfigCollectionDef<any> }
  >();
  for (const plugin of options.plugins)
    for (const def of plugin.manifest.data?.config ?? [])
      configOwners.set(def.shape === 'file' ? def.file : def.collection, { plugin: plugin.manifest.id, def });
  /** A file's etag in this world: its value's JSON (what its writes answer), or the absent sentinel when it is not there. */
  const etagOfValue = (value: unknown): string => (value === undefined ? ABSENT_STAMP.etag : JSON.stringify(value));
  const configStamps = new Map<string, Map<string, StampedConfigFile>>();
  /** Where every file of one key stands in the world now: valid or invalid by its schema, absent when not there. */
  const worldStamps = (key: string): Map<string, StampedConfigFile> => {
    const found = new Map<string, StampedConfigFile>();
    const owner = configOwners.get(key);
    if (owner === undefined) return found;
    const { def } = owner;
    const stampOf = (value: unknown): ConfigFileStamp =>
      value === undefined
        ? ABSENT_STAMP
        : { state: def.schema.safeParse(value).success ? 'valid' : 'invalid', etag: JSON.stringify(value) };
    const raw = world.config.get(key);
    if (def.shape === 'file') {
      if (raw !== undefined) found.set(def.file, { stamp: stampOf(raw) });
      return found;
    }
    for (const [name, value] of Object.entries((raw ?? {}) as Record<string, unknown>))
      if (def.name.test(name)) found.set(`${def.collection}/${name}.yaml`, { name, stamp: stampOf(value) });
    return found;
  };
  for (const key of configOwners.keys()) configStamps.set(key, worldStamps(key));
  /**
   * The world moved under `key` (a write, a removal, a set, or an edit held at `held.path`): tell every file of it that
   * moved. `subject` names the one path this act touched; another path's held stamp is kept. No subject: all of them.
   */
  const restamp = (
    key: string,
    subject?: { readonly path: string; readonly name?: string; readonly held?: string },
  ): void => {
    const owner = configOwners.get(key);
    if (owner === undefined) return;
    const before = configStamps.get(key) ?? new Map<string, StampedConfigFile>();
    const after = worldStamps(key);
    if (subject !== undefined)
      for (const [path, stamped] of before)
        if (path !== subject.path && stamped.stamp.state === 'held') after.set(path, stamped);
    if (subject?.held !== undefined)
      after.set(subject.path, {
        ...(subject.name === undefined ? {} : { name: subject.name }),
        stamp: { state: 'held', etag: subject.held },
      });
    configStamps.set(key, after);
    for (const move of configFileMoves(before, after)) {
      configChanges.push(configChangedPayload(owner.plugin, move));
      for (const listener of [...(stateListeners.get(key) ?? [])]) {
        try {
          listener(move.change);
        } catch (error) {
          logs.push({
            level: 'warn',
            scope: 'test-host',
            message: `a config listener failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
  };
  const callers = new WeakMap<ApiRequest, TestCaller>();
  for (const state of world.states.values()) state.revive();

  const holds: InputHolds = options.holds ?? {
    decide(target): HoldDecision {
      const code = world.holdsMap.get(targetKey(target));
      return code === undefined ? 'allow' : { refused: code };
    },
  };
  const outputGuard: OutputGuard = options.outputGuard ?? {
    stamp: targets => ({ generation: world.generation, targets: targets ?? [] }),
    stillShowable: (stamp: GuardStamp) => stamp.generation === world.generation,
  };
  const redaction: Redaction = options.redaction ?? {
    read: async fn => fn(maskScope(options.secrets ?? [])),
  };
  const admission = options.gate ?? standInAdmission(request => callers.get(request) ?? owner());
  // Open streams, re-asked at once when the admission says its policy moved (as the real host does).
  const openStreams = new Set<() => void>();
  const stopWatching = admission.watch?.(() => {
    for (const recheck of [...openStreams]) recheck();
  });
  if (stopWatching !== undefined) stopHandlers.push(stopWatching);

  const built: Built[] = [];
  const bootContexts = new Map<string, DaemonContext<Manifest>>();
  const providedBy = new Map<string, unknown>();
  // As the kernel does: a per-needer provides entry (or fake) is built once for each plugin it is bound for.
  const perNeeder = new ProvidedPerNeeder();
  // The `${secret:NAME}` references the plugin's own config names IN EFFECT (a held write is not in the world yet).
  const ownedReferences = (manifest: Manifest, only?: 'credential-records'): ReadonlySet<string> => {
    const named = new Set<string>();
    for (const def of manifest.data?.config ?? [])
      if (only === undefined || def.credentialRecords === true)
        secretReferencesIn(world.config.get(def.shape === 'file' ? def.file : def.collection), named);
    return named;
  };
  // The cache slot is (where the value came from, token, needer): a `fakes` entry, a `uses` entry and the loaded
  // provider's own value for one token are three different values and never share a slot.
  const boundFor = (
    token: PortToken<unknown>,
    value: unknown,
    needer: Needer,
    source: 'fake' | 'uses' | 'provided' = 'provided',
  ): unknown => (value === undefined ? undefined : perNeeder.valueFor(source, token.name, value, needer));
  const usesBound = { done: false };

  const subscribersOf = (name: string): ((payload: unknown) => void | Promise<void>)[] =>
    built.flatMap(b => {
      const fn = b.half?.subscribers?.[name];
      return typeof fn === 'function' ? [fn as (payload: unknown) => void | Promise<void>] : [];
    });
  const deliver = (name: string, payload: unknown): void => {
    for (const fn of subscribersOf(name)) track(Promise.resolve().then(() => fn(payload)));
  };

  const hookTakers = (
    hookName: string,
  ): { id: string; key?: string; impl: unknown; priority: number; index: number }[] =>
    built
      .flatMap((b, index) =>
        (b.manifest.hooks?.takes ?? [])
          .filter(take => take.hook.name === hookName && validTake(b.manifest.id, take))
          .map(take => {
            const hook = hookOffers.get(hookName) ?? take.hook;
            const implKey = hook.mode === 'provide' && take.key !== undefined ? `${hook.name}:${take.key}` : hook.name;
            return {
              id: b.manifest.id,
              ...(take.key === undefined ? {} : { key: take.key }),
              impl: b.impl.skeleton === true ? undefined : b.half?.hooks?.[implKey],
              priority: take.priority ?? b.manifest.priority ?? 50,
              index,
            };
          }),
      )
      .sort((a, b) => b.priority - a.priority || a.index - b.index || a.id.localeCompare(b.id));

  const hooksFor = (manifest: Manifest): HookInvoker => {
    const offered = new Set((manifest.hooks?.offers ?? []).map(offer => offer.hook.name));
    const own = (name: string): void => {
      if (!offered.has(name)) throw new Error(`${manifest.id} invokes hook "${name}" it does not offer`);
    };
    const timed = async <T>(value: T | Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        Promise.resolve(value),
        new Promise<T>((_, reject) => {
          setTimeout(() => reject(new Error('hook timed out')), ms);
        }),
      ]);
    /** The real host's decide walk (`host/hooks.ts` `decideAnswered`): the first no wins; each taker reached is listed. */
    const decideAnswered = async (
      hook: { readonly name: string; readonly timeoutMs: number },
      input: unknown,
    ): Promise<DecideAnswer> => {
      own(hook.name);
      const answers: DecideTakerAnswer[] = [];
      for (const taker of hookTakers(hook.name)) {
        if (typeof taker.impl !== 'function') continue; // a skeleton take is a no-op
        try {
          const answer = (await timed((taker.impl as (i: unknown) => unknown)(input), hook.timeoutMs)) as {
            readonly allow?: unknown;
            readonly reason?: unknown;
            readonly code?: unknown;
          } | null;
          // The real host's rule (`host/hooks.ts` decide), exactly: anything but an object with `allow: true` is a
          // refusal; a string `reason` is kept, else the plugin "refused"; a string `code` passes through, any other
          // type is dropped. Only an `allow: false` is the taker's own no; anything else is unanswered.
          if (answer === null || typeof answer !== 'object' || answer.allow !== true) {
            const refusal = answer !== null && typeof answer === 'object' && answer.allow === false;
            const reason = refusal && typeof answer.reason === 'string' ? answer.reason : `${taker.id} refused.`;
            answers.push({ plugin: taker.id, outcome: refusal ? 'refused' : 'unanswered' });
            return {
              decision:
                refusal && typeof answer.code === 'string'
                  ? { allow: false, reason, code: answer.code }
                  : { allow: false, reason },
              answers,
            };
          }
          answers.push({ plugin: taker.id, outcome: 'allowed' });
        } catch (error) {
          answers.push({ plugin: taker.id, outcome: 'unanswered' });
          return {
            decision: {
              allow: false,
              reason: `${taker.id}: ${error instanceof Error ? error.message : String(error)}`,
            },
            answers,
          };
        }
      }
      return { decision: { allow: true }, answers };
    };
    return {
      observe(hook, payload) {
        own(hook.name);
        for (const taker of hookTakers(hook.name))
          if (typeof taker.impl === 'function')
            track(Promise.resolve().then(() => (taker.impl as (p: unknown) => unknown)(payload)));
      },
      async decide(hook, input): Promise<HookDecision> {
        return (await decideAnswered(hook, input)).decision;
      },
      decideAnswered,
      async transform(hook, value) {
        own(hook.name);
        let current = value;
        for (const taker of hookTakers(hook.name)) {
          if (typeof taker.impl !== 'function') continue;
          try {
            current = await timed(
              (taker.impl as (v: typeof value) => typeof value | Promise<typeof value>)(current),
              hook.timeoutMs,
            );
          } catch (error) {
            return { ok: false, error: `${taker.id}: ${error instanceof Error ? error.message : String(error)}` };
          }
        }
        return { ok: true, value: current };
      },
      provider(hook, key) {
        own(hook.name);
        const taker = hookTakers(hook.name).find(t => t.key === key);
        return taker === undefined || taker.impl === undefined ? 'unavailable' : (taker.impl as never);
      },
      declaredProvider(hook, key) {
        own(hook.name);
        const declared = (manifest.hooks?.offers ?? []).find(offer => offer.hook.name === hook.name)?.hook;
        if (declared?.mode !== 'provide' || !declared.key.safeParse(key).success) return undefined;
        const ids = new Set(
          options.plugins
            .filter(
              plugin =>
                (declared.takers === undefined || declared.takers.includes(plugin.manifest.id)) &&
                (plugin.manifest.hooks?.takes ?? []).some(
                  (take: HookTake) => take.hook.name === declared.name && take.key === key,
                ),
            )
            .map(plugin => plugin.manifest.id),
        );
        return ids.size === 1 ? [...ids][0] : undefined;
      },
      providers(hook) {
        own(hook.name);
        const out = new Map();
        for (const taker of hookTakers(hook.name))
          if (taker.key !== undefined && taker.impl !== undefined) out.set(taker.key, taker.impl);
        return out;
      },
      contributions<I>(hook: { readonly name: string }): readonly Contribution<I>[] {
        own(hook.name);
        const items: Contribution<I>[] = [];
        for (const taker of hookTakers(hook.name))
          if (typeof taker.impl === 'function')
            items.push(...((taker.impl as () => readonly Contribution<I>[])() ?? []));
        const ids = new Set<string>();
        for (const item of items) {
          if (ids.has(item.id)) throw new Error(`hook ${hook.name}: contribution id "${item.id}" twice`);
          ids.add(item.id);
        }
        return items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
      },
    };
  };

  const logFor = (scope: string): Log => {
    const at = (level: string) => (message: string, fields?: LogFields) => {
      logs.push({ level, scope, message, ...(fields === undefined ? {} : { fields }) });
    };
    return {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: sub => logFor(`${scope}.${sub}`),
    };
  };

  const judged = (
    plugin: string,
    path: string,
    removal: boolean,
    sentences: readonly string[],
    secretAdd?: true,
  ): boolean => {
    try {
      return (
        admission.judgeConfigWrite?.({
          plugin,
          path,
          removal,
          sentences,
          ...(secretAdd === true ? { secretAdd } : {}),
          actor: actorScope.getStore()?.actor ?? 'ferret',
          standing: actorScope.getStore()?.standing,
        }) === 'apply'
      );
    } catch {
      return false;
    }
  };
  const configPort = (manifest: Manifest): ConfigPort => {
    const declared = manifest.data?.config ?? [];
    const keyOf = (def: ConfigFileDef<any> | ConfigCollectionDef<any>): string =>
      def.shape === 'file' ? def.file : def.collection;
    /**
     * The etag of one file as the DISK has it, which is what `etag` answers and `ifMatch` is compared with (the real
     * service reads both from the disk, "not from the version in effect"): the world's value, except that an edit held
     * for the owner is on the disk while the tighter value stays in effect, so a held file answers the held edit's etag.
     * A held REMOVAL took the file off the disk (the value stays in effect), so it answers the absent etag.
     */
    const diskEtagOf = (
      def: ConfigFileDef<any> | ConfigCollectionDef<any>,
      name: string | undefined,
      inEffect: unknown,
    ): string => {
      const path = def.shape === 'file' ? def.file : `${def.collection}/${name as string}.yaml`;
      const stamp = configStamps.get(keyOf(def))?.get(path)?.stamp;
      return stamp?.state === 'held' ? stamp.etag : etagOfValue(inEffect);
    };
    /**
     * The value of the edit held at `path`, when one is held now (its stamp is held and names that very edit). A held
     * REMOVAL is held with no value (`value` stays `undefined`): there is no text to carry a patch.
     */
    const heldValueAt = (key: string, path: string): { readonly held: boolean; readonly value?: unknown } => {
      const stamp = configStamps.get(key)?.get(path)?.stamp;
      const saved = heldValues.get(path);
      return stamp?.state === 'held' && saved !== undefined && saved.etag === stamp.etag
        ? { held: true, value: saved.value }
        : { held: false };
    };
    const assertDeclared = (def: ConfigFileDef<any> | ConfigCollectionDef<any>): void => {
      if (!declared.includes(def)) throw new Error(`${manifest.id}: config ${keyOf(def)} is not declared`);
    };
    // The real writer's outcomes over the in-memory values: own defs only, schema checked, a loosening held unless
    // the admission in use (Gate's, when given) judges this call may apply it. `within` is the owner's only (the
    // real writer's one-level merge, `host/config/patch.ts`).
    const write: (
      ...args: [...Parameters<ConfigPort['write']>, within?: readonly string[], asCaller?: true, bothVersions?: true]
    ) => ReturnType<ConfigPort['write']> = async (
      def,
      name,
      edit,
      writeOptions = {},
      within = undefined,
      asCaller = undefined,
      bothVersions = undefined,
    ) => {
      if (!declared.includes(def)) return { kind: 'refused', reason: 'not_declared', issues: [] };
      const key = keyOf(def);
      if (def.shape === 'collection' && (name === undefined || !def.name.test(name)))
        return { kind: 'refused', reason: 'bad_name', issues: [] };
      const all = world.config.get(key) as Record<string, unknown> | undefined;
      const before = def.shape === 'file' ? all : name === undefined ? undefined : all?.[name];
      const path = def.shape === 'file' ? key : `${key}/${name as string}.yaml`;
      // As the real writer: an edit is made to the DISK text, which for a file with an edit held is the HELD one.
      const onDisk = heldValueAt(key, path);
      // Except a PATCH, from any of the three writes (`write`, `writeAsCaller`, `writeAsOwner`): made to BOTH versions.
      if (bothVersions === true && typeof edit !== 'string' && onDisk.held) {
        const effectiveNext = patchedValue((before as Record<string, unknown> | undefined) ?? {}, edit.patch, within);
        // A held REMOVAL has no value, so no text to carry the patch (as the real writer): only the version in effect is patched.
        const heldNext =
          onDisk.value === undefined
            ? undefined
            : patchedValue(onDisk.value as Record<string, unknown>, edit.patch, within);
        const effective = def.schema.safeParse(effectiveNext);
        const heldChecked = heldNext === undefined ? undefined : def.schema.safeParse(heldNext);
        for (const checked of [effective, heldChecked])
          if (checked !== undefined && !checked.success)
            return {
              kind: 'refused',
              reason: 'schema',
              issues: checked.error.issues.map(issue => ({ path: key, message: issue.message })),
            };
        if (!effective.success || (heldChecked !== undefined && !heldChecked.success))
          return { kind: 'refused', reason: 'schema', issues: [] };
        if (writeOptions.ifMatch !== undefined && writeOptions.ifMatch !== diskEtagOf(def, name, before))
          return { kind: 'conflict' };
        const prior = before === undefined ? undefined : def.schema.safeParse(before);
        const priorValue = prior?.success === true ? prior.data : undefined;
        const added = addedSecretReferenceSentences(priorValue, effective.data);
        const other = judgeLoosening(def, priorValue, effective.data);
        // As the real writer: the owner's yes covers only a reference the patch itself introduces, never one the held
        // version names.
        const byCaller =
          asCaller === true && added.length > 0
            ? addedSecretReferenceSentences([priorValue, onDisk.value], effective.data)
            : [];
        const ownerAdds =
          byCaller.length > 0 && byCaller.length === added.length && judged(manifest.id, path, false, byCaller, true);
        const sentences = [...other, ...added];
        const confirmed =
          (added.length === 0 || ownerAdds) && (other.length === 0 || judged(manifest.id, path, false, other));
        const subject = { path, ...(name === undefined ? {} : { name }) };
        // What waits when the patch is refused: the held version with the patch made to it, or (a held removal, which
        // has no text) the patch itself, superseding the removal as the real writer does.
        const waitingNext = heldNext ?? effectiveNext;
        const waitingData = heldChecked?.data ?? effective.data;
        const heldEtag = JSON.stringify(waitingNext);
        if (sentences.length > 0 && !confirmed) {
          // The patch itself waits: nothing in effect changes, and it rides with the held version, whose sentences are
          // what the whole held version widens beyond the version in effect (as the real load says them).
          heldValues.set(path, { etag: heldEtag, value: waitingNext });
          restamp(key, { ...subject, held: heldEtag });
          return {
            kind: 'held',
            etag: heldEtag,
            id: `${path}@held`,
            sentences: [
              ...judgeLoosening(def, priorValue, waitingData),
              ...addedSecretReferenceSentences(priorValue, waitingData),
            ],
          };
        }
        // The held version stays held while it still loosens what is now in effect; a held removal, while removing the
        // file would still loosen it (judged against the defaults, as `remove` judges it).
        const defaults = def.schema.safeParse({});
        const still =
          heldChecked === undefined
            ? judgeLoosening(def, effective.data, defaults.success ? defaults.data : undefined)
            : [
                ...judgeLoosening(def, effective.data, heldChecked.data),
                ...addedSecretReferenceSentences(effective.data, heldChecked.data),
              ];
        // A held REMOVAL the patch made harmless goes into effect, as the real load accepts the file's absence: the
        // file is gone and the defaults apply.
        if (heldChecked === undefined && still.length === 0) {
          const { [name as string]: _gone, ...rest } = all ?? {};
          if (def.shape === 'file') world.config.delete(key);
          else world.config.set(key, rest);
          for (const listener of configListeners.get(key) ?? []) listener();
          heldValues.delete(path);
          restamp(key, subject);
          return { kind: 'written', etag: ABSENT_STAMP.etag, loosened: confirmed ? sentences : [] };
        }
        world.config.set(
          key,
          def.shape === 'file' ? effectiveNext : { ...(all ?? {}), [name as string]: effectiveNext },
        );
        for (const listener of configListeners.get(key) ?? []) listener();
        if (still.length === 0) {
          heldValues.delete(path);
          restamp(key, subject);
          return { kind: 'written', etag: JSON.stringify(effectiveNext), loosened: confirmed ? sentences : [] };
        }
        const stillEtag = heldNext === undefined ? ABSENT_STAMP.etag : heldEtag;
        heldValues.set(path, { etag: stillEtag, value: heldNext });
        restamp(key, { ...subject, held: stillEtag });
        return {
          kind: 'written',
          etag: stillEtag,
          loosened: confirmed ? sentences : [],
          stillHeld: { id: `${path}@held`, sentences: still },
        };
      }
      let next: unknown;
      if (typeof edit === 'string') {
        // The shared bounded reader, as the real writer reads an edit: never a raw parse of a text a test hands in.
        const read = readConfigText(edit);
        if (!read.ok) return { kind: 'refused', reason: 'yaml', issues: [{ path: key, message: 'this is not YAML' }] };
        next = read.read.value ?? {};
      } else
        next = patchedValue(
          ((onDisk.held ? onDisk.value : before) as Record<string, unknown> | undefined) ?? {},
          edit.patch,
          within,
        );
      const checked = def.schema.safeParse(next);
      if (!checked.success)
        return {
          kind: 'refused',
          reason: 'schema',
          issues: checked.error.issues.map(issue => ({ path: key, message: issue.message })),
        };
      const etag = JSON.stringify(next);
      if (writeOptions.ifMatch !== undefined && writeOptions.ifMatch !== diskEtagOf(def, name, before))
        return { kind: 'conflict' };
      const prior = before === undefined ? undefined : def.schema.safeParse(before);
      const priorValue = prior?.success === true ? prior.data : undefined;
      // as the real port: a plugin's own write that adds a secret reference is held for the owner, judge or not
      const added = addedSecretReferenceSentences(priorValue, checked.data);
      const other = judgeLoosening(def, priorValue, checked.data);
      const sentences = [...other, ...added];
      const subject = { path, ...(name === undefined ? {} : { name }) };
      // `writeAsCaller` only: the added secret references go into effect when the ambient call is the owner, as the
      // real writer asks it (the same admission, the same `secretAdd` question) and about the same references: only the
      // ones the caller's edit introduces. One that only an edit already held on the disk names keeps the write held.
      const byCaller =
        added.length === 0 ? [] : addedSecretReferenceSentences([priorValue, onDisk.value], checked.data);
      const ownerAdds =
        asCaller === true &&
        byCaller.length > 0 &&
        byCaller.length === added.length &&
        judged(manifest.id, path, false, byCaller, true);
      const heldAdds = added.length > 0 && !ownerAdds;
      if (heldAdds || (other.length > 0 && !judged(manifest.id, path, false, other))) {
        heldValues.set(path, { etag, value: next });
        restamp(key, { ...subject, held: etag });
        return { kind: 'held', etag, id: `${path}@held`, sentences };
      }
      world.config.set(key, def.shape === 'file' ? next : { ...(all ?? {}), [name as string]: next });
      for (const listener of configListeners.get(key) ?? []) listener();
      restamp(key, subject);
      return { kind: 'written', etag, loosened: sentences };
    };
    return {
      file(def) {
        assertDeclared(def);
        const raw = world.config.get(def.file);
        return raw === undefined ? undefined : def.schema.parse(raw);
      },
      collection(def) {
        assertDeclared(def);
        const raw = (world.config.get(def.collection) ?? {}) as Record<string, unknown>;
        const out = new Map();
        for (const [name, value] of Object.entries(raw))
          if (def.name.test(name)) out.set(name, def.schema.parse(value));
        return out;
      },
      watch(def, listener) {
        assertDeclared(def);
        const key = keyOf(def);
        const set = configListeners.get(key) ?? new Set();
        set.add(listener);
        configListeners.set(key, set);
        return () => set.delete(listener);
      },
      watchState(def, listener) {
        assertDeclared(def);
        const key = keyOf(def);
        const set = stateListeners.get(key) ?? new Set();
        stateListeners.set(key, set);
        const entry = (change: ConfigStateChange): void => listener(change);
        set.add(entry);
        return () => void set.delete(entry);
      },
      fileState(def, name) {
        assertDeclared(def);
        const all = world.config.get(keyOf(def));
        const raw =
          def.shape === 'file'
            ? all
            : name === undefined
              ? undefined
              : (all as Record<string, unknown> | undefined)?.[name];
        const parsed = raw === undefined ? undefined : def.schema.safeParse(raw);
        // An edit held for the owner is on the disk while the tighter version stays in effect: the state is `held`, with
        // what the whole held version widens beyond the version in effect (the sentences its write answered).
        const held = heldValueAt(
          keyOf(def),
          def.shape === 'file' ? keyOf(def) : `${keyOf(def)}/${name as string}.yaml`,
        );
        if (held.held) {
          const prior = parsed?.success === true ? parsed.data : undefined;
          // A held REMOVAL has no value: it widens what removing the file does, judged against the defaults as `remove` does.
          if (held.value === undefined) {
            const defaults = def.schema.safeParse({});
            return {
              state: 'held',
              inEffect: parsed?.success === true,
              sentences:
                prior === undefined ? [] : judgeLoosening(def, prior, defaults.success ? defaults.data : undefined),
            };
          }
          const heldChecked = def.schema.safeParse(held.value);
          return {
            state: 'held',
            inEffect: parsed?.success === true,
            sentences: heldChecked.success
              ? [
                  ...judgeLoosening(def, prior, heldChecked.data),
                  ...addedSecretReferenceSentences(prior, heldChecked.data),
                ]
              : [],
          };
        }
        if (parsed === undefined) return { state: 'absent', inEffect: false, sentences: [] };
        return parsed.success
          ? { state: 'valid', inEffect: true, sentences: [] }
          : { state: 'invalid', inEffect: false, sentences: parsed.error.issues.map(issue => issue.message) };
      },
      // The etag only, of an own file that exists as a slot: the world's value as JSON (what its writes answer), or the
      // absent sentinel — the same refusals as the real port (another plugin's def, a name that is no file of the def).
      async etag(def, name) {
        assertDeclared(def);
        if (def.shape === 'file' ? name !== undefined : name === undefined || !def.name.test(name))
          throw new Error(`${manifest.id} has no config file of that name`);
        const all = world.config.get(keyOf(def));
        const value = def.shape === 'file' ? all : (all as Record<string, unknown> | undefined)?.[name as string];
        return diskEtagOf(def, name, value);
      },
      async write(def, name, edit, writeOptions = {}) {
        // As the real writer: a PATCH beside a held edit is made to both versions, judged as the caller's change alone.
        return await write(def, name, edit, writeOptions, undefined, undefined, true);
      },
      // As `write`, except that the secret references the edit adds go into effect when the AMBIENT call is the owner,
      // asked of the admission in use exactly as the real writer asks it, and that a PATCH of a file with an edit held
      // is made to both versions. Only `ifMatch` is read from the options.
      async writeAsCaller(def, name, edit, writeOptions = {}) {
        return await write(
          def,
          name,
          typeof edit === 'string' ? edit : { patch: edit.patch },
          writeOptions.ifMatch === undefined ? {} : { ifMatch: writeOptions.ifMatch },
          undefined,
          true,
          true,
        );
      },
      // The owner's patch: made to BOTH versions of a file with an edit held (merged one level deep into the keys
      // `within` names, as the real writer merges it), a plain write of that patch otherwise.
      async writeAsOwner(def, name, edit, writeOptions = {}) {
        // As the real writer, in its order: an undeclared def and a bad name are answered first, then a `within` that is
        // not a list is refused, never read as something else.
        if (!declared.includes(def)) return { kind: 'refused', reason: 'not_declared', issues: [] };
        if (def.shape === 'collection' && (name === undefined || !def.name.test(name)))
          return { kind: 'refused', reason: 'bad_name', issues: [] };
        const within = edit.within;
        if (!isWithinList(within))
          return {
            kind: 'refused',
            reason: 'schema',
            issues: [{ path: keyOf(def), message: '`within` must be a list of top-level key names' }],
          };
        return await write(def, name, { patch: edit.patch }, writeOptions, within, undefined, true);
      },
      async remove(def, name, writeOptions = {}) {
        if (!declared.includes(def)) return { kind: 'refused', reason: 'not_declared', issues: [] };
        const key = keyOf(def);
        if (def.shape === 'collection' && (name === undefined || !def.name.test(name)))
          return { kind: 'refused', reason: 'bad_name', issues: [] };
        const all = world.config.get(key) as Record<string, unknown> | undefined;
        const before = def.shape === 'file' ? all : all?.[name as string];
        if (writeOptions.ifMatch !== undefined && writeOptions.ifMatch !== diskEtagOf(def, name, before))
          return { kind: 'conflict' };
        const prior = before === undefined ? undefined : def.schema.safeParse(before);
        const defaults = def.schema.safeParse({});
        // as the real port: judged even with no defaults (`after` undefined), a throwing judgement held
        const sentences =
          prior?.success === true ? judgeLoosening(def, prior.data, defaults.success ? defaults.data : undefined) : [];
        const path = def.shape === 'file' ? key : `${key}/${name as string}.yaml`;
        const subject = { path, ...(name === undefined ? {} : { name }) };
        if (sentences.length > 0 && !judged(manifest.id, path, true, sentences)) {
          if (writeOptions.refuseIfHeld === true)
            return { kind: 'refused', reason: 'would_hold', issues: [], sentences };
          // A held REMOVAL is a held edit with no value: the entry's value is `undefined`, so `heldValueAt` says held.
          heldValues.set(path, { etag: ABSENT_STAMP.etag, value: undefined });
          restamp(key, { ...subject, held: ABSENT_STAMP.etag });
          return { kind: 'held', etag: 'absent', id: `${path}@held`, sentences };
        }
        if (def.shape === 'file') world.config.delete(key);
        else if (all !== undefined) {
          const { [name as string]: _gone, ...rest } = all;
          world.config.set(key, rest);
        }
        for (const listener of configListeners.get(key) ?? []) listener();
        restamp(key, subject);
        return { kind: 'written', etag: 'absent', loosened: sentences };
      },
      // The real writer's set over the in-memory values: each document checked as `write` checks one, every one before
      // any lands, and the set's answer decided by the SAME rule (`host/config/write-all.ts`). A file with an edit
      // already held for the owner refuses the set (`already_held`), as the real writer does: a set never discards a
      // held edit. The world holds nothing unreadable, so `unreadable` never arises here.
      async writeAll(documents) {
        const refs: ConfigDocumentRef[] = [];
        for (const document of documents) {
          const { def, name } = document;
          if (!declared.includes(def)) return refusedDocument('not_declared', { path: keyOf(def) });
          if (def.shape === 'collection' && (name === undefined || !def.name.test(name)))
            return refusedDocument('bad_name', { path: keyOf(def), ...(name === undefined ? {} : { name }) });
          refs.push(
            def.shape === 'file'
              ? { path: def.file }
              : { path: `${def.collection}/${name as string}.yaml`, name: name as string },
          );
        }
        const twice = repeatedDocument(refs);
        if (twice !== undefined)
          return refusedDocument('duplicate', { path: twice.path }, [DUPLICATE_ISSUE(twice.path)]);
        const nexts: unknown[] = [];
        const verdicts: DocumentVerdict[] = documents.map((document, index): DocumentVerdict => {
          const { def, name, edit } = document;
          const ref = refs[index] as ConfigDocumentRef;
          if (configStamps.get(keyOf(def))?.get(ref.path)?.stamp.state === 'held')
            return refusedDocument('already_held', ref, [ALREADY_HELD_ISSUE(ref.path)]);
          const all = world.config.get(keyOf(def)) as Record<string, unknown> | undefined;
          const before = def.shape === 'file' ? all : all?.[name as string];
          if (document.ifMatch !== undefined && document.ifMatch !== diskEtagOf(def, name, before))
            return { kind: 'conflict', ...ref };
          const prior = before === undefined ? undefined : def.schema.safeParse(before);
          const priorValue = prior?.success === true ? prior.data : undefined;
          if (typeof edit === 'object' && 'remove' in edit) {
            const defaults = def.schema.safeParse({});
            nexts[index] = undefined;
            const loosens =
              prior?.success === true
                ? judgeLoosening(def, prior.data, defaults.success ? defaults.data : undefined)
                : [];
            return { kind: 'ready', document: ref, removal: true, loosens, added: [] };
          }
          let next: unknown;
          if (typeof edit === 'string') {
            const read = readConfigText(edit);
            if (!read.ok) return refusedDocument('yaml', ref, [{ path: ref.path, message: 'this is not YAML' }]);
            next = read.read.value ?? {};
          } else next = patchedValue((before as Record<string, unknown> | undefined) ?? {}, edit.patch);
          const checked = def.schema.safeParse(next);
          if (!checked.success)
            return refusedDocument(
              'schema',
              ref,
              checked.error.issues.map(issue => ({ path: ref.path, message: issue.message })),
            );
          nexts[index] = next;
          const added = addedSecretReferenceSentences(priorValue, checked.data);
          return {
            kind: 'ready',
            document: ref,
            removal: false,
            loosens: [...judgeLoosening(def, priorValue, checked.data), ...added],
            added,
          };
        });
        const stop = firstStop(verdicts);
        if (stop !== undefined) return stop;
        const ready = verdicts as Extract<DocumentVerdict, { kind: 'ready' }>[];
        const judgement = judgeSet(ready, document =>
          judged(manifest.id, document.document.path, document.removal, document.loosens),
        );
        if (judgement.held.length > 0) return heldSet(judgement, documents.length);
        // All checked and judged: every document lands, then each file's listeners hear it once.
        const touched = new Set<string>();
        for (const [index, document] of documents.entries()) {
          const { def, name } = document;
          const key = keyOf(def);
          const next = nexts[index];
          touched.add(key);
          if (def.shape === 'file') {
            if (next === undefined) world.config.delete(key);
            else world.config.set(key, next);
            continue;
          }
          const { [name as string]: _gone, ...rest } = (world.config.get(key) ?? {}) as Record<string, unknown>;
          world.config.set(key, next === undefined ? rest : { ...rest, [name as string]: next });
        }
        for (const key of touched) for (const listener of configListeners.get(key) ?? []) listener();
        for (const ref of refs)
          restamp(ref.path.includes('/') ? ref.path.slice(0, ref.path.lastIndexOf('/')) : ref.path, ref);
        return {
          kind: 'written',
          documents: ready.map((document, index) => ({
            ...document.document,
            etag: nexts[index] === undefined ? 'absent' : JSON.stringify(nexts[index]),
            removed: document.removal,
            loosened: judgement.loosened[index] ?? [],
          })),
        };
      },
    };
  };

  const pins = new PinRegistry(
    () =>
      options.pinner ?? {
        pin: async () => {
          throw unsupportedPlatform('the test host');
        },
      },
  );
  /** The test roots' stand-in inodes, so `fileIdentity` can tell two publishes of one name apart. */
  const inodes = new Map<string, bigint>();
  let nextInode = 0n;
  /** The test roots each handle was made for: its plugin, root, scope and key prefix (for `share` / `copyShared`). */
  const testHandles = new WeakMap<
    object,
    {
      readonly plugin: string;
      readonly root: RootName;
      readonly ferret?: FerretId;
      readonly prefix: string | undefined;
    }
  >();
  /**
   * The test world's own-root check: a folder of a handle made for `plugin`, inside its scope, that exists (a file is
   * beneath it). The world has no links, so its one spelling is the path itself.
   */
  const testFolderSpellings = async (
    plugin: string,
    folder: { readonly root: RootHandle; readonly path: string },
  ): Promise<readonly string[] | undefined> => {
    const known = testHandles.get(folder.root);
    if (known === undefined || known.plugin !== plugin || known.prefix === undefined) return undefined;
    if (!PROCESS_FOLDER_ROOTS.has(known.root)) return undefined;
    const path = folder.path;
    if (
      typeof path !== 'string' ||
      path.split('/').includes('..') ||
      (path !== known.prefix && !path.startsWith(`${known.prefix}/`))
    )
      throw new Error(`${path} is outside the root`);
    // judged against the UNSCOPED root, as production does (BG-008): `prefix` is `/<root>` or `/<root>/<scope>`
    if (!processFolderAllowed(known.root, path.slice(`/${known.root}/`.length)))
      throw new Error('kernel.processes accepts only a folder at or under fleet/homes/<id>');
    if (![...world.roots.keys()].some(key => key.startsWith(`${path}/`))) throw new Error(`no such folder ${path}`);
    return [path];
  };
  /** `linkTo`'s links in the test world: the link's path → the target path it points at. */
  const testLinks = new Map<string, string>();
  /** `setMode`'s modes in the test world, by path; a path never set keeps the default (`0o600` for a file). */
  const testModes = new Map<string, number>();
  /** Files of the test world that have a second name (`TestHost.putRootHardLink`), by key. */
  const testHardLinks = new Set<string>();
  /** Folders `makeDirectory` made, so an EMPTY folder exists in the flat test world (a rmdir has something to remove). */
  const testMadeFolders = new Set<string>();
  /** A folder exists in the flat test world when it was made, or a file, a link or a made folder lies under it. */
  const testFolderExists = (path: string): boolean =>
    testMadeFolders.has(path) ||
    [...world.roots.keys(), ...testLinks.keys(), ...testMadeFolders].some(key => key.startsWith(`${path}/`));
  const testHarnessFile = (manifest: Manifest, absolutePath: string): RootFileHandle => {
    const refusal = harnessFileRefusal({
      plugin: manifest.id,
      mayHold: mayHoldRoot(manifest.id, 'harness-home'),
      roots: manifest.permissions?.roots ?? [],
      names: manifest.permissions?.harnessFiles,
      home: options.fenceHome ?? '/test-home',
      absolutePath,
    });
    if (refusal !== undefined) throw new RootError(refusal);
    const text = (): string | undefined => options.harnessFiles?.[absolutePath];
    const stat = () => {
      const found = text();
      return found === undefined
        ? undefined
        : { kind: 'file' as const, size: found.length, modified: clock.now(), mode: 0o600, links: 1 };
    };
    const bytes = (): Uint8Array => {
      const found = text();
      if (found === undefined) throw new Error(`no such file ${absolutePath}`);
      return new TextEncoder().encode(found);
    };
    const identity = () => (text() === undefined ? undefined : { device: 1n, inode: 1n });
    return Object.freeze({
      name: 'harness-home' as const,
      path: absolutePath,
      stat: async () => stat(),
      lstat: async () => stat(),
      readText: async (limit?: number) => new TextDecoder().decode(bytes().slice(0, limit)),
      readBytes: async (limit?: number | { readonly offset: number; readonly length: number }) => {
        if (typeof limit === 'number') return bytes().slice(0, limit);
        if (limit === undefined) return bytes();
        if (limit.length > MAX_ROOT_WINDOW_BYTES || limit.offset < 0 || limit.length < 0)
          throw new RootError('outside');
        return bytes().slice(limit.offset, limit.offset + limit.length);
      },
      fileIdentity: async () => identity(),
      readDurable: async <T>(limit?: number, hold?: (read: RootDurableHeld) => Promise<T>) => {
        if (text() === undefined) return undefined;
        const read = { bytes: bytes().slice(0, limit), identity: { device: 1n, inode: 1n } };
        if (hold === undefined) return read as T;
        return await hold({ ...read, stillNames: async () => identity() !== undefined });
      },
    });
  };
  /** Every tree a test plugin minted: the files it holds now (a flat copy), and where it came from. */
  const sharedTrees = new SharedTrees<{
    readonly files: () => readonly (readonly [string, string])[];
  }>();
  const rootsFor = (manifest: Manifest): KernelPorts['roots'] => {
    // As the real host: every tree a plugin minted is revoked when the host stops it.
    const life = { live: true };
    stopHandlers.push(() => {
      life.live = false;
    });
    const under = (folder: string, entries: Iterable<readonly [string, string]>): (readonly [string, string])[] =>
      [...entries]
        .filter(([key]) => key.startsWith(`${folder}/`))
        .map(([key, value]) => [key.slice(folder.length + 1), value]);
    return {
      harnessFile: absolutePath => testHarnessFile(manifest, absolutePath),
      share: async source => {
        if (manifest.permissions?.shareTrees !== true) return refuseShared('not_permitted');
        const folder = ownStateTree(manifest.data?.state ?? [], source.state, source.name);
        if (folder === undefined) return refuseShared('not_own');
        const state = world.states.get(manifest.id);
        const decoder = new TextDecoder();
        // A planted link in the test store is metadata only and never copied, as the real copy skips a link.
        const files = () =>
          state === undefined
            ? []
            : [
                ...under(folder, state.files),
                ...under(
                  folder,
                  [...state.bytes].map(([key, bytes]): readonly [string, string] => [key, decoder.decode(bytes)]),
                ),
              ];
        if (files().length === 0 && state?.directories.has(folder) !== true)
          throw new Error(`no such folder ${folder}`);
        return sharedTrees.mint(folder.slice(folder.lastIndexOf('/') + 1), { files }, life);
      },
      root(name, scope) {
        if (!(manifest.permissions?.roots ?? []).includes(name) || !mayHoldRoot(manifest.id, name)) {
          // The real host's refusal for the one root whose twin is the real rules (`testing/project-files.ts`).
          if (name === 'project-files') throw new RootError('not_declared');
          throw new Error(`${manifest.id}: root ${name} is not declared`);
        }
        // A `within` anchor is judged by the one rule production reads (`anchorWalk`): the folder itself or an ancestor of
        // it, compared by component, on a root that takes an absolute folder. Anything else names no folder here either.
        // The world holds no real disk folders for an absolute scope, so the lstat walk itself is production's alone.
        const anchoredFolder = (folder: string | undefined): string | undefined =>
          scope?.within === undefined ||
          (folder !== undefined && takesAnchor(name) && anchorWalk(folder, scope.within) !== undefined)
            ? folder
            : undefined;
        if (name === 'project-files') {
          // The real host's rules over the flat world (`testing/project-files.ts`), with the same refusals.
          const project = projectFilesHandle({
            plugin: manifest.id,
            patterns: manifest.permissions?.projectFiles,
            folder: anchoredFolder(projectFilesScope(scope?.subfolder)),
            within: scope?.within,
            linkedFolders: options.linkedProjectFolders,
            fenceHome: options.fenceHome ?? '/test-home',
            setModeDeclared: manifest.permissions?.setMode === true,
            noDescriptorReach: options.noDescriptorReach === true,
            files: world.roots,
            links: testLinks,
            hardLinks: testHardLinks,
            modes: testModes,
            inodes,
            nextInode: () => (nextInode += 1n),
            now: () => clock.now(),
            known: other => {
              const found = testHandles.get(other);
              return found === undefined
                ? undefined
                : { plugin: found.plugin, ...(found.root === 'project-files' ? { keyOf: projectFileKey } : {}) };
            },
          });
          testHandles.set(project, { plugin: manifest.id, root: name, prefix: undefined });
          return project;
        }
        // The same scope rule as production (`scopedSubfolder`): a `sessions` handle is one minted ferret folder, an
        // `agent-homes` handle one relative path. Each scope is its own namespace, so a test can prove two ferrets do not
        // see each other; a refused scope resolves nothing.
        const scoped = scopedSubfolder(name, scope?.subfolder);
        // The folder named as production names it (`absolute()`: `./`, `//`, `x/..` and a trailing slash resolved) and
        // only by the roots that take an absolute folder, so a spelling production accepts is accepted here too.
        const named =
          (name === 'imports' || name === 'harness-history' || name === 'harness-home') &&
          scope?.subfolder?.startsWith('/') === true &&
          !scope.subfolder.includes('\0')
            ? absolute(scope.subfolder, 'a root')
            : undefined;
        const below = anchoredFolder(named) === undefined && scope?.within !== undefined ? undefined : scoped;
        const prefix = below === undefined ? undefined : below === '' ? `/${name}` : `/${name}/${below}`;
        const fileStat = (path: string) => ({
          kind: 'file' as const,
          size: (world.roots.get(path) ?? '').length,
          modified: clock.now(),
          mode: testModes.get(path) ?? 0o600,
          links: 1,
        });
        /** `path` with every link on the way (the leaf's too) replaced by what it points at; one that leaves this root is `link_escape`. */
        const followLinks = (path: string): string => {
          let current = path;
          for (let hops = 0; hops <= 40; hops += 1) {
            const parts = current.split('/');
            const linked = parts.findIndex((_, index) => testLinks.has(parts.slice(0, index + 1).join('/')));
            if (linked < 0) return current;
            const pointsAt = testLinks.get(parts.slice(0, linked + 1).join('/')) as string;
            if (prefix === undefined || (pointsAt !== prefix && !pointsAt.startsWith(`${prefix}/`)))
              throw new RootError('link_escape');
            current = [pointsAt, ...parts.slice(linked + 1)].join('/');
          }
          throw new RootError('link_escape');
        };
        /** The names directly inside a folder of the flat test world, sorted, each with the kind it is (a deeper key is a folder). */
        const childrenOf = (folder: string): ReadonlyMap<string, 'file' | 'symlink' | 'directory'> => {
          const found = new Map<string, 'file' | 'symlink' | 'directory'>();
          const note = (keys: Iterable<string>, kind: 'file' | 'symlink' | 'directory'): void => {
            for (const key of keys) {
              if (!key.startsWith(`${folder}/`)) continue;
              const rest = key.slice(folder.length + 1);
              const slash = rest.indexOf('/');
              if (slash < 0) found.set(rest, kind);
              else if (!found.has(rest.slice(0, slash))) found.set(rest.slice(0, slash), 'directory');
            }
          };
          note(testMadeFolders, 'directory');
          note(testLinks.keys(), 'symlink');
          note(world.roots.keys(), 'file');
          return new Map([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        };
        /**
         * A path of THIS handle's scope, or the refusal production makes for one outside it: no NUL, no `..`, NORMALIZED
         * (`.` segments, doubled and trailing slashes gone) and a relative name read from the scope's root, as
         * `lexicalInRoot` does before every call that names a leaf (BG-006), so a forged spelling names the same leaf as
         * its plain form on both hosts.
         */
        const ownPath = (path: string): string => {
          if (prefix === undefined || typeof path !== 'string' || path.includes('\0') || path.split('/').includes('..'))
            throw new RootError('outside');
          const named = posix.normalize(path.startsWith('/') ? path : `${prefix}/${path}`).replace(/(?<=.)\/+$/u, '');
          // the scope's own folder (`resolve('.')`) keeps its `/.` spelling: it is no leaf of the scope
          if (named === prefix && path !== prefix) return `${prefix}/.`;
          if (!named.startsWith(`${prefix}/`)) throw new RootError('outside');
          return named;
        };
        const handle: RootHandle = {
          name,
          internal: isKernelMadeRoot(name),
          resolve(relative) {
            if (prefix === undefined || relative.startsWith('/') || relative.split('/').includes('..'))
              return { ok: false, error: 'outside' };
            return { ok: true, value: `${prefix}/${relative}` as never };
          },
          readText: async path => {
            const text = world.roots.get(path);
            if (text === undefined) throw new Error(`no such file ${path}`);
            return text;
          },
          readBytes: async (path, limit) => {
            const bytes = new TextEncoder().encode(await handle.readText(path));
            if (typeof limit === 'number') return bytes.slice(0, limit);
            if (limit === undefined) return bytes;
            if (limit.length > MAX_ROOT_WINDOW_BYTES || limit.offset < 0 || limit.length < 0)
              throw new Error('the window is out of range');
            return bytes.slice(limit.offset, limit.offset + limit.length);
          },
          readTail: async (path, maxBytes) => {
            if (maxBytes > MAX_ROOT_WINDOW_BYTES || maxBytes < 0) throw new Error('the tail is out of range');
            const bytes = new TextEncoder().encode(await handle.readText(path));
            return { bytes: bytes.slice(Math.max(0, bytes.length - maxBytes)), size: bytes.length };
          },
          writeText: async (path, text, writeOptions) => {
            if (writeOptions?.exclusive === true && world.roots.has(path)) throw new Error(`${path} already exists`);
            if (writeOptions?.replaceExisting === true && !world.roots.has(path))
              throw new Error(`no such file ${path}`);
            world.roots.set(path, text);
          },
          writeBytes: async (path, bytes, writeOptions) => {
            if (writeOptions?.exclusive === true && world.roots.has(path)) throw new Error(`${path} already exists`);
            if (writeOptions?.replaceExisting === true && !world.roots.has(path))
              throw new Error(`no such file ${path}`);
            world.roots.set(path, new TextDecoder().decode(bytes));
          },
          publish: async (path, bytes, publishOptions) => {
            if (publishOptions?.exclusive === true && world.roots.has(path)) return { outcome: 'exists' };
            world.roots.set(path, new TextDecoder().decode(bytes));
            nextInode += 1n;
            const inode = nextInode;
            inodes.set(path, inode);
            return { outcome: 'published', identity: { device: 1n, inode } };
          },
          readDurable: async (path, limit, hold) => {
            const text = world.roots.get(path);
            if (text === undefined) return undefined;
            const bytes = new TextEncoder().encode(text);
            const identity = { device: 1n, inode: inodes.get(path) ?? 0n };
            const read = { bytes: limit === undefined ? bytes : bytes.slice(0, limit), identity };
            if (hold === undefined) return read as never;
            return await hold({
              ...read,
              stillNames: async () => world.roots.has(path) && (inodes.get(path) ?? 0n) === identity.inode,
            });
          },
          syncDirectory: async () => {},
          fileIdentity: async path =>
            world.roots.has(path) ? { device: 1n, inode: inodes.get(path) ?? 0n } : undefined,
          copyShared: async (tree, to, copyOptions) => {
            if (!receivingRoot(name)) return refuseShared('not_internal');
            const shared = sharedTrees.open(tree);
            // As production: the destination lies inside the receiving handle's scope, is NEW, and the walk is bounded.
            const place = ownPath(to);
            if (world.roots.has(place) || testLinks.has(place) || testFolderExists(place))
              throw new RootError('outside');
            const files = shared.files();
            const folders = new Set(
              files.flatMap(([key]) =>
                key
                  .split('/')
                  .slice(0, -1)
                  .map((_, index, parts) => parts.slice(0, index + 1).join('/')),
              ),
            );
            if (files.length + folders.size > (copyOptions?.maxEntries ?? DEFAULT_COPY_ENTRIES))
              throw new RootError('outside');
            // the test roots are one flat map: a link and a copy both put every file under `to`
            for (const [key, value] of files) world.roots.set(`${to}/${key}`, value);
            return copyOptions?.link === true ? 'linked' : 'copied';
          },
          copyTree: async (source, from, to, copyOptions) => {
            // A SOURCE that is a project folder is gated by its own handle (the declared set, no link on the way), and no
            // link is ever made from one into another root: the same two refusals as production (`HANDLES.real`, `linkTarget`).
            const projectSource = PROJECT_SOURCES.get(source);
            projectSource?.(from);
            // The same two refusals, in the same order (`copyTree` in `host/roots.ts`): a link is written only into a root
            // that takes links, and never from an owner's root.
            if (copyOptions?.link === true) {
              if (isReadOnlyRoot(name) || !takesLinks(name)) throw new RootError('read_only');
              const sourceRoot = testHandles.get(source)?.root;
              if (projectSource !== undefined || (sourceRoot !== undefined && isOwnerRoot(sourceRoot)))
                throw new RootError('not_declared');
            }
            // the test roots are one flat map: copy (or, for a link, alias) every file under `from`
            const fromKey = projectSource === undefined ? from : projectFileKey(from);
            for (const [key, text] of [...world.roots])
              if (key.startsWith(`${fromKey}/`)) world.roots.set(`${to}${key.slice(fromKey.length)}`, text);
          },
          ensurePrivateDirectory: async () => {},
          lstat: async path => {
            if (testLinks.has(path)) return { kind: 'symlink', size: 0, modified: clock.now(), mode: 0o777, links: 1 };
            if (world.roots.has(path)) return fileStat(path);
            return testFolderExists(path)
              ? { kind: 'directory', size: 0, modified: clock.now(), mode: 0o700, links: 1 }
              : undefined;
          },
          makeDirectory: async path => {
            testMadeFolders.add(ownPath(path));
          },
          // As production: every link on the way (the leaf's too) is resolved, and what it reaches must lie inside this
          // root (`link_escape`) and exist (a link that reaches nothing is no real path: a plain error).
          realPath: async path => {
            const reached = followLinks(path);
            if (!world.roots.has(reached) && !testFolderExists(reached)) throw new Error(`no such file ${path}`);
            return reached as FencedPath;
          },
          // A folder's DIRECT children (a made empty folder too, a link by its own name), sorted, as the real host lists
          // them; a link to a folder is listed as the folder it reaches.
          list: async path => [...childrenOf(followLinks(path)).keys()],
          entries: async path =>
            [...childrenOf(followLinks(path))].map(([childName, kind]) => {
              const child = `${followLinks(path)}/${childName}`;
              if (kind === 'file') return { name: childName, ...fileStat(child) };
              return {
                name: childName,
                kind,
                size: 0,
                modified: clock.now(),
                mode: kind === 'symlink' ? 0o777 : 0o700,
                links: 1,
              };
            }),
          stat: async path => (world.roots.has(path) ? fileStat(path) : undefined),
          // The real host's rules over the flat test world, with the same refusals: the LEAF IS NEVER FOLLOWED (the parent
          // is opened first, then the entry goes by its own name; a link goes as a link and its target stays), and
          // `onlyIfEmpty` is `rmdir` (one step: refused `not_empty` when anything is inside, never recursing).
          // It does NOT model the private-file fence: the test world holds no private file, so a tree (or the root
          // itself) is removed whole here, where the real host refuses `fenced` for a held member inside it.
          remove: async (path, removeOptions) => {
            if (isReadOnlyRoot(name)) throw new RootError('read_only');
            const named = ownPath(path);
            // The root itself (`resolve('.')`) is a folder like any other: `onlyIfEmpty` refuses it while anything is in
            // it, and without the option everything goes with it (the flat world has no base folder to be left missing).
            if (named === `${prefix}/.`) {
              const inside = (key: string): boolean => key.startsWith(`${prefix}/`);
              const holds = [...world.roots.keys(), ...testLinks.keys(), ...testMadeFolders].some(inside);
              if (removeOptions?.onlyIfEmpty === true && holds) throw new RootError('not_empty');
              for (const key of [...world.roots.keys()]) if (inside(key)) world.roots.delete(key);
              for (const key of [...testLinks.keys()]) if (inside(key)) testLinks.delete(key);
              for (const key of [...testModes.keys()]) if (inside(key)) testModes.delete(key);
              for (const key of [...testMadeFolders]) if (inside(key)) testMadeFolders.delete(key);
              return;
            }
            // The PARENT is resolved (a link on the way is followed, and judged: one that leaves this root is
            // `link_escape`); the leaf's own name is appended as it is.
            let parent = named.slice(0, named.lastIndexOf('/'));
            for (let hops = 0; ; hops += 1) {
              const parts = parent.split('/');
              const index = parts.findIndex((_, at) => testLinks.has(parts.slice(0, at + 1).join('/')));
              if (index < 0) break;
              const pointsAt = testLinks.get(parts.slice(0, index + 1).join('/')) as string;
              if (hops > 40 || prefix === undefined || (pointsAt !== prefix && !pointsAt.startsWith(`${prefix}/`)))
                throw new RootError('link_escape');
              parent = [pointsAt, ...parts.slice(index + 1)].join('/');
            }
            if (parent !== prefix && (world.roots.has(parent) || !testFolderExists(parent)))
              throw new RootError('changed');
            const place = `${parent}/${named.slice(named.lastIndexOf('/') + 1)}`;
            const under = (key: string): boolean => key === place || key.startsWith(`${place}/`);
            if (testLinks.has(place)) {
              testLinks.delete(place);
              testModes.delete(place);
              return;
            }
            if (world.roots.has(place)) {
              world.roots.delete(place);
              testModes.delete(place);
              return;
            }
            if (!testFolderExists(place)) return;
            if (removeOptions?.onlyIfEmpty === true) {
              const holdsEntry = [...world.roots.keys(), ...testLinks.keys(), ...testMadeFolders].some(key =>
                key.startsWith(`${place}/`),
              );
              if (holdsEntry) throw new RootError('not_empty');
            }
            for (const key of [...world.roots.keys()]) if (under(key)) world.roots.delete(key);
            for (const key of [...testLinks.keys()]) if (under(key)) testLinks.delete(key);
            for (const key of [...testModes.keys()]) if (under(key)) testModes.delete(key);
            for (const key of [...testMadeFolders]) if (under(key)) testMadeFolders.delete(key);
          },
          // The real host's rules (`host/root-rules.ts`) over the flat test world, with the same refusals.
          linkTo: async (at, target) => {
            if (isReadOnlyRoot(name) || !takesLinks(name)) throw new RootError('read_only');
            const known = testHandles.get(target?.root ?? {});
            if (known === undefined || known.plugin !== manifest.id) throw new RootError('not_declared');
            // a project file is never the target of a link another root writes (`linkTarget` on the real host, BG-014 m1)
            if (known.root === 'project-files') throw new RootError('not_declared');
            const to = target.path as string;
            const within = known.prefix;
            if (within === undefined || to.split('/').includes('..') || (to !== within && !to.startsWith(`${within}/`)))
              throw new RootError('outside');
            if (testLinks.has(to)) throw new RootError('link_escape');
            if (!world.roots.has(to) && !testFolderExists(to) && target.dangling !== true)
              throw new RootError('outside');
            const place = ownPath(at);
            if (world.roots.has(place) || testFolderExists(place) || testLinks.has(place))
              throw new RootError('outside');
            testLinks.set(place, to);
          },
          rename: async (from, to) => {
            if (isReadOnlyRoot(name) || !takesRenames(name)) throw new RootError('read_only');
            const names = renameNamesRefusal(from, to);
            if (names !== undefined) throw new RootError(names);
            const source = ownPath(from);
            const target = ownPath(to);
            // As production, the links on the way to BOTH ends are judged first (a link that reaches something is
            // `link_escape`, whichever end it lies at), and then each parent is opened (the source's, then the target's):
            // one that is missing, is a file, or lies behind a link that reaches nothing is `changed`. The leaf is never
            // followed.
            const parents = [source, target].map(end => end.slice(0, end.lastIndexOf('/')));
            const stepsOf = (parent: string): readonly string[] =>
              parent
                .split('/')
                .map((_, index, parts) => parts.slice(0, index + 1).join('/'))
                .filter(step => step !== '' && testLinks.has(step));
            const reaches = (step: string): boolean => {
              // a link to a link is followed to its end, as `realpath` does; a chain that ends nowhere reaches nothing
              let end = testLinks.get(step) as string;
              for (let hops = 0; hops < 40 && testLinks.has(end); hops += 1) end = testLinks.get(end) as string;
              return !testLinks.has(end) && (world.roots.has(end) || testFolderExists(end));
            };
            for (const parent of parents) if (stepsOf(parent).some(reaches)) throw new RootError('link_escape');
            for (const parent of parents) {
              if (stepsOf(parent).length > 0) throw new RootError('changed');
              if (parent !== prefix && (world.roots.has(parent) || !testFolderExists(parent)))
                throw new RootError('changed');
            }
            const isFile = world.roots.has(source);
            const isLink = testLinks.has(source);
            const isFolder = testFolderExists(source);
            if (!isFile && !isLink && !isFolder) throw new RootError('outside');
            if (world.roots.has(target) || testLinks.has(target) || testFolderExists(target))
              throw new RootError('outside');
            if (target.startsWith(`${source}/`)) throw new RootError('changed');
            // The flat world keeps files, links and modes in three maps keyed by full path: everything at `source`
            // or under it moves to the same place under `target`, a link as the text it holds.
            const under = (key: string): boolean => key === source || key.startsWith(`${source}/`);
            const placed = (key: string): string => `${target}${key.slice(source.length)}`;
            for (const [key, text] of [...world.roots])
              if (under(key)) {
                world.roots.set(placed(key), text);
                world.roots.delete(key);
              }
            for (const [key, pointsAt] of [...testLinks])
              if (under(key)) {
                testLinks.set(placed(key), pointsAt);
                testLinks.delete(key);
              }
            for (const [key, mode] of [...testModes])
              if (under(key)) {
                testModes.set(placed(key), mode);
                testModes.delete(key);
              }
            for (const key of [...testMadeFolders])
              if (under(key)) {
                testMadeFolders.delete(key);
                testMadeFolders.add(placed(key));
              }
          },
          unlink: async linkName => {
            if (isReadOnlyRoot(name) || !takesUnlinks(name)) throw new RootError('read_only');
            const refused = unlinkNameRefusal(linkName);
            if (refused !== undefined) throw new RootError(refused);
            const place = ownPath(linkName);
            // As production, the parent is opened first: a link anywhere on the way to it is `link_escape`.
            const parent = place.slice(0, place.lastIndexOf('/'));
            const steps = parent.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
            if (steps.some(step => step !== '' && testLinks.has(step))) throw new RootError('link_escape');
            if (!testLinks.has(place)) throw new RootError('outside');
            testLinks.delete(place);
          },
          setMode: async (path, mode) => {
            if (manifest.permissions?.setMode !== true) throw new RootError('not_declared');
            if (isReadOnlyRoot(name)) throw new RootError('read_only');
            const bits = permittedMode(isKernelMadeRoot(name), mode);
            if (bits === undefined) throw new RootError('outside');
            const place = ownPath(path);
            if (testLinks.has(place)) throw new RootError('link_escape');
            if (!world.roots.has(place) && !testFolderExists(place)) throw new RootError('outside');
            testModes.set(place, bits);
          },
          pin: async (path, pinOptions) => {
            // The test world keeps no state home, so its pin fences nothing beneath the root.
            const held = await pins.pin(manifest.id, path, pinOptions);
            return Object.freeze({ ...held, fenced: async (rels: readonly string[]) => rels.map(() => false) });
          },
        };
        testHandles.set(handle, {
          plugin: manifest.id,
          root: name,
          ...(scope?.ferret === undefined ? {} : { ferret: scope.ferret }),
          prefix,
        });
        return handle;
      },
    };
  };

  // What an item names, by the real host's rule (`host/items.ts`): the installed items `options.items` names, united with
  // the owner's config collection of each kind, read from the world at every check. Built on first use, when every
  // plugin's config is declared.
  let liveItems: ItemReachOf | undefined;
  const itemsOf: ItemReachOf = kind => {
    liveItems ??= itemReach({
      installed: options.items ?? NO_ITEMS,
      configOwned: configOwnedKinds(
        options.plugins.map(plugin => plugin.manifest as Manifest),
        id => configPort(options.plugins.find(plugin => plugin.manifest.id === id)?.manifest as Manifest),
      ),
    });
    return liveItems(kind);
  };
  /** A plugin's own declared resolvers, asked at each call, as the real host asks them. */
  const resolversOf =
    (id: string): ResolverOf =>
    name =>
      (
        built.find(b => b.manifest.id === id)?.half?.resolvers as
          | Readonly<Record<string, (() => readonly string[]) | undefined>>
          | undefined
      )?.[name];

  const kernelFor = (manifest: Manifest): KernelPorts => {
    let state = world.states.get(manifest.id);
    if (state === undefined) {
      state = new MemoryStateFolder(() => clock.nowMs());
      world.states.set(manifest.id, state);
    }
    const publishes = new Set((manifest.data?.publishes ?? []).map(event => event.name));
    const declaredNetwork = effectivePermissions(manifest.id, manifest.permissions?.network ?? []);
    const mayReach = (hostname: string, host: string): boolean =>
      hostPermitted(declaredNetwork, itemsOf, hostname, resolversOf(manifest.id), host);
    const fetchPort: FetchPort = {
      async request(url, init) {
        const parsed = new URL(url);
        if (!mayReach(parsed.hostname, parsed.host))
          throw new Error(`${manifest.id}: network ${parsed.host} is not declared`);
        if (options.fetch === undefined) throw new Error(`${manifest.id}: fetch ${parsed.host} with no fetch fake`);
        return options.fetch(parsed, init);
      },
    };
    return {
      clock,
      log: logFor(manifest.id),
      state: state.port(manifest.data?.state ?? []),
      config: configPort(manifest),
      roots: rootsFor(manifest),
      events: {
        publish(event, payload) {
          if (!publishes.has(event.name)) throw new Error(`${manifest.id} publishes undeclared event ${event.name}`);
          event.schema.parse(payload);
          published.push({ event: event.name, payload });
          deliver(event.name, payload);
        },
      },
      jobs: {
        add(job) {
          jobs.set(job.id, signal => job.run(signal));
        },
        kick(id) {
          const run = jobs.get(id);
          if (run !== undefined) track(run(stopController.signal));
        },
      },
      workers: {
        start() {
          throw new Error('the test host starts no workers; test the worker module directly');
        },
      },
      spawn: {
        async run(program, args, spawnOptions) {
          if (detachedAsked(spawnOptions))
            refuseDetached(manifest, itemsOf, 'run', program, spawnOptions, resolversOf(manifest.id));
          if (
            !spawnPermitted(
              effectivePermissions(manifest.id, manifest.permissions?.spawn ?? []),
              itemsOf,
              program,
              resolversOf(manifest.id),
            )
          )
            throw new Error(`${manifest.id}: spawn ${program} is not declared`);
          if (options.spawn === undefined) throw new Error(`${manifest.id}: spawn ${program} with no spawn fake`);
          return options.spawn(program, args, spawnOptions);
        },
        async runBytes(program, args, spawnOptions) {
          if (detachedAsked(spawnOptions))
            refuseDetached(manifest, itemsOf, 'runBytes', program, spawnOptions, resolversOf(manifest.id));
          const result = await this.run(program, args, spawnOptions);
          const all = new TextEncoder().encode(result.stdout);
          const cap = spawnOptions?.maxStdoutBytes ?? 1024 * 1024;
          return {
            exitCode: result.exitCode ?? -1,
            stdout: all.slice(0, cap),
            stderr: result.stderr,
            stdoutTruncated: all.byteLength > cap,
            stderrTruncated: false,
            // The real `runBytes` kills at its timeout and answers `timedOut`, `-1`; a fake `run` that answers the
            // signal shape (`exitCode: null`) under a timeout the caller set is that same event.
            timedOut: result.exitCode === null && spawnOptions?.timeout !== undefined,
          };
        },
        start(program, args, spawnOptions): ChildHandle {
          if (detachedAsked(spawnOptions)) {
            refuseDetached(manifest, itemsOf, 'start', program, spawnOptions, resolversOf(manifest.id));
            if (options.detachedStart === undefined)
              throw new Error(`${manifest.id}: detached ${program} with no detachedStart fake`);
            return detachedHandle(options.detachedStart(program, args, spawnOptions));
          }
          throw new Error(
            `${manifest.id}: the test host does not start long-lived ${program}; fake the port that does`,
          );
        },
      },
      fetch: fetchPort,
      scratch: options.scratch ?? scratchPort('fy-test-'),
      websocket: {
        connect(url) {
          const parsed = new URL(String(url));
          if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
            throw new Error(`${manifest.id}: ${parsed.protocol} is not a WebSocket address`);
          if (
            !hostPermitted(
              effectivePermissions(manifest.id, manifest.permissions?.network ?? []),
              itemsOf,
              parsed.hostname,
              resolversOf(manifest.id),
              parsed.host,
            )
          )
            throw new Error(`${manifest.id}: network ${parsed.host} is not declared`);
          if (options.websocket === undefined)
            throw new Error(`${manifest.id}: dial ${parsed.host} with no websocket fake`);
          return options.websocket(parsed);
        },
      },
      carrierListener: options.carrierListener ?? {
        open: async () => {
          throw new Error(`${manifest.id}: open a carrier listener with no carrierListener fake`);
        },
      },
      identity,
      paths: gatedWhich(
        manifest.id,
        manifest.permissions?.which === true,
        gatedPaths(
          manifest.id,
          manifest.permissions?.checkDirectory === true,
          gatedOverrides(
            manifest.id,
            manifest.permissions?.whichOverrides,
            Object.freeze({
              home: () => options.ownerHome ?? '/home/owner',
              // The real lookup (`host/which.ts`) over the test world: an executable is one the test named in
              // `options.executables`, and `PATH` is `options.searchPath`.
              which: async (name: string, whichOptions?: { readonly directories?: readonly string[] }) =>
                await whichCommand(
                  name,
                  { path: options.searchPath, directories: whichOptions?.directories ?? [] },
                  async path => (options.executables ?? []).includes(path),
                ),
              // The real rules (`host/which.ts`) over the test world, behind the real gates below.
              locate: async (
                name: string,
                locateOptions: { readonly override: string; readonly directories?: readonly string[] },
              ) =>
                await locateCommand(name, locateOptions, {
                  variable: variable =>
                    Object.hasOwn(options.operatorVariables ?? {}, variable)
                      ? options.operatorVariables?.[variable]
                      : undefined,
                  path: options.searchPath,
                  probe: async path => (options.executables ?? []).includes(path),
                }),
              // Readers from the plugins under test's DECLARED manifests, as the real host computes them.
              whichFor: async (name: string, env: ChildEnvironment) => {
                let searchPath: string | undefined;
                try {
                  // As the real host: the Vault's bound opener (a loaded Vault's `childEnvironments`), else the option.
                  const opener =
                    (providedBy.get(ChildEnvironmentPort.name) as ChildEnvironmentOpener | undefined) ??
                    options.childEnvironments;
                  searchPath = opener?.searchPathOf(env, handleReaders(manifest.id, manifests));
                } catch {
                  searchPath = undefined;
                }
                return await whichForCommand(name, searchPath, async path =>
                  (options.executables ?? []).includes(path),
                );
              },
              // The test world keeps no disk: a directory is one the test named in `options.directories` (its real path).
              checkDirectory: async (absolutePath: string) => {
                const requested = absolutePath.trim();
                if (!requested.startsWith('/'))
                  return err({
                    reason: 'not_absolute' as const,
                    message: `session working directory must be absolute: ${JSON.stringify(absolutePath)}`,
                  });
                const real = options.directories?.[requested];
                return real === undefined
                  ? err({
                      reason: 'not_a_directory' as const,
                      message: `session working directory is not a directory: ${requested}`,
                    })
                  : ok({ realPath: real });
              },
            }),
          ),
        ),
      ),
      updateHost:
        manifest.permissions?.updateHost === true && options.updateHost !== undefined
          ? options.updateHost
          : undeclaredUpdateHost(manifest.id, options.updateHost?.release ?? '5.0.0'),
      hostFacts:
        manifest.permissions?.hostFacts === true && options.hostFacts !== undefined
          ? options.hostFacts
          : undeclaredHostFacts(manifest.id, options.hostFacts ?? NO_HOST_FACTS),
      processes: processesPortFor(
        manifest.id,
        manifest.permissions?.processes,
        testFolderSpellings,
        options.processes ?? NO_PROCESS_TABLE,
      ),
      timings: options.timings ?? DEFAULT_DAEMON_TIMINGS,
      // the real order: declared, named by its own config (as the test world holds it), then the Vault stand-in;
      // `send` places the value through this plugin's own fetch guard and `options.fetch`, as the real host does
      secrets: ownSecretsPort(
        manifest.permissions?.secrets ?? [],
        () => ownedReferences(manifest),
        () => (options.vault === undefined ? undefined : { resolve: async name => options.vault?.[name] }),
        {
          hosts: exactNetworkHosts(declaredNetwork),
          mayReach,
          transport: outboundSecretTransport(fetchPort, clock),
          log: logFor(manifest.id),
        },
      ),
      signer: signerFor(manifest.id, identitySigner),
      act: testActRunner({
        holds: () => holds,
        actor: () => actorScope.getStore()?.actor ?? 'ferret',
        minted: world.minted,
        record: entry => acts.push(entry),
      }),
      // A fresh key per call: the test registry mints `opaque-N`, whatever the prefix.
      ids: { mint: () => world.minted.mint({}) },
      redaction,
      snapshot: {
        current: () => {
          if (!usesBound.done) throw new Error('the post-build snapshot is not frozen during build');
          return snapshot;
        },
      },
      lifecycle: {
        onStop: fn => {
          stopHandlers.push(fn);
        },
        stopping: () => stopController.signal.aborted,
        signal: stopController.signal,
      },
      contract: {
        hash: surface => {
          if (surface === 'member' && (manifest.actions?.memberRoutes ?? []).length === 0)
            throw new TypeError(`${manifest.id} declares no member routes, so it has no member-surface hash`);
          return options.contractHash?.(manifest.id, surface) ?? 'unhashed';
        },
      },
    };
  };

  const lookup = (record: Readonly<Record<string, unknown>>, field: string, token: PortToken<unknown>): unknown =>
    record[token.name] ?? record[field];

  for (const impl of options.plugins) {
    const manifest = impl.manifest as Manifest;
    if (impl.skeleton === true || impl.build === undefined) {
      built.push({ impl, manifest, half: undefined });
      continue;
    }
    const kernelOnly = [...Object.values(manifest.needs ?? {}), ...Object.values(manifest.uses ?? {})].find(token =>
      KERNEL_ONLY_PORTS.includes(token.name),
    );
    if (kernelOnly !== undefined)
      throw new Error(`testHost: ${manifest.id} asks for ${kernelOnly.name}, which only the kernel may hold`);
    const needs: Record<string, unknown> = {};
    const needer = neederOf(manifest, () => ownedReferences(manifest, 'credential-records'));
    for (const [field, token] of Object.entries(manifest.needs ?? {})) {
      const fake = lookup(options.fakes ?? {}, field, token);
      const value = boundFor(
        token,
        fake ?? providedBy.get(token.name),
        needer,
        fake === undefined ? 'provided' : 'fake',
      );
      if (value === undefined) throw new Error(`testHost: ${manifest.id} needs ${field} (${token.name}); pass a fake`);
      needs[field] = value;
    }
    const uses: Record<string, { current(): unknown }> = {};
    for (const [field, token] of Object.entries(manifest.uses ?? {}))
      uses[field] = {
        current: () => {
          if (!usesBound.done) throw new Error(`${manifest.id}: uses.${field}.current() during build`);
          const supplied = lookup(options.uses ?? {}, field, token);
          return boundFor(
            token,
            supplied ?? providedBy.get(token.name),
            needer,
            supplied === undefined ? 'provided' : 'uses',
          );
        },
      };
    const ctx = {
      manifest,
      needs,
      uses,
      kernel: kernelFor(manifest),
      hooks: hooksFor(manifest),
    } as DaemonContext<Manifest>;
    const half = impl.build(ctx as never) as Record<string, any>;
    bootContexts.set(manifest.id, ctx);
    for (const [field, token] of Object.entries(manifest.provides ?? {}))
      providedBy.set(token.name, half.provides?.[field]);
    built.push({ impl, manifest, half });
  }
  usesBound.done = true;
  for (const { manifest, half } of built) {
    const ctx = bootContexts.get(manifest.id);
    if (ctx !== undefined && half?.beforeListen !== undefined)
      await beforeListen(() => half.beforeListen(ctx), manifest.id, clock, logFor(manifest.id));
  }
  const snapshot: PostBuildSnapshot = Object.freeze({
    instructions: [],
    words: built.flatMap(b => (b.manifest.words ?? []).map(word => ({ ...word, plugin: b.manifest.id as never }))),
    nav: built.flatMap(b =>
      (b.manifest.ui?.screens ?? []).flatMap(s =>
        s.nav === undefined
          ? []
          : [
              {
                plugin: b.manifest.id as never,
                screen: s.id,
                label: s.nav.label,
                order: s.nav.order,
                ...(s.nav.icon === undefined ? {} : { icon: s.nav.icon }),
              },
            ],
      ),
    ),
    doctor: built.flatMap(b => (b.manifest.doctor ?? []).map(id => ({ plugin: b.manifest.id as never, id }))),
    onboarding: built.flatMap(b => (b.manifest.onboarding ?? []).map(o => ({ plugin: b.manifest.id as never, ...o }))),
  });

  // ── tables ──
  interface Mounted extends RouteDescriptor {
    readonly plugin: Built;
    readonly key: string;
  }
  const routeTable = new RouteTable<Mounted>(
    built.flatMap(b => (b.manifest.actions?.routes ?? []).map(r => ({ ...r, plugin: b }))),
  );
  const socketTable = new RouteTable<Mounted>(
    built.flatMap(b => (b.manifest.actions?.sockets ?? []).map(r => ({ ...r, plugin: b }))),
  );
  const memberTable = new RouteTable(
    built.flatMap(b => (b.manifest.actions?.memberRoutes ?? []).map(r => ({ ...r, plugin: b }))),
  );
  const tools = new Map<string, { decl: ToolDecl; plugin: Built }>();
  for (const b of built)
    for (const decl of b.manifest.actions?.agentTools ?? []) tools.set(decl.name, { decl, plugin: b });

  const unavailable = (b: Built): ApiResponse =>
    errorResponse(
      KERNEL_REFUSALS.pluginUnavailable.status,
      skeletonSentence(b.manifest.title),
      KERNEL_REFUSALS.pluginUnavailable.code,
    );

  const makeRequest = (method: string, path: string, init: RequestInit2): ApiRequest => {
    const caller = init.as ?? owner();
    const query = queryFrom(
      Object.entries(init.query ?? {}).flatMap(([k, v]) =>
        typeof v === 'string' ? [[k, v] as const] : (v as readonly string[]).map(x => [k, x] as const),
      ),
    );
    const body = init.body === undefined ? '' : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    const principal = testPrincipal(caller, instantFromEpochMs(clock.nowMs() + hours(8)));
    const request: ApiRequest = {
      method: method.toUpperCase(),
      path,
      query,
      headers: headersFrom({
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      }),
      arrival: testArrival(caller),
      ...(principal === undefined ? {} : { principal }),
      text: async limit => {
        if (limit !== undefined && body.length > limit)
          throw new ApiError(413, 'The request body is too large.', 'too_large');
        return body;
      },
    };
    callers.set(request, caller);
    return request;
  };

  const runHandler = async (
    handler: () => Promise<ApiResponse>,
    guard: RouteDescriptor['guard'],
    noStore: boolean | undefined,
  ): Promise<ApiResponse> => {
    const stamp = guard === 'secrets' ? outputGuard.stamp() : undefined;
    let response: ApiResponse;
    try {
      response = await handler();
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      response =
        error instanceof ApiError
          ? errorResponse(error.status, error.message, error.code, error.extra)
          : errorResponse(500, 'the daemon failed to handle this request', 'internal_error');
    }
    if (noStore === true)
      response = { ...response, headers: new Map([...response.headers, ['cache-control', 'no-store']]) };
    if (stamp === undefined) return response;
    const built = response;
    const late = () => {
      let showable = false;
      try {
        showable = outputGuard.stillShowable(stamp);
      } catch {
        showable = false;
      }
      return showable ? { ...built, late: undefined } : errorResponse(409, WITHHELD_SENTENCE, 'withheld');
    };
    return { ...built, late: late as never };
  };

  const host: TestHost = {
    identity,
    clock,
    minted: world.minted,
    acts,
    published,
    configChanges,
    logs,
    async request(method, path, init = {}) {
      const request = makeRequest(method, path, init);
      const found = routeTable.lookup(request.method, path);
      if (found.kind === 'not-found') {
        const member = memberTable.lookup(request.method, path);
        if (member.kind === 'matched') {
          const decision = admission.admitMember({
            table: 'member',
            descriptor: member.route,
            request,
            params: member.params,
          });
          if (decision.outcome === 'refused') return toTestResponse(decision.response);
          const b = member.route.plugin;
          if (b.half === undefined) return toTestResponse(unavailable(b));
          const handler = b.half.memberRoutes?.[member.route.key] as MemberRouteHandler | undefined;
          return toTestResponse(
            await runHandler(
              () => (handler as MemberRouteHandler)({ request, params: member.params, ...decision.standing } as never),
              member.route.guard,
              true,
            ),
          );
        }
        return toTestResponse(errorResponse(404, `There is no ${request.method} ${path}.`, 'not_found'));
      }
      if (found.kind === 'method-not-allowed')
        return toTestResponse({
          ...errorResponse(405, `${path} does not answer ${request.method}.`, 'method_not_allowed'),
          headers: new Map([['allow', found.allowed.join(', ')]]),
        });
      const route = found.route;
      let decision: ReturnType<Admission['admit']>;
      try {
        decision = admission.admit({ table: 'route', descriptor: route, request, params: found.params });
      } catch {
        if (route.minimum !== 'none' || route.wardenRemedy !== undefined)
          return toTestResponse(errorResponse(503, 'Admission is unavailable.', 'admission_unavailable'));
        decision = { outcome: 'admitted', standing: {} as never, actor: 'ferret' };
      }
      if (decision.outcome === 'refused') return toTestResponse(decision.response);
      const b = route.plugin;
      if (b.half === undefined) return toTestResponse(unavailable(b));
      const handler = b.half.routes?.[route.key] as RouteHandler | undefined;
      if (handler === undefined)
        return toTestResponse(errorResponse(500, `no handler for ${route.key}`, 'internal_error'));
      const call = { request, params: found.params, ...decision.standing } as CallContext;
      const caller = callers.get(request) ?? owner();
      return toTestResponse(
        await actorScope.run({ actor: actorOf(caller), standing: decision.standing }, () =>
          runHandler(() => handler(call), route.guard, route.noStore),
        ),
      );
    },
    async doctor(plugin, check) {
      const entry = built.find(b => b.manifest.id === plugin);
      if (entry === undefined) throw new Error(`no plugin ${plugin} under test`);
      if (!(entry.manifest.doctor ?? []).includes(check))
        throw new Error(`${plugin} declares no doctor check ${check}`);
      const run = (entry.half?.doctor as Readonly<Record<string, DoctorRun | undefined>> | undefined)?.[check];
      if (run === undefined) throw new Error(`${plugin}: the doctor check ${check} has no implementation`);
      return await run();
    },
    async tool(name, input, init = {}) {
      const entry = tools.get(name);
      if (entry === undefined) throw new Error(`no agent tool ${name}`);
      const caller = init.as ?? { kind: 'ferret', id: 'test-ferret' };
      const request = makeRequest('POST', `/v1/tools/${name}`, { body: input, as: caller });
      const descriptor = { ...entry.decl, method: 'POST', path: `/v1/tools/${name}` };
      const decision = admission.admit({ table: 'tool', descriptor, request, params: new Map() });
      if (decision.outcome === 'refused') return { text: finalised(decision.response).body, isError: true };
      if (entry.plugin.half === undefined)
        return { text: skeletonSentence(entry.plugin.manifest.title), isError: true };
      const handler = entry.plugin.half.tools?.[name] as ToolHandler;
      const call = { request, params: new Map(), ...decision.standing } as CallContext;
      return actorScope.run({ actor: actorOf(caller), standing: decision.standing }, () => handler(call, input));
    },
    async socket(path, init = {}) {
      const request = makeRequest(init.method ?? 'GET', path, {
        as: init.as ?? owner(),
        ...(init.query === undefined ? {} : { query: init.query }),
      });
      const found = socketTable.lookup(request.method, path);
      const result: {
        response?: TestResponse;
        frames: (string | Uint8Array)[];
        closed: { code: number; reason: string } | undefined;
        handler?: SocketHandler;
      } = { frames: [], closed: undefined };
      if (found.kind !== 'matched') {
        result.response = toTestResponse(errorResponse(404, `There is no socket at ${path}.`, 'not_found'));
        return result;
      }
      const decision = admission.admit({ table: 'socket', descriptor: found.route, request, params: found.params });
      if (decision.outcome === 'refused') {
        result.response = toTestResponse(decision.response);
        return result;
      }
      const b = found.route.plugin;
      if (b.half === undefined) {
        result.response = toTestResponse(unavailable(b));
        return result;
      }
      const accept = b.half.sockets?.[found.route.key] as SocketAccept;
      let attach: Awaited<ReturnType<SocketAccept>>;
      try {
        attach = await accept({ request, params: found.params, ...decision.standing } as CallContext);
      } catch (error) {
        // as the real dispatcher's upgrade: a refusal the accept named keeps its status and body, anything else a 500
        result.response = toTestResponse(failureResponse(error));
        return result;
      }
      const downstream: SocketDownstream = {
        send(frame, permit) {
          let allowed = true;
          try {
            allowed = permit === undefined ? true : permit();
          } catch {
            allowed = false;
          }
          if (!allowed) return undefined;
          result.frames.push(frame);
          return typeof frame === 'string' ? frame.length : frame.byteLength;
        },
        close(code, reason) {
          result.closed = { code, reason };
        },
        bufferedBytes: () => 0,
      };
      const handler = await attach(downstream);
      result.handler = handler;
      const recheck = (): void => {
        if (result.closed !== undefined || admission.readmit(request, found.route)) return;
        openStreams.delete(recheck);
        downstream.close(SOCKET_CLOSES.unauthorized.code, SOCKET_CLOSES.unauthorized.reason);
        handler.close(SOCKET_CLOSES.unauthorized);
      };
      openStreams.add(recheck);
      await handler.open();
      return result;
    },
    emit(event, payload) {
      event.schema.parse(payload);
      deliver(event.name, payload);
    },
    async settle() {
      for (let round = 0; round < 100 && pending.size > 0; round++) await Promise.all([...pending]);
      await Promise.resolve();
    },
    crashAfterNextWrite() {
      for (const state of world.states.values()) state.armCrash();
    },
    async restart() {
      await host.stop().catch(() => undefined);
      return start(world);
    },
    provided<Api>(token: PortToken<Api>, as?: string | Needer): Api {
      if (!providedBy.has(token.name)) throw new Error(`nothing loaded provides ${token.name}`);
      let needer: Needer = KERNEL_NEEDER;
      if (typeof as === 'string') {
        const manifest = options.plugins.find(plugin => plugin.manifest.id === as)?.manifest;
        if (manifest === undefined) throw new Error(`provided: no loaded plugin ${as}`);
        needer = neederOf(manifest as Manifest, () => ownedReferences(manifest as Manifest, 'credential-records'));
      } else if (as !== undefined) needer = as;
      return boundFor(token as PortToken<unknown>, providedBy.get(token.name), needer) as Api;
    },
    state(pluginId) {
      const state = world.states.get(pluginId);
      if (state === undefined) throw new Error(`no state folder for ${pluginId}`);
      return state;
    },
    setConfig(key, value) {
      world.config.set(key, value);
      for (const listener of configListeners.get(key) ?? []) listener();
      restamp(key);
    },
    async runJob(id) {
      const run = jobs.get(id);
      if (run === undefined) throw new Error(`no job ${id}`);
      await run(stopController.signal);
    },
    jobIds: () => [...jobs.keys()],
    hold(target, code = 'held') {
      world.holdsMap.set(targetKey(target), code);
    },
    release(target) {
      world.holdsMap.delete(targetKey(target));
    },
    holdBegins() {
      world.generation++;
    },
    putRoot(name, relative, text) {
      world.roots.set(rootKey(name, relative), text);
    },
    rootText(name, relative) {
      return world.roots.get(rootKey(name, relative));
    },
    putRootLink(name, relative) {
      testLinks.set(rootKey(name, relative), '(planted)');
    },
    putRootHardLink(name, relative, text) {
      world.roots.set(rootKey(name, relative), text);
      testHardLinks.add(rootKey(name, relative));
    },
    async stop() {
      if (stopController.signal.aborted) return;
      stopController.abort();
      for (const fn of [...stopHandlers].reverse()) await fn();
    },
  };
  return host;
}
