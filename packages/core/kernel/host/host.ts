import type { Instant } from '@ferretry/std';
import { milliseconds } from '@ferretry/std';
import type { InputHolds, OutputGuard, Admission, Redaction, WorkFolders } from '../contract/bound.ts';
import { AdmissionPort, InputHoldsPort, OutputGuardPort, RedactionPort, WorkFoldersPort } from '../contract/bound.ts';
import type { ConfigDef, PortToken } from '../contract/define.ts';
import type { ApiRequest, ApiResponse } from '../contract/http.ts';
import { ApiError } from '../contract/http.ts';
import { CORE_IDS, type PluginId } from '../contract/ids.ts';
import { Carriers, type DoctorCheck, DoctorChecks, PluginsChanged } from '../contract/kernel.ts';
import type {
  Clock,
  ConfigPort,
  FetchPort,
  KernelPorts,
  Log,
  SpawnPort,
  StateDamage,
  StatePort,
  WorkersPort,
} from '../contract/ports.ts';
import { KERNEL_REFUSALS } from '../contract/refusals.ts';
import type { SocketUpgradeDecision } from '../contract/socket.ts';
import type { PostBuildSnapshot } from '../contract/snapshot.ts';
import type { DaemonContext, DaemonHalf, DaemonImplementation, ToolHandler, ToolResult } from '../manifest/implement.ts';
import type { Manifest, ToolDecl } from '../manifest/types.ts';
import kernelManifest from '../plugin.ts';
import { createActRunner, MintedIdRegistry } from './act.ts';
import type { HostFs } from './adapters/node-fs.ts';
import { DEFAULT_ACTOR, runInCall } from './call-scope.ts';
import { loadDataPlugins } from './data-plugins.ts';
import {
  admitCall,
  Dispatcher,
  type MountedMemberRoute,
  type MountedRoute,
  type MountedSocket,
  notServing,
  type Owner,
  type Serving,
} from './dispatch.ts';
import { EventBus } from './events.ts';
import { dependentsOf, type GraphRefusal, planGraph } from './graph.ts';
import { type Deadline, HookEngine } from './hooks.ts';
import { type InventoryEntry, kernelRoutes } from './kernel-half.ts';
import { JobRunner } from './jobs.ts';
import { PluginLifecycle } from './lifecycle.ts';
import { type LogSink, scopedLog } from './log.ts';
import { restrictFetch, restrictSpawn } from './permissions.ts';
import { openHome } from './home.ts';
import { rootsPortFor } from './roots.ts';
import { buildSnapshot, type DataPluginManifest } from './snapshot.ts';
import { type DaemonIdentity, loadIdentity } from './identity.ts';

/** What the store opens for one plugin (the store slice's `openPluginState`). */
export interface PluginStateHandle {
  readonly port: StatePort;
  /** Checks every declared file's format (§9.3); answers the damage found. */
  open(): Promise<readonly StateDamage[]>;
  close(): Promise<void>;
}

/** Everything IO the host is given. `fyd` wires the real ones; the test host wires in-memory ones. */
/** The config service the host drives (`host/config`'s `createConfigFiles`). */
export interface HostConfig {
  port(plugin: string): ConfigPort;
  reload(): Promise<void>;
  startWatching?(): () => void;
}

export interface HostAdapters {
  readonly clock: Clock;
  readonly logSink: LogSink;
  readonly fs: HostFs;
  readonly random: () => string;
  readonly state: (manifest: Manifest) => PluginStateHandle;
  /** The config service over every started plugin's declared files (§7.2); reloaded once before build. */
  readonly config: (declarations: readonly { readonly plugin: string; readonly def: ConfigDef }[]) => HostConfig;
  /** Unrestricted; the host narrows each to the manifest's `permissions`. */
  readonly spawn: SpawnPort;
  readonly fetch: FetchPort;
  readonly workers: WorkersPort;
}

/** What the session layer is handed (the session slice's factory adapts to this). */
export interface SessionLayerKernel {
  dispatch(request: ApiRequest): Promise<ApiResponse>;
  upgrade(request: ApiRequest): Promise<SocketUpgradeDecision>;
  readonly identity: DaemonIdentity;
  readonly clock: Clock;
  readonly log: Log;
  readonly hooks: HookEngine;
}

export interface Listening {
  readonly addresses: readonly string[];
  stop(): Promise<void>;
}

export interface HostOptions {
  readonly home: string;
  readonly version: string;
  readonly implementations: readonly DaemonImplementation[];
  readonly adapters: HostAdapters;
  /** `config/plugins.yaml`: on/off per plugin. Core is always on. Default: on. */
  readonly enabled?: (id: string) => boolean;
  /** The generated effective contract hash per package (§9.6). */
  readonly contractHash?: (id: string) => string;
  readonly instructionText?: (plugin: string, path: string) => string | undefined;
  /** The local listener (Unix socket + loopback port); started at step 7. */
  readonly listen?: (host: RunningHost) => Promise<Listening>;
  /** The session layer, opened for every carrier at step 7. */
  readonly sessionLayer?: (kernel: SessionLayerKernel) => import('../contract/session.ts').SessionLayer & {
    close?(): void;
  };
  readonly pid?: number;
  /** `<home>-worktrees` unless given. */
  readonly worktrees?: string;
}

export type PluginStatus = 'serving' | 'skeleton' | 'failed' | 'damaged' | 'off' | 'refused';

export interface PluginRecord {
  readonly manifest: Manifest;
  status: PluginStatus;
  damage: readonly StateDamage[];
  half?: DaemonHalf<Manifest>;
  failure?: string;
  readonly lifecycle: PluginLifecycle;
  state?: PluginStateHandle;
}

export interface DoctorLine {
  readonly plugin: string;
  readonly state: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

export interface RunningHost {
  readonly dispatcher: Dispatcher;
  readonly identity: DaemonIdentity;
  readonly snapshot: PostBuildSnapshot;
  readonly trace: readonly string[];
  readonly plugins: ReadonlyMap<string, PluginRecord>;
  readonly hooks: HookEngine;
  readonly events: EventBus;
  readonly jobs: JobRunner;
  readonly ids: MintedIdRegistry;
  readonly sessionLayer?: import('../contract/session.ts').SessionLayer;
  dispatch(request: ApiRequest): Promise<ApiResponse>;
  callTool(plugin: string, name: string, input: unknown, request: ApiRequest): Promise<ToolResult>;
  doctor(): Promise<readonly DoctorLine[]>;
  stop(): Promise<void>;
}

export type BootOutcome =
  | { readonly kind: 'running'; readonly host: RunningHost }
  | { readonly kind: 'refused'; readonly sentence: string; readonly trace: readonly string[] };

const isCore = (id: string): boolean => (CORE_IDS as readonly string[]).includes(id);

/** A need on a skeleton provider: every call throws `503 plugin_unavailable` with the skeleton sentence (D10). */
function unavailablePort(title: string): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'then'
          ? undefined
          : () => {
              throw new ApiError(
                KERNEL_REFUSALS.pluginUnavailable.status,
                `${title} is not built yet in this version of Ferretry.`,
                KERNEL_REFUSALS.pluginUnavailable.code,
              );
            },
    },
  );
}

/** The manifest key under which a plugin provides a token (`provides: { board: BoardPort }` → `board`). */
function provideKey(manifest: Manifest, token: PortToken<unknown>): string | undefined {
  return Object.entries(manifest.provides ?? {}).find(([, candidate]) => candidate.name === token.name)?.[0];
}

function deadlineFrom(clock: Clock): Deadline {
  return ms => {
    let cancel = (): void => {};
    const promise = new Promise<'timeout'>(resolve => {
      cancel = clock.after(milliseconds(ms), () => resolve('timeout'));
    });
    return { promise, cancel: () => cancel() };
  };
}

/**
 * Boots the daemon in the order of §7.6 and records each step in `trace` (the boot-trace test asserts it):
 * check → home → identity → state:<id> → build:<id> → bind → snapshot → mount → listen → jobs. Nothing is served and
 * no job runs before `bind`; a core piece failing to build stops the boot.
 */
export async function bootHost(options: HostOptions): Promise<BootOutcome> {
  const { adapters, home } = options;
  const trace: string[] = [];
  const log = scopedLog(adapters.logSink, 'kernel');
  const clock = adapters.clock;
  const deadline = deadlineFrom(clock);

  // 1. Check the enabled graph.
  trace.push('check');
  const implementations = new Map<string, DaemonImplementation>();
  for (const implementation of options.implementations)
    if (implementation.manifest.id !== 'kernel') implementations.set(implementation.manifest.id, implementation);
  const manifests: Manifest[] = [kernelManifest, ...[...implementations.values()].map(impl => impl.manifest)];
  const enabled = (id: string): boolean => isCore(id) || (options.enabled?.(id) ?? true);
  const enabledManifests = manifests.filter(manifest => enabled(manifest.id));
  const planned = HookEngine.plan(enabledManifests, log, deadline);
  const hookRefused = new Set(planned.refusals.flatMap(refusal => refusal.plugins));
  const hookEdges = (manifest: Manifest): readonly string[] =>
    (manifest.hooks?.takes ?? []).flatMap(take => {
      const offerer = planned.engine.offererOf(take.hook);
      return offerer === undefined ? [] : [offerer];
    });
  const graph = planGraph(
    manifests.filter(manifest => !hookRefused.has(manifest.id) || isCore(manifest.id)),
    enabled,
    hookEdges,
  );
  const refusals: GraphRefusal[] = [
    ...graph.refused,
    ...planned.refusals.flatMap(refusal =>
      refusal.plugins.filter(plugin => !isCore(plugin)).map(plugin => ({ plugin, reason: 'hook' as const, sentence: refusal.sentence })),
    ),
  ];
  const coreRefusal = [...refusals, ...planned.refusals.map(r => ({ plugin: r.plugins[0] ?? '', sentence: r.sentence }))].find(
    refusal => isCore(refusal.plugin),
  );
  if (coreRefusal !== undefined) return { kind: 'refused', sentence: coreRefusal.sentence, trace };
  // The engine is re-planned over the started set, so a refused plugin's takes do not exist.
  const order = graph.order;
  const { engine: hooks } = HookEngine.plan(order, log, deadline);

  // 2. Home and fence.
  trace.push('home');
  const opened = await openHome(adapters.fs, home, `fyd ${options.version}`, clock.now() as Instant);
  if (opened.kind === 'refused') return { kind: 'refused', sentence: opened.decision.sentence, trace };
  trace.push('identity');
  const identityOutcome = await loadIdentity(adapters.fs, home);
  if (identityOutcome.kind === 'damaged') return { kind: 'refused', sentence: identityOutcome.sentence, trace };
  const identity = identityOutcome.identity;
  const data = await loadDataPlugins(adapters.fs, home, new Set(manifests.map(manifest => manifest.id)));

  const records = new Map<string, PluginRecord>();
  for (const manifest of manifests) {
    const refusal = refusals.find(candidate => candidate.plugin === manifest.id);
    records.set(manifest.id, {
      manifest,
      status: refusal === undefined ? 'skeleton' : refusal.reason === 'off' ? 'off' : 'refused',
      damage: [],
      lifecycle: new PluginLifecycle(),
      ...(refusal === undefined ? {} : { failure: refusal.sentence }),
    });
  }

  // 3. Open state: every declared file's format.
  for (const manifest of order) {
    const record = records.get(manifest.id) as PluginRecord;
    if (manifest.id === 'kernel') continue;
    trace.push(`state:${manifest.id}`);
    const state = adapters.state(manifest);
    record.state = state;
    record.damage = await state.open();
  }

  trace.push('config');
  const config = adapters.config(
    order.flatMap(manifest => (manifest.data?.config ?? []).map(def => ({ plugin: manifest.id, def }))),
  );
  await config.reload();
  const stopWatching = config.startWatching?.();

  // Shared kernel machinery.
  const events = new EventBus(log);
  const jobs = new JobRunner(clock, log);
  const ids = new MintedIdRegistry(adapters.random);
  const bound: {
    admission?: Admission;
    outputGuard?: OutputGuard;
    holds?: InputHolds;
    redaction?: Redaction;
    workFolders?: WorkFolders;
  } = {};
  const act = createActRunner(() => bound.holds, ids);
  const redaction: Redaction = {
    read: async fn => {
      if (bound.redaction === undefined) throw new ApiError(503, 'Masking is unavailable, so nothing is shown.', 'redaction_unavailable');
      return await bound.redaction.read(fn);
    },
  };
  let frozen: PostBuildSnapshot | undefined;
  let phase: 'building' | 'bound' | 'started' = 'building';
  const providerHalf = (token: PortToken<unknown>): { record: PluginRecord; key: string } | undefined => {
    const provider = graph.providers.get(token.name);
    const record = provider === undefined ? undefined : records.get(provider);
    const key = record === undefined ? undefined : provideKey(record.manifest, token);
    return record === undefined || key === undefined ? undefined : { record, key };
  };

  const portsFor = (manifest: Manifest, lifecycle: PluginLifecycle): KernelPorts => ({
    clock,
    log: scopedLog(adapters.logSink, manifest.id),
    state: records.get(manifest.id)?.state?.port as StatePort,
    config: config.port(manifest.id),
    roots: rootsPortFor(
      adapters.fs,
      { home, plugin: manifest.id, worktrees: options.worktrees ?? `${home}-worktrees` },
      manifest.permissions?.roots ?? [],
      () => bound.workFolders,
    ),
    events: events.portFor(manifest.id, manifest.data?.publishes ?? []),
    jobs: jobs.portFor(manifest.id),
    workers: adapters.workers,
    spawn: restrictSpawn(manifest.id, manifest.permissions?.spawn ?? [], adapters.spawn),
    fetch: restrictFetch(manifest.id, manifest.permissions?.network ?? [], adapters.fetch),
    act,
    redaction,
    snapshot: {
      current: () => {
        if (frozen === undefined) throw new TypeError('the post-build snapshot is read after build, not during it');
        return frozen;
      },
    },
    lifecycle,
  });

  // 4. Build in start order.
  const failed = (id: string, why: string): void => {
    const record = records.get(id) as PluginRecord;
    record.status = 'failed';
    record.failure = why;
    hooks.markFailed(id);
    events.unsubscribeAll(id);
    for (const dependent of dependentsOf(id, order, graph.providers)) {
      const other = records.get(dependent) as PluginRecord;
      if (other.status === 'serving' || other.status === 'skeleton') {
        other.status = 'failed';
        other.failure = `${other.manifest.title} needs ${record.manifest.title}, which failed.`;
        hooks.markFailed(dependent);
        events.unsubscribeAll(dependent);
      }
    }
  };
  for (const manifest of order) {
    if (manifest.id === 'kernel') {
      records.get('kernel')!.status = 'serving';
      continue;
    }
    const record = records.get(manifest.id) as PluginRecord;
    if (record.status === 'failed') continue;
    trace.push(`build:${manifest.id}`);
    const implementation = implementations.get(manifest.id);
    if (implementation === undefined || implementation.skeleton === true || implementation.build === undefined) {
      record.status = 'skeleton';
      hooks.attach(manifest.id, undefined, 'skeleton');
      continue;
    }
    const needs: Record<string, unknown> = {};
    let missing: string | undefined;
    for (const [key, token] of Object.entries(manifest.needs ?? {})) {
      const provider = providerHalf(token);
      if (provider === undefined || provider.record.status === 'failed' || provider.record.status === 'refused') {
        missing = provider?.record.manifest.title ?? token.name;
        break;
      }
      needs[key] =
        provider.record.status === 'skeleton'
          ? unavailablePort(provider.record.manifest.title)
          : (provider.record.half?.provides as Record<string, unknown> | undefined)?.[provider.key];
    }
    if (missing !== undefined) {
      failed(manifest.id, `${manifest.title} needs ${missing}, which is not running.`);
      continue;
    }
    const uses: Record<string, { current(): unknown }> = {};
    for (const [key, token] of Object.entries(manifest.uses ?? {}))
      uses[key] = {
        current: () => {
          if (phase === 'building') throw new TypeError(`${manifest.id}: an optional port is unbound during build`);
          const provider = providerHalf(token);
          if (provider === undefined || provider.record.status !== 'serving') return undefined;
          return (provider.record.half?.provides as Record<string, unknown> | undefined)?.[provider.key];
        },
      };
    const ctx = {
      manifest,
      needs,
      uses,
      kernel: portsFor(manifest, record.lifecycle),
      hooks: hooks.invokerFor(manifest.id),
    } as unknown as DaemonContext<Manifest>;
    try {
      const built = implementation.build(ctx);
      if (built === null || typeof built !== 'object' || typeof (built as { then?: unknown }).then === 'function')
        throw new TypeError('build must return the half synchronously');
      record.half = built;
      record.status = record.damage.length > 0 ? 'damaged' : 'serving';
      hooks.attach(manifest.id, built.hooks as Readonly<Record<string, unknown>> | undefined, 'live');
      for (const event of manifest.data?.subscribes ?? []) {
        const fn = (built.subscribers as Record<string, (payload: unknown) => void> | undefined)?.[event.name];
        if (fn !== undefined) events.subscribe(manifest.id, event, fn);
      }
    } catch (error) {
      const why = `${manifest.title} failed to build: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`;
      log.error('a plugin failed to build', { plugin: manifest.id });
      if (isCore(manifest.id)) return { kind: 'refused', sentence: why, trace };
      failed(manifest.id, why);
    }
  }

  // 5. Bind the kernel-bound ports and optional handles; freeze the snapshot.
  trace.push('bind');
  const boundValue = <T>(token: PortToken<T>): T | undefined => {
    const provider = providerHalf(token as PortToken<unknown>);
    if (provider === undefined || !isCore(provider.record.manifest.id) || provider.record.status !== 'serving')
      return undefined;
    return (provider.record.half?.provides as Record<string, unknown> | undefined)?.[provider.key] as T | undefined;
  };
  const admission = boundValue(AdmissionPort);
  const outputGuard = boundValue(OutputGuardPort);
  const holds = boundValue(InputHoldsPort);
  const redactor = boundValue(RedactionPort);
  const workFolders = boundValue(WorkFoldersPort);
  if (admission !== undefined) bound.admission = admission;
  if (outputGuard !== undefined) bound.outputGuard = outputGuard;
  if (holds !== undefined) bound.holds = holds;
  if (redactor !== undefined) bound.redaction = redactor;
  if (workFolders !== undefined) bound.workFolders = workFolders;
  phase = 'bound';
  trace.push('snapshot');
  const started = order.filter(manifest => {
    const status = records.get(manifest.id)?.status;
    return status === 'serving' || status === 'skeleton' || status === 'damaged';
  });
  frozen = buildSnapshot(started, data.accepted as readonly DataPluginManifest[], options.instructionText ?? (() => undefined));

  // 6. Mount behind admission, by specificity.
  trace.push('mount');
  const owners = new Map<string, Owner>();
  const ownerOf = (manifest: Manifest): Owner => {
    const existing = owners.get(manifest.id);
    if (existing !== undefined) return existing;
    const owner: Owner = {
      plugin: manifest.id as PluginId,
      title: manifest.title,
      serving: (): Serving => {
        const record = records.get(manifest.id) as PluginRecord;
        switch (record.status) {
          case 'serving':
            return { kind: 'serving' };
          case 'damaged':
            return { kind: 'damaged', files: record.damage.map(damage => damage.file) };
          case 'skeleton':
            return { kind: 'skeleton' };
          default:
            return { kind: 'failed' };
        }
      },
    };
    owners.set(manifest.id, owner);
    return owner;
  };
  const startedAtMs = clock.nowMs();
  const inventory = (): readonly InventoryEntry[] =>
    manifests.map(manifest => {
      const status = records.get(manifest.id)?.status;
      return {
        id: manifest.id,
        on: status === 'serving' || status === 'skeleton' || status === 'damaged',
        contract: options.contractHash?.(manifest.id) ?? 'unhashed',
      };
    });
  const kernelHandlers = kernelRoutes({
    version: options.version,
    inventory,
    snapshot: () => frozen as PostBuildSnapshot,
    liveness: () => ({
      status: phase === 'started' ? 'ok' : 'starting',
      uptimeSeconds: Math.max(0, Math.round((clock.nowMs() - startedAtMs) / 1000)),
      pid: options.pid ?? 0,
    }),
  });
  const routes: MountedRoute[] = [];
  const sockets: MountedSocket[] = [];
  const memberRoutes: MountedMemberRoute[] = [];
  const tools = new Map<string, { readonly decl: ToolDecl; readonly owner: Owner; readonly handle?: ToolHandler }>();
  for (const manifest of started) {
    const owner = ownerOf(manifest);
    const half = records.get(manifest.id)?.half;
    const handlers =
      manifest.id === 'kernel'
        ? (kernelHandlers as Readonly<Record<string, unknown>>)
        : (half?.routes as Readonly<Record<string, unknown>> | undefined);
    for (const decl of manifest.actions?.routes ?? []) {
      const handle = handlers?.[decl.key] as MountedRoute['handle'];
      routes.push({ ...decl, owner, ...(handle === undefined ? {} : { handle }) });
    }
    for (const decl of manifest.actions?.sockets ?? []) {
      const accept = (half?.sockets as Readonly<Record<string, unknown>> | undefined)?.[decl.key] as MountedSocket['accept'];
      sockets.push({ ...decl, owner, ...(accept === undefined ? {} : { accept }) });
    }
    for (const decl of manifest.actions?.memberRoutes ?? []) {
      const handle = (half?.memberRoutes as Readonly<Record<string, unknown>> | undefined)?.[decl.key] as MountedMemberRoute['handle'];
      memberRoutes.push({ ...decl, owner, ...(handle === undefined ? {} : { handle }) });
    }
    for (const decl of manifest.actions?.agentTools ?? []) {
      const handle = (half?.tools as Readonly<Record<string, unknown>> | undefined)?.[decl.name] as ToolHandler | undefined;
      tools.set(`${manifest.id}/${decl.name}`, { decl, owner, ...(handle === undefined ? {} : { handle }) });
    }
  }
  const bindings = {
    admission: () => bound.admission,
    outputGuard: () => bound.outputGuard,
    version: options.version,
  };
  const dispatcher = new Dispatcher(bindings, { routes, sockets, memberRoutes });

  const callTool = async (plugin: string, name: string, input: unknown, request: ApiRequest): Promise<ToolResult> => {
    const entry = tools.get(`${plugin}/${name}`);
    if (entry === undefined) return { text: `There is no tool ${name}.`, isError: true };
    const descriptor = { ...entry.decl, method: 'POST', path: `/v1/tools/${plugin}/${name}` };
    const decision = admitCall(bindings, 'tool', descriptor, request, new Map());
    if (decision.outcome === 'refused') return { text: refusalText(decision.response), isError: true };
    const refusal = notServing(entry.owner);
    if (refusal !== undefined || entry.handle === undefined)
      return { text: refusalText(refusal ?? { status: 503, headers: new Map(), body: '{}' }), isError: true };
    if (entry.decl.input !== undefined && !entry.decl.input.safeParse(input).success)
      return { text: `The input for ${name} does not fit.`, isError: true };
    const handle = entry.handle;
    const call = { request, params: new Map(), ...decision.standing } as Parameters<ToolHandler>[0];
    try {
      return await runInCall({ actor: DEFAULT_ACTOR }, () => handle(call, input));
    } catch (error) {
      return { text: error instanceof ApiError ? error.message : 'The tool failed.', isError: true };
    }
  };

  const running: RunningHost = {
    dispatcher,
    identity,
    snapshot: frozen,
    trace,
    plugins: records,
    hooks,
    events,
    jobs,
    ids,
    dispatch: request => dispatcher.dispatch(request),
    callTool,
    doctor: async () => doctorLines(records, hooks, jobs, data.refused),
    stop: async () => undefined,
  };

  // 7. Listen: the local listener and every carrier.
  trace.push('listen');
  const listening: Listening[] = [];
  if (options.listen !== undefined) listening.push(await options.listen(running));
  const carriersAbort = new AbortController();
  let sessionLayer: (import('../contract/session.ts').SessionLayer & { close?(): void }) | undefined;
  if (options.sessionLayer !== undefined) {
    sessionLayer = options.sessionLayer({
      dispatch: request => dispatcher.dispatch(request),
      upgrade: request => dispatcher.upgrade(request),
      identity,
      clock,
      log: log.child('session'),
      hooks,
    });
    const kernelInvoker = hooks.invokerFor('kernel');
    for (const [key, carrier] of kernelInvoker.providers(Carriers)) {
      trace.push(`carrier:${key}`);
      void carrier.start(sessionLayer, carriersAbort.signal).catch(() => log.warn('a carrier stopped', { carrier: key }));
    }
  }

  // 8. Start jobs in start order.
  trace.push('jobs');
  jobs.start();
  phase = 'started';
  events.publish(PluginsChanged, { generation: 1 });

  // 9. Stop in reverse.
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      trace.push('stop:listen');
      carriersAbort.abort();
      for (const listener of [...listening].reverse()) await listener.stop().catch(() => undefined);
      sessionLayer?.close?.();
      stopWatching?.();
      trace.push('stop:jobs');
      await jobs.stop();
      for (const manifest of [...order].reverse()) {
        const record = records.get(manifest.id) as PluginRecord;
        trace.push(`stop:${manifest.id}`);
        await record.lifecycle.stop(() => log.warn('an onStop handler failed', { plugin: manifest.id }));
        await record.state?.close().catch(() => undefined);
      }
    })();
    return stopping;
  };
  const host: RunningHost = { ...running, stop, ...(sessionLayer === undefined ? {} : { sessionLayer }) };
  return { kind: 'running', host };
}

function refusalText(response: ApiResponse): string {
  try {
    const body = JSON.parse(response.body) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : `Refused (${response.status}).`;
  } catch {
    return `Refused (${response.status}).`;
  }
}

async function doctorLines(
  records: ReadonlyMap<string, PluginRecord>,
  hooks: HookEngine,
  jobs: JobRunner,
  dataRefused: readonly { readonly folder: string; readonly sentence: string }[],
): Promise<readonly DoctorLine[]> {
  const lines: DoctorLine[] = [];
  for (const [id, record] of records) {
    if (record.status === 'failed' || record.status === 'refused')
      lines.push({ plugin: id, state: 'fail', detail: record.failure ?? `${record.manifest.title} is not running.` });
    if (record.status === 'damaged')
      for (const damage of record.damage) lines.push({ plugin: id, state: 'fail', detail: damage.sentence });
  }
  for (const report of jobs.reports())
    if (report.failures > 0)
      lines.push({ plugin: report.plugin, state: 'warn', detail: `The job ${report.id} failed ${report.failures} times.` });
  for (const note of hooks.notes) lines.push({ plugin: 'kernel', state: 'warn', detail: note });
  for (const refused of dataRefused) lines.push({ plugin: refused.folder, state: 'fail', detail: refused.sentence });
  const checks: readonly { readonly id: string; readonly item: DoctorCheck }[] = hooks.contributions(DoctorChecks);
  for (const check of checks) {
    try {
      const finding = await check.item.run();
      lines.push({ plugin: check.id, state: finding.state, detail: finding.detail });
    } catch {
      lines.push({ plugin: check.id, state: 'fail', detail: `The check ${check.item.title} failed to run.` });
    }
  }
  return lines;
}
