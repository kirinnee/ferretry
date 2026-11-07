import { AsyncLocalStorage } from 'node:async_hooks';
import { hours, instantFromEpochMs } from '@ferretry/std';
import type { Actor, HoldDecision, RefusalCode, TargetRef } from '../contract/act.ts';
import type {
  Admission,
  GuardStamp,
  InputHolds,
  OutputGuard,
  Redaction,
  RedactionScope,
  WorkFolders,
} from '../contract/bound.ts';
import { WITHHELD_SENTENCE } from '../contract/bound.ts';
import type {
  ConfigCollectionDef,
  ConfigFileDef,
  Contribution,
  EventDef,
  HookDecision,
  PortToken,
} from '../contract/define.ts';
import type { ApiRequest, ApiResponse } from '../contract/http.ts';
import { ApiError, errorResponse, finalised, headersFrom, queryFrom } from '../contract/http.ts';
import type {
  ChildHandle,
  ConfigPort,
  KernelPorts,
  Log,
  LogFields,
  RootHandle,
  RootName,
  SpawnOptions,
  SpawnResult,
  IdentityPort,
  WebSocketClient,
} from '../contract/ports.ts';
import { parse as parseYaml } from 'yaml';
import { KERNEL_REFUSALS, skeletonSentence } from '../contract/refusals.ts';
import { createIdentitySigner, signerFor } from '../host/session/signer.ts';
import { testIdentity } from './identity.ts';
import type { IdentitySigner } from '../contract/session.ts';
import type { CallContext, MemberRouteHandler, RouteDescriptor, RouteHandler } from '../contract/route.ts';
import type { PostBuildSnapshot } from '../contract/snapshot.ts';
import type { SocketAccept, SocketDownstream, SocketHandler } from '../contract/socket.ts';
import type { DaemonImplementation, HookInvoker, ToolHandler, ToolResult } from '../manifest/implement.ts';
import type { Manifest, ToolDecl } from '../manifest/types.ts';
import { type ActRecord, TestMintedIds, testActRunner } from './act.ts';
import { type TestCaller, owner, standInAdmission, testArrival, testPrincipal } from './admission.ts';
import { type DrivenClock, fixedClock } from './clock.ts';
import { RouteTable } from './router.ts';
import { MemoryStateFolder, SimulatedCrash } from './state.ts';

// ─── options and results ──────────────────────────────────────────────────────────────────────────────────────────

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
  /** What `kernel.identity` answers. Default: the throwaway identity's id and `test-daemon`. */
  readonly identity?: IdentityPort;
  /** Text the stand-in redaction masks (same-width `*`). */
  readonly secrets?: readonly string[];
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
  readonly logs: readonly {
    readonly level: string;
    readonly scope: string;
    readonly message: string;
    readonly fields?: LogFields;
  }[];
  request(method: string, path: string, init?: RequestInit2): Promise<TestResponse>;
  tool(name: string, input: unknown, init?: { readonly as?: TestCaller }): Promise<ToolResult>;
  socket(path: string, init?: { readonly as?: TestCaller; readonly method?: string }): Promise<OpenSocket>;
  /** Delivers an event to every loaded subscriber (a wake-up from a fake). */
  emit<Payload>(event: EventDef<string, Payload>, payload: Payload): void;
  /** Waits until every delivery and hook call started so far has finished. */
  settle(): Promise<void>;
  /** The next state write lands, then the "process" dies: every later port call throws until `restart()`. */
  crashAfterNextWrite(): void;
  /** Builds the same halves again on the same state and clock (a daemon restart after a crash). */
  restart(): Promise<TestHost>;
  provided<Api>(token: PortToken<Api>): Api;
  state(pluginId: string): MemoryStateFolder;
  setConfig(fileOrCollection: string, value: unknown): void;
  runJob(id: string): Promise<void>;
  jobIds(): readonly string[];
  /** Makes `InputHolds.decide` refuse this target (when the stand-in holds are in use). */
  hold(target: TargetRef, code?: RefusalCode): void;
  release(target: TargetRef): void;
  /** Moves the stand-in output guard's generation: a guarded body built before now is withheld. */
  holdBegins(): void;
  putRoot(name: RootName, relative: string, text: string): void;
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

const actorScope = new AsyncLocalStorage<Actor>();

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
export async function testHost(options: TestHostOptions): Promise<TestHost> {
  const throwaway = await testIdentity();
  const identity: IdentityPort = options.identity ?? Object.freeze({ daemonId: throwaway.daemonId, daemonName: 'test-daemon' });
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

  const built: Built[] = [];
  const providedBy = new Map<string, unknown>();
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
          .filter(take => take.hook.name === hookName)
          .map(take => {
            const implKey =
              take.hook.mode === 'provide' && take.key !== undefined ? `${take.hook.name}:${take.key}` : take.hook.name;
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
    return {
      observe(hook, payload) {
        own(hook.name);
        for (const taker of hookTakers(hook.name))
          if (typeof taker.impl === 'function')
            track(Promise.resolve().then(() => (taker.impl as (p: unknown) => unknown)(payload)));
      },
      async decide(hook, input): Promise<HookDecision> {
        own(hook.name);
        for (const taker of hookTakers(hook.name)) {
          if (typeof taker.impl !== 'function') continue; // a skeleton take is a no-op
          try {
            const answer = await timed(
              (taker.impl as (i: unknown) => HookDecision | Promise<HookDecision>)(input),
              hook.timeoutMs,
            );
            if (!answer.allow) return answer;
          } catch (error) {
            return { allow: false, reason: `${taker.id}: ${error instanceof Error ? error.message : String(error)}` };
          }
        }
        return { allow: true };
      },
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

  const configPort = (manifest: Manifest): ConfigPort => {
    const declared = manifest.data?.config ?? [];
    const keyOf = (def: ConfigFileDef<any> | ConfigCollectionDef<any>): string =>
      def.shape === 'file' ? def.file : def.collection;
    const assertDeclared = (def: ConfigFileDef<any> | ConfigCollectionDef<any>): void => {
      if (!declared.includes(def)) throw new Error(`${manifest.id}: config ${keyOf(def)} is not declared`);
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
      fileState(def, name) {
        assertDeclared(def);
        const all = world.config.get(keyOf(def));
        const raw = def.shape === 'file' ? all : name === undefined ? undefined : (all as Record<string, unknown> | undefined)?.[name];
        if (raw === undefined) return { state: 'absent', inEffect: false, sentences: [] };
        const parsed = def.schema.safeParse(raw);
        return parsed.success
          ? { state: 'valid', inEffect: true, sentences: [] }
          : { state: 'invalid', inEffect: false, sentences: parsed.error.issues.map(issue => issue.message) };
      },
      // The real writer's outcomes over the in-memory values: own defs only, schema checked, a loosening held.
      async write(def, edit, writeOptions = {}) {
        if (!declared.includes(def)) return { kind: 'refused', reason: 'not_declared', issues: [] };
        const key = keyOf(def);
        const name = writeOptions.name;
        if (def.shape === 'collection' && (name === undefined || !def.name.test(name)))
          return { kind: 'refused', reason: 'bad_name', issues: [] };
        const all = world.config.get(key) as Record<string, unknown> | undefined;
        const before = def.shape === 'file' ? all : name === undefined ? undefined : all?.[name];
        let next: unknown;
        if (typeof edit === 'string') {
          try {
            next = parseYaml(edit) ?? {};
          } catch {
            return { kind: 'refused', reason: 'yaml', issues: [{ path: key, message: 'this is not YAML' }] };
          }
        } else {
          next = { ...((before as Record<string, unknown> | undefined) ?? {}), ...edit.patch };
          for (const [field, value] of Object.entries(edit.patch)) if (value === undefined) delete (next as Record<string, unknown>)[field];
        }
        const checked = def.schema.safeParse(next);
        if (!checked.success)
          return { kind: 'refused', reason: 'schema', issues: checked.error.issues.map(issue => ({ path: key, message: issue.message })) };
        const etag = JSON.stringify(next);
        if (writeOptions.ifMatch !== undefined && writeOptions.ifMatch !== JSON.stringify(before ?? null)) return { kind: 'conflict' };
        const prior = before === undefined ? undefined : def.schema.safeParse(before);
        const sentences = def.loosens(prior?.success === true ? prior.data : undefined, checked.data);
        if (sentences.length > 0) return { kind: 'held', etag, id: `${key}@held`, sentences };
        world.config.set(key, def.shape === 'file' ? next : { ...(all ?? {}), [name as string]: next });
        for (const listener of configListeners.get(key) ?? []) listener();
        return { kind: 'written', etag, loosened: [] };
      },
    };
  };

  const rootsFor = (manifest: Manifest): KernelPorts['roots'] => ({
    root(name) {
      if (!(manifest.permissions?.roots ?? []).includes(name))
        throw new Error(`${manifest.id}: root ${name} is not declared`);
      const handle: RootHandle = {
        name,
        resolve(relative) {
          if (relative.startsWith('/') || relative.split('/').includes('..')) return { ok: false, error: 'outside' };
          return { ok: true, value: `/${name}/${relative}` as never };
        },
        readText: async path => {
          const text = world.roots.get(path);
          if (text === undefined) throw new Error(`no such file ${path}`);
          return text;
        },
        readBytes: async path => new TextEncoder().encode(await handle.readText(path)),
        writeText: async (path, text) => {
          world.roots.set(path, text);
        },
        list: async path =>
          [...world.roots.keys()].filter(p => p.startsWith(`${path}/`)).map(p => p.slice(path.length + 1)),
        stat: async path =>
          world.roots.has(path)
            ? { kind: 'file', size: (world.roots.get(path) as string).length, modified: clock.now() }
            : undefined,
        remove: async path => {
          world.roots.delete(path);
        },
      };
      return handle;
    },
  });

  const kernelFor = (manifest: Manifest): KernelPorts => {
    let state = world.states.get(manifest.id);
    if (state === undefined) {
      state = new MemoryStateFolder();
      world.states.set(manifest.id, state);
    }
    const publishes = new Set((manifest.data?.publishes ?? []).map(event => event.name));
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
          if (!(manifest.permissions?.spawn ?? []).includes(program))
            throw new Error(`${manifest.id}: spawn ${program} is not declared`);
          if (options.spawn === undefined) throw new Error(`${manifest.id}: spawn ${program} with no spawn fake`);
          return options.spawn(program, args, spawnOptions);
        },
        start(program): ChildHandle {
          throw new Error(
            `${manifest.id}: the test host does not start long-lived ${program}; fake the port that does`,
          );
        },
      },
      fetch: {
        async request(url, init) {
          const parsed = new URL(url);
          if (!(manifest.permissions?.network ?? []).includes(parsed.host))
            throw new Error(`${manifest.id}: network ${parsed.host} is not declared`);
          if (options.fetch === undefined) throw new Error(`${manifest.id}: fetch ${parsed.host} with no fetch fake`);
          return options.fetch(parsed, init);
        },
      },
      websocket: {
        connect(url) {
          const parsed = new URL(String(url));
          if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
            throw new Error(`${manifest.id}: ${parsed.protocol} is not a WebSocket address`);
          if (!(manifest.permissions?.network ?? []).includes(parsed.host))
            throw new Error(`${manifest.id}: network ${parsed.host} is not declared`);
          if (options.websocket === undefined)
            throw new Error(`${manifest.id}: dial ${parsed.host} with no websocket fake`);
          return options.websocket(parsed);
        },
      },
      identity,
      signer: signerFor(manifest.id, identitySigner),
      act: testActRunner({
        holds: () => holds,
        actor: () => actorScope.getStore() ?? 'ferret',
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
    const needs: Record<string, unknown> = {};
    for (const [field, token] of Object.entries(manifest.needs ?? {})) {
      const value = lookup(options.fakes ?? {}, field, token) ?? providedBy.get(token.name);
      if (value === undefined) throw new Error(`testHost: ${manifest.id} needs ${field} (${token.name}); pass a fake`);
      needs[field] = value;
    }
    const uses: Record<string, { current(): unknown }> = {};
    for (const [field, token] of Object.entries(manifest.uses ?? {}))
      uses[field] = {
        current: () => {
          if (!usesBound.done) throw new Error(`${manifest.id}: uses.${field}.current() during build`);
          return lookup(options.uses ?? {}, field, token) ?? providedBy.get(token.name);
        },
      };
    const half = impl.build({
      manifest,
      needs,
      uses,
      kernel: kernelFor(manifest),
      hooks: hooksFor(manifest),
    } as never) as Record<string, any>;
    for (const [field, token] of Object.entries(manifest.provides ?? {}))
      providedBy.set(token.name, half.provides?.[field]);
    built.push({ impl, manifest, half });
  }
  usesBound.done = true;
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
        await actorScope.run(actorOf(caller), () => runHandler(() => handler(call), route.guard, route.noStore)),
      );
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
      return actorScope.run(actorOf(caller), () => handler(call, input));
    },
    async socket(path, init = {}) {
      const request = makeRequest(init.method ?? 'GET', path, { as: init.as ?? owner() });
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
      const attach = await accept({ request, params: found.params, ...decision.standing } as CallContext);
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
    provided<Api>(token: PortToken<Api>): Api {
      if (!providedBy.has(token.name)) throw new Error(`nothing loaded provides ${token.name}`);
      return providedBy.get(token.name) as Api;
    },
    state(pluginId) {
      const state = world.states.get(pluginId);
      if (state === undefined) throw new Error(`no state folder for ${pluginId}`);
      return state;
    },
    setConfig(key, value) {
      world.config.set(key, value);
      for (const listener of configListeners.get(key) ?? []) listener();
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
      world.roots.set(`/${name}/${relative}`, text);
    },
    async stop() {
      if (stopController.signal.aborted) return;
      stopController.abort();
      for (const fn of [...stopHandlers].reverse()) await fn();
    },
  };
  return host;
}

/** @public Test-caller shape for ports to come. */
export type { TestCaller };
