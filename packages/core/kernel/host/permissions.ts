import type { ChildEnvironmentOpener, FencedPath } from '../contract/bound.ts';
import type { StateFileDef } from '../contract/define.ts';
import { CORE_IDS } from '../contract/ids.ts';
import type { FetchPort, SpawnOptions, SpawnPort, WebSocketPort, WorkersPort } from '../contract/ports.ts';
import { WORKER_STATE_KEY } from '../worker.ts';
import type { ItemKind, PermissionEntry } from '../manifest/types.ts';
import { hostAllowed, programAmong, programName, WILDCARD } from '../manifest/reach.ts';
import type { PinRegistry } from './pins.ts';

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

/**
 * Workers for one plugin: each `state` grant is resolved by that plugin's own state port (declared, sqlite only, in
 * its folder) and handed to the worker as `workerData`; an ungrantable one refuses the start before a thread exists.
 */
export function workersFor(
  base: WorkersPort,
  grant: () => ((def: StateFileDef, name?: string) => { readonly path: string; readonly label: string }) | undefined,
): WorkersPort {
  return {
    start: (moduleUrl, options) => {
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
      const forward = {
        ...(options?.name === undefined ? {} : { name: options.name }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(grants.length === 0 ? {} : { workerData: { [WORKER_STATE_KEY]: grants } }),
      };
      return base.start(moduleUrl, forward);
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
