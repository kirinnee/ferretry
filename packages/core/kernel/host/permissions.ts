import type { ChildEnvironmentOpener, FencedPath } from '../contract/bound.ts';
import type { StateFileDef } from '../contract/define.ts';
import { CORE_IDS } from '../contract/ids.ts';
import type { FetchPort, SpawnOptions, SpawnPort, WebSocketPort, WorkersPort } from '../contract/ports.ts';
import { WORKER_STATE_KEY } from '../worker.ts';
import { embeddedWorkerFile, isCompiledModule } from './adapters/embedded-worker.ts';
import { serveWorkerGrants, type WorkerGrantSources } from './worker-grants/serve.ts';
import { WORKER_GRANTS_KEY } from './worker-grants/wire.ts';
import type { ItemKind, PermissionEntry } from '../manifest/types.ts';
import { hostAllowed, programAmong, programName, WILDCARD } from '../manifest/reach.ts';
import type { PinRegistry } from './pins.ts';
import { type DetachedCall, detachedAsked, detachedNotOffered, detachedRefusal } from './detached.ts';

export { hostAllowed, WILDCARD };

/** What the owner-installed, pinned items of one kind name: their programs and their hosts. */
export interface ItemReach {
  readonly programs: readonly string[];
  readonly hosts: readonly string[];
}

/** The installed items' reach, asked when a call is made. */
export type ItemReachOf = (kind: ItemKind) => ItemReach;

export const NO_ITEMS: ItemReachOf = () => ({ programs: [], hosts: [] });

/**
 * The declared strings plus what each `{ items }` entry's installed items name now (a resolver is asked apart). An
 * item's name with `*` in it is dropped: `'*'` (and any pattern) is a core piece's alone, never an item's.
 */
function expand(declared: readonly PermissionEntry[], items: ItemReachOf, pick: keyof ItemReach): readonly string[] {
  return declared.flatMap(entry =>
    typeof entry === 'string'
      ? [entry]
      : 'items' in entry
        ? items(entry.items)[pick].filter(name => !name.includes('*'))
        : [],
  );
}

/** A plugin's declared network resolvers by name (its daemon half's `resolvers` section), asked at each call. */
export type ResolverOf = (name: string) => (() => readonly string[]) | undefined;

export const NO_RESOLVERS: ResolverOf = () => undefined;

/**
 * Whether a `{ resolver }` entry allows this address: the resolver is called with NOTHING about the request, and
 * one of its answers must equal the host or `host:port` exactly. A wildcard answer allows nothing; a missing or
 * throwing resolver refuses.
 */
function resolverAllows(
  declared: readonly PermissionEntry[],
  resolve: ResolverOf,
  hostname: string,
  host: string,
): boolean {
  const lowerName = hostname.toLowerCase();
  const lowerHost = host.toLowerCase();
  for (const entry of declared) {
    if (typeof entry !== 'object' || !('resolver' in entry)) continue;
    const resolver = resolve(entry.resolver);
    if (resolver === undefined) continue;
    let answers: readonly string[];
    try {
      answers = resolver();
    } catch {
      continue;
    }
    if (!Array.isArray(answers)) continue;
    for (const answer of answers) {
      if (typeof answer !== 'string' || answer.includes('*')) continue;
      const wanted = answer.toLowerCase();
      if (wanted === lowerName || wanted === lowerHost) return true;
    }
  }
  return false;
}
import { resolveEnv } from './adapters/process.ts';

export class PermissionError extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'PermissionError';
  }
}

/**
 * Whether `program` is declared: a declared name matches the program or its basename (an absolute path to a declared
 * program passes, today's rule); an installed item that names an ABSOLUTE path allows exactly that path, never another
 * file of the same name. Shared with the test host so both refuse alike.
 */
export function spawnPermitted(declared: readonly PermissionEntry[], items: ItemReachOf, program: string): boolean {
  const named = expand(declared, items, 'programs');
  return programAmong(named, program);
}

/** Whether `hostname` is declared, directly or by an installed item of a declared `{ items }` kind. */
export function hostPermitted(
  declared: readonly PermissionEntry[],
  items: ItemReachOf,
  hostname: string,
  resolve: ResolverOf = NO_RESOLVERS,
  host: string = hostname,
): boolean {
  const named = expand(declared, items, 'hosts');
  return named.includes(WILDCARD) || hostAllowed(hostname, named) || resolverAllows(declared, resolve, hostname, host);
}

/** What the host hands the restrict wrappers: a non-core manifest's `'*'` is dropped, so it grants nothing. */
export function effectivePermissions(plugin: string, declared: readonly PermissionEntry[]): readonly PermissionEntry[] {
  return (CORE_IDS as readonly string[]).includes(plugin) ? declared : declared.filter(entry => entry !== WILDCARD);
}

/** Only programs the manifest declared in `permissions.spawn` (§3.7); refused before anything starts. */
export function restrictSpawn(
  plugin: string,
  declared: readonly PermissionEntry[],
  base: SpawnPort,
  items: ItemReachOf = NO_ITEMS,
  pins?: Pick<PinRegistry, 'lookup'>,
): SpawnPort {
  /** Refuses an undeclared program, and a pinned cwd this plugin's roots did not mint; a Linux pin's alias is used. */
  const check = <O extends SpawnOptions | undefined>(program: string, options: O): O => {
    // A detached start is offered only by `allowDetachedSpawn` around this port; through this one it is refused.
    if (detachedAsked(options)) throw new PermissionError(detachedNotOffered(plugin, program));
    if (!spawnPermitted(declared, items, program))
      throw new PermissionError(`${plugin} may not run ${programName(program)}: its manifest does not declare it.`);
    const cwd = options?.cwd;
    if (cwd === undefined || typeof cwd === 'string') return options;
    const minted = pins?.lookup(plugin, cwd);
    if (minted === undefined)
      throw new PermissionError(`${plugin} may start a child only in a folder one of its own roots holds open.`);
    return (minted.alias === undefined ? options : { ...options, cwd: minted.alias as FencedPath }) as O;
  };
  return {
    run: async (program, args, options) => await base.run(program, args, check(program, options)),
    runBytes: async (program, args, options) => await base.runBytes(program, args, check(program, options)),
    start: (program, args, options) => base.start(program, args, check(program, options)),
  };
}

/**
 * `SpawnOptions.detached` (kernel batch #15) around a `restrictSpawn` port: a call without `detached` goes to
 * `restricted` unchanged; a detached one is judged by `detachedRefusal` (`permissions.detached` by name, inside
 * `permissions.spawn`, `start` only, none of the refused options) and, allowed, started on `base` directly. `started`
 * hears the program's NAME and the pid, never its arguments (a URL may carry a query).
 */
export function allowDetachedSpawn(
  plugin: string,
  declared: readonly string[] | undefined,
  spawnDeclared: readonly PermissionEntry[],
  restricted: SpawnPort,
  base: SpawnPort,
  items: ItemReachOf = NO_ITEMS,
  started: (program: string, pid: number) => void = () => undefined,
): SpawnPort {
  const judge = (call: DetachedCall, program: string, options: SpawnOptions): void => {
    const why = detachedRefusal(
      plugin,
      declared,
      spawnPermitted(spawnDeclared, items, program),
      call,
      program,
      options,
    );
    if (why !== undefined) throw new PermissionError(why);
  };
  return {
    run: async (program, args, options) => {
      if (detachedAsked(options)) judge('run', program, options);
      return await restricted.run(program, args, options);
    },
    runBytes: async (program, args, options) => {
      if (detachedAsked(options)) judge('runBytes', program, options);
      return await restricted.runBytes(program, args, options);
    },
    start: (program, args, options) => {
      if (!detachedAsked(options)) return restricted.start(program, args, options);
      judge('start', program, options);
      const handle = base.start(program, args, options);
      started(programName(program), handle.pid);
      return handle;
    },
  };
}

/** HTTP only to hosts the manifest declared in `permissions.network`; refused before a socket opens. */
export function restrictFetch(
  plugin: string,
  declared: readonly PermissionEntry[],
  base: FetchPort,
  items: ItemReachOf = NO_ITEMS,
  resolve: ResolverOf = NO_RESOLVERS,
): FetchPort {
  return {
    request: async (url, init) => {
      let parsed: URL;
      try {
        parsed = new URL(String(url));
      } catch {
        throw new PermissionError(`${plugin} asked for a malformed address.`);
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        throw new PermissionError(`${plugin} may only make HTTP requests.`);
      if (!hostPermitted(declared, items, parsed.hostname, resolve, parsed.host))
        throw new PermissionError(`${plugin} may not reach ${parsed.hostname}: its manifest does not declare it.`);
      // Redirects are not followed blindly: a declared host could bounce the request anywhere.
      return await base.request(parsed, { ...init, redirect: 'manual' });
    },
  };
}

/**
 * Opens a Vault `ChildEnvironment` handle inside the kernel, at the moment the child starts (lead decision 9). The half
 * only ever held the opaque handle; the values go from the opener straight into the adapter's spawn call.
 */
export function openChildEnvironments(base: SpawnPort, opener: () => ChildEnvironmentOpener | undefined): SpawnPort {
  const resolved = (options?: SpawnOptions): SpawnOptions | undefined =>
    options?.env === undefined ? options : { ...options, env: resolveEnv(options.env, opener()) };
  return {
    run: async (program, args, options) => await base.run(program, args, resolved(options)),
    runBytes: async (program, args, options) => await base.runBytes(program, args, resolved(options)),
    start: (program, args, options) => base.start(program, args, resolved(options)),
  };
}

/** How a plugin's lifecycle ends the grants of its workers: `onStop` registers, `stopping` refuses a late start. */
export interface WorkerGrantEnding {
  onStop(fn: () => void): void;
  stopping(): boolean;
}

/**
 * The worker programs a plugin declares (its half's `workers`), for the one rule that needs them: in a COMPILED binary
 * a worker program is found by its file stem alone, so the URL a plugin starts must carry the stem of a program the
 * plugin declares — a typo or an undeclared spelling that happens to share a declared stem would start that program
 * instead of failing. From source the URL is the file itself and nothing is checked.
 */
export interface DeclaredWorkers {
  readonly urls: () => Readonly<Record<string, URL>> | undefined;
  /** Whether the binary is compiled; this process's own answer unless a test asks how a compiled one behaves. */
  readonly compiled?: boolean;
}

/** The embedded file of a worker URL, or `undefined` when its name cannot be read (broken percent escapes). */
function stemOf(url: URL): string | undefined {
  try {
    return embeddedWorkerFile(url);
  } catch {
    return undefined;
  }
}

/**
 * Workers for one plugin: each `state` grant is resolved by that plugin's own state port (declared, sqlite only, in
 * its folder) and handed to the worker as `workerData`; an ungrantable one refuses the start before a thread exists.
 * `roots` and `network` are granted from `reach` (this plugin's own roots port and `kernel.fetch`): READ-ONLY roots and
 * the manifest's own hosts, served over one channel the kernel keeps the main end of; anything the manifest does not
 * declare refuses the start. The plugin's options are never forwarded as they are: only what is named below goes in.
 */
export function workersFor(
  base: WorkersPort,
  grant: () => ((def: StateFileDef, name?: string) => { readonly path: string; readonly label: string }) | undefined,
  reach?: WorkerGrantSources,
  ending?: WorkerGrantEnding,
  declared?: DeclaredWorkers,
): WorkersPort {
  // One entry per live granted worker, drained by ONE stop handler for the plugin: a worker that ends takes its entry out.
  const live = new Set<() => void>();
  let registered = false;
  return {
    start: (given, options) => {
      // ONE reading of the URL, checked and started: the caller's own URL is mutable, and reading `options` below runs
      // the caller's getters, which could retarget it between the stem check and the start.
      const moduleUrl = new URL(given.href);
      if (declared !== undefined && moduleUrl.protocol === 'file:' && (declared.compiled ?? isCompiledModule())) {
        const stem = stemOf(moduleUrl);
        const known = Object.values(declared.urls() ?? {}).map(stemOf);
        if (stem === undefined || !known.includes(stem))
          throw new TypeError('this plugin declares no worker program by that file name');
      }
      const wanted = options?.state ?? [];
      const resolve = grant();
      if (wanted.length > 0 && resolve === undefined) throw new TypeError('this plugin has no state to grant a worker');
      const grants = wanted.map(entry => {
        const def = 'def' in entry ? entry.def : entry;
        const name = 'def' in entry ? entry.name : undefined;
        const at = (resolve as NonNullable<typeof resolve>)(def, name);
        return {
          file: { name: def.name, path: def.path, store: def.store, format: def.format },
          ...(name === undefined ? {} : { name }),
          path: at.path,
          label: at.label,
        };
      });
      const asked = (options?.roots?.length ?? 0) > 0 || options?.network !== undefined;
      if (asked && ending?.stopping() === true)
        throw new TypeError('this plugin has stopped, so it cannot start a worker with grants');
      if (asked && reach === undefined) throw new TypeError('this plugin has no roots or network to grant a worker');
      const served =
        reach === undefined
          ? undefined
          : serveWorkerGrants(reach, { roots: options?.roots, network: options?.network });
      const forward = {
        ...(options?.name === undefined ? {} : { name: options.name }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(grants.length === 0 && served === undefined
          ? {}
          : {
              workerData: {
                ...(grants.length === 0 ? {} : { [WORKER_STATE_KEY]: grants }),
                ...(served === undefined ? {} : { [WORKER_GRANTS_KEY]: served.data }),
              },
            }),
        ...(served === undefined ? {} : { transferList: served.transfer }),
      };
      if (served === undefined) return base.start(moduleUrl, forward);
      let handle: ReturnType<WorkersPort['start']>;
      try {
        handle = base.start(moduleUrl, forward);
      } catch (error) {
        served.close();
        throw error;
      }
      // The channel lives and dies with the thread: a dead worker's requests are not answered. It also ends with the
      // plugin: a plugin that failed to build or stopped keeps no grant, and its thread is ended with it.
      const entry = (): void => {
        served.close();
        void Promise.resolve(handle.terminate()).catch(() => undefined);
      };
      live.add(entry);
      if (ending !== undefined && !registered) {
        registered = true;
        ending.onStop(() => {
          const entries = [...live];
          live.clear();
          for (const end of entries) end();
        });
      }
      handle.onExit(() => {
        live.delete(entry);
        served.close();
      });
      return {
        ...handle,
        terminate: async () => {
          live.delete(entry);
          served.close();
          await handle.terminate();
        },
      };
    },
  };
}

/**
 * WebSocket clients only to hosts the manifest declared in `permissions.network`, `ws:`/`wss:` only; refused with the
 * same `PermissionError` as {@link restrictFetch}, synchronously, before a socket opens.
 */
export function restrictWebSocket(
  plugin: string,
  declared: readonly PermissionEntry[],
  base: WebSocketPort,
  items: ItemReachOf = NO_ITEMS,
  resolve: ResolverOf = NO_RESOLVERS,
): WebSocketPort {
  return {
    connect: url => {
      let parsed: URL;
      try {
        parsed = new URL(String(url));
      } catch {
        throw new PermissionError(`${plugin} asked for a malformed address.`);
      }
      if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:')
        throw new PermissionError(`${plugin} may only open WebSocket connections.`);
      if (!hostPermitted(declared, items, parsed.hostname, resolve, parsed.host))
        throw new PermissionError(`${plugin} may not reach ${parsed.hostname}: its manifest does not declare it.`);
      return base.connect(parsed);
    },
  };
}
