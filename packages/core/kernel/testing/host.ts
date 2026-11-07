import { MAX_ROOT_WINDOW_BYTES } from '../contract/ports.ts';
import { beforeListen } from '../host/before-listen.ts';
import type { DaemonContext } from '../manifest/implement.ts';
import { failureResponse } from '../host/responses.ts';
import type { HostFactsPort, UpdateHostPort } from '../contract/ports.ts';
import { undeclaredHostFacts } from '../host/adapters/host-facts.ts';
import { undeclaredUpdateHost } from '../host/adapters/update-host.ts';
import { NO_HOST_FACTS } from '../host/no-host-facts.ts';
import type { DaemonTimings } from '../contract/ports.ts';
import { DEFAULT_DAEMON_TIMINGS } from '../host/session/timings.ts';
import { addedSecretReferenceSentences, ownSecretsPort, secretReferencesIn } from '../host/secrets.ts';
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
import { KERNEL_ONLY_PORTS, WITHHELD_SENTENCE } from '../contract/bound.ts';
import type {
  ConfigCollectionDef,
  ConfigFileDef,
  Contribution,
  EventDef,
  HookDecision,
  PortToken,
} from '../contract/define.ts';
import { judgeLoosening } from '../contract/define.ts';
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
import {
  effectivePermissions,
  hostPermitted,
  type ItemReachOf,
  NO_ITEMS,
  spawnPermitted,
} from '../host/permissions.ts';
import { scratchPort } from '../host/scratch.ts';
import { PinRegistry } from '../host/pins.ts';
import { type SessionRootPinner, unsupportedPlatform } from '../contract/pinned.ts';
import type { ScratchPort } from '../contract/ports.ts';
import { testIdentity } from './identity.ts';
import type { IdentitySigner } from '../contract/session.ts';
import type { CallContext, MemberRouteHandler, RouteDescriptor, RouteHandler } from '../contract/route.ts';
import type { DoctorFinding } from '../contract/kernel.ts';
import type { PostBuildSnapshot } from '../contract/snapshot.ts';
import type { SocketAccept, SocketDownstream, SocketHandler } from '../contract/socket.ts';
import type { DoctorRun, DaemonImplementation, HookInvoker, ToolHandler, ToolResult } from '../manifest/implement.ts';
import type { HookTake, Manifest, ToolDecl } from '../manifest/types.ts';
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
  /** Answers `RootHandle.pin` (with the path the test root resolved). Without it a pin is refused. */
  readonly pinner?: SessionRootPinner;
  /** What `kernel.paths.home()` answers. Default: `/home/owner`. */
  readonly ownerHome?: string;
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
  /** What `kernel.updateHost` answers to a plugin that declared `permissions.updateHost`. */
  readonly updateHost?: UpdateHostPort;
  /** What `kernel.timings` answers. Default: the shipped numbers (`DEFAULT_DAEMON_TIMINGS`). */
  readonly timings?: DaemonTimings;
  /** The Vault stand-in for `kernel.secrets.resolve`: name to value. Absent, every declared and configured name is `unknown`. */
  readonly vault?: Readonly<Record<string, string>>;
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
  /** Runs a half's declared `doctor` check (manifest `doctor` id) as `fy doctor` would. */
  doctor(plugin: string, check: string): Promise<DoctorFinding>;
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
  const identity: IdentityPort =
    options.identity ?? Object.freeze({ daemonId: throwaway.daemonId, daemonName: 'test-daemon' });
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
  const bootContexts = new Map<string, DaemonContext<Manifest>>();
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

  const judged = (plugin: string, path: string, removal: boolean, sentences: readonly string[]): boolean => {
    try {
      return (
        admission.judgeConfigWrite?.({ plugin, path, removal, sentences, actor: actorScope.getStore() ?? 'ferret' }) ===
        'apply'
      );
    } catch {
      return false;
    }
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
        const raw =
          def.shape === 'file'
            ? all
            : name === undefined
              ? undefined
              : (all as Record<string, unknown> | undefined)?.[name];
        if (raw === undefined) return { state: 'absent', inEffect: false, sentences: [] };
        const parsed = def.schema.safeParse(raw);
        return parsed.success
          ? { state: 'valid', inEffect: true, sentences: [] }
          : { state: 'invalid', inEffect: false, sentences: parsed.error.issues.map(issue => issue.message) };
      },
      // The real writer's outcomes over the in-memory values: own defs only, schema checked, a loosening held unless
      // the admission in use (Gate's, when given) judges this call may apply it.
      async write(def, name, edit, writeOptions = {}) {
        if (!declared.includes(def)) return { kind: 'refused', reason: 'not_declared', issues: [] };
        const key = keyOf(def);
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
          for (const [field, value] of Object.entries(edit.patch))
            if (value === undefined) delete (next as Record<string, unknown>)[field];
        }
        const checked = def.schema.safeParse(next);
        if (!checked.success)
          return {
            kind: 'refused',
            reason: 'schema',
            issues: checked.error.issues.map(issue => ({ path: key, message: issue.message })),
          };
        const etag = JSON.stringify(next);
        if (writeOptions.ifMatch !== undefined && writeOptions.ifMatch !== JSON.stringify(before ?? null))
          return { kind: 'conflict' };
        const prior = before === undefined ? undefined : def.schema.safeParse(before);
        const priorValue = prior?.success === true ? prior.data : undefined;
        // as the real port: a plugin's own write that adds a secret reference is held for the owner, judge or not
        const added = addedSecretReferenceSentences(priorValue, checked.data);
        const sentences = [...judgeLoosening(def, priorValue, checked.data), ...added];
        const path = def.shape === 'file' ? key : `${key}/${name as string}.yaml`;
        if (added.length > 0 || (sentences.length > 0 && !judged(manifest.id, path, false, sentences)))
          return { kind: 'held', etag, id: `${path}@held`, sentences };
        world.config.set(key, def.shape === 'file' ? next : { ...(all ?? {}), [name as string]: next });
        for (const listener of configListeners.get(key) ?? []) listener();
        return { kind: 'written', etag, loosened: sentences };
      },
      async remove(def, name, writeOptions = {}) {
        if (!declared.includes(def)) return { kind: 'refused', reason: 'not_declared', issues: [] };
        const key = keyOf(def);
        if (def.shape === 'collection' && (name === undefined || !def.name.test(name)))
          return { kind: 'refused', reason: 'bad_name', issues: [] };
        const all = world.config.get(key) as Record<string, unknown> | undefined;
        const before = def.shape === 'file' ? all : all?.[name as string];
        if (writeOptions.ifMatch !== undefined && writeOptions.ifMatch !== JSON.stringify(before ?? null))
          return { kind: 'conflict' };
        const prior = before === undefined ? undefined : def.schema.safeParse(before);
        const defaults = def.schema.safeParse({});
        // as the real port: judged even with no defaults (`after` undefined), a throwing judgement held
        const sentences =
          prior?.success === true ? judgeLoosening(def, prior.data, defaults.success ? defaults.data : undefined) : [];
        const path = def.shape === 'file' ? key : `${key}/${name as string}.yaml`;
        if (sentences.length > 0 && !judged(manifest.id, path, true, sentences))
          return { kind: 'held', etag: 'absent', id: `${path}@held`, sentences };
        if (def.shape === 'file') world.config.delete(key);
        else if (all !== undefined) {
          const { [name as string]: _gone, ...rest } = all;
          world.config.set(key, rest);
        }
        for (const listener of configListeners.get(key) ?? []) listener();
        return { kind: 'written', etag: 'absent', loosened: sentences };
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
  const rootsFor = (manifest: Manifest): KernelPorts['roots'] => ({
    root(name) {
      if (!(manifest.permissions?.roots ?? []).includes(name))
        throw new Error(`${manifest.id}: root ${name} is not declared`);
      const fileStat = (path: string) => ({
        kind: 'file' as const,
        size: (world.roots.get(path) ?? '').length,
        modified: clock.now(),
        mode: 0o600,
        links: 1,
      });
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
          if (writeOptions?.replaceExisting === true && !world.roots.has(path)) throw new Error(`no such file ${path}`);
          world.roots.set(path, text);
        },
        writeBytes: async (path, bytes, writeOptions) => {
          if (writeOptions?.exclusive === true && world.roots.has(path)) throw new Error(`${path} already exists`);
          if (writeOptions?.replaceExisting === true && !world.roots.has(path)) throw new Error(`no such file ${path}`);
          world.roots.set(path, new TextDecoder().decode(bytes));
        },
        copyTree: async (_source, from, to, copyOptions) => {
          // the test roots are one flat map: copy (or, for a link, alias) every file under `from`
          for (const [key, text] of [...world.roots])
            if (key.startsWith(`${from}/`)) world.roots.set(`${to}${key.slice(from.length)}`, text);
          void copyOptions;
        },
        ensurePrivateDirectory: async () => {},
        lstat: async path => {
          if (world.roots.has(path)) return fileStat(path);
          return [...world.roots.keys()].some(p => p.startsWith(`${path}/`))
            ? { kind: 'directory', size: 0, modified: clock.now(), mode: 0o700, links: 1 }
            : undefined;
        },
        makeDirectory: async () => {},
        realPath: async path => {
          if (!world.roots.has(path) && ![...world.roots.keys()].some(p => p.startsWith(`${path}/`)))
            throw new Error(`no such file ${path}`);
          return path;
        },
        list: async path =>
          [...world.roots.keys()].filter(p => p.startsWith(`${path}/`)).map(p => p.slice(path.length + 1)),
        entries: async path =>
          [...world.roots.keys()]
            .filter(p => p.startsWith(`${path}/`))
            .map(p => ({ name: p.slice(path.length + 1), ...fileStat(p) })),
        stat: async path => (world.roots.has(path) ? fileStat(path) : undefined),
        remove: async path => {
          world.roots.delete(path);
        },
        pin: async (path, pinOptions) => {
          return await pins.pin(manifest.id, path, pinOptions);
        },
      };
      return handle;
    },
  });

  const kernelFor = (manifest: Manifest): KernelPorts => {
    let state = world.states.get(manifest.id);
    if (state === undefined) {
      state = new MemoryStateFolder(() => clock.nowMs());
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
          if (
            !spawnPermitted(
              effectivePermissions(manifest.id, manifest.permissions?.spawn ?? []),
              options.items ?? NO_ITEMS,
              program,
            )
          )
            throw new Error(`${manifest.id}: spawn ${program} is not declared`);
          if (options.spawn === undefined) throw new Error(`${manifest.id}: spawn ${program} with no spawn fake`);
          return options.spawn(program, args, spawnOptions);
        },
        async runBytes(program, args, spawnOptions) {
          const result = await this.run(program, args, spawnOptions);
          const all = new TextEncoder().encode(result.stdout);
          const cap = spawnOptions?.maxStdoutBytes ?? 1024 * 1024;
          return {
            exitCode: result.exitCode ?? -1,
            stdout: all.slice(0, cap),
            stderr: result.stderr,
            stdoutTruncated: all.byteLength > cap,
            stderrTruncated: false,
            timedOut: false,
          };
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
          if (
            !hostPermitted(
              effectivePermissions(manifest.id, manifest.permissions?.network ?? []),
              options.items ?? NO_ITEMS,
              parsed.hostname,
              name =>
                (
                  built.find(b => b.manifest.id === manifest.id)?.half?.resolvers as
                    | Readonly<Record<string, (() => readonly string[]) | undefined>>
                    | undefined
                )?.[name],
              parsed.host,
            )
          )
            throw new Error(`${manifest.id}: network ${parsed.host} is not declared`);
          if (options.fetch === undefined) throw new Error(`${manifest.id}: fetch ${parsed.host} with no fetch fake`);
          return options.fetch(parsed, init);
        },
      },
      scratch: options.scratch ?? scratchPort('fy-test-'),
      websocket: {
        connect(url) {
          const parsed = new URL(String(url));
          if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
            throw new Error(`${manifest.id}: ${parsed.protocol} is not a WebSocket address`);
          if (
            !hostPermitted(
              effectivePermissions(manifest.id, manifest.permissions?.network ?? []),
              options.items ?? NO_ITEMS,
              parsed.hostname,
              name =>
                (
                  built.find(b => b.manifest.id === manifest.id)?.half?.resolvers as
                    | Readonly<Record<string, (() => readonly string[]) | undefined>>
                    | undefined
                )?.[name],
              parsed.host,
            )
          )
            throw new Error(`${manifest.id}: network ${parsed.host} is not declared`);
          if (options.websocket === undefined)
            throw new Error(`${manifest.id}: dial ${parsed.host} with no websocket fake`);
          return options.websocket(parsed);
        },
      },
      identity,
      paths: Object.freeze({ home: () => options.ownerHome ?? '/home/owner' }),
      updateHost:
        manifest.permissions?.updateHost === true && options.updateHost !== undefined
          ? options.updateHost
          : undeclaredUpdateHost(manifest.id, options.updateHost?.release ?? '5.0.0'),
      hostFacts:
        manifest.permissions?.hostFacts === true && options.hostFacts !== undefined
          ? options.hostFacts
          : undeclaredHostFacts(manifest.id, options.hostFacts ?? NO_HOST_FACTS),
      timings: options.timings ?? DEFAULT_DAEMON_TIMINGS,
      // the real order: declared, named by its own config (as the test world holds it), then the Vault stand-in
      secrets: ownSecretsPort(
        manifest.permissions?.secrets ?? [],
        () => {
          const named = new Set<string>();
          for (const def of manifest.data?.config ?? [])
            secretReferencesIn(world.config.get(def.shape === 'file' ? def.file : def.collection), named);
          return named;
        },
        () => (options.vault === undefined ? undefined : { resolve: async name => options.vault?.[name] }),
      ),
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
    const kernelOnly = [...Object.values(manifest.needs ?? {}), ...Object.values(manifest.uses ?? {})].find(token =>
      KERNEL_ONLY_PORTS.includes(token.name),
    );
    if (kernelOnly !== undefined)
      throw new Error(`testHost: ${manifest.id} asks for ${kernelOnly.name}, which only the kernel may hold`);
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
