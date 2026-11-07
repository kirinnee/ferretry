import type { ChildEnvironmentOpener } from '../contract/bound.ts';
import type { FetchPort, SpawnOptions, SpawnPort, WebSocketPort } from '../contract/ports.ts';
import type { ItemKind, PermissionEntry } from '../manifest/types.ts';

/** What the owner-installed, pinned items of one kind name: their programs and their hosts. */
export interface ItemReach {
  readonly programs: readonly string[];
  readonly hosts: readonly string[];
}

/** The installed items' reach, asked when a call is made. */
export type ItemReachOf = (kind: ItemKind) => ItemReach;

export const NO_ITEMS: ItemReachOf = () => ({ programs: [], hosts: [] });

/** The declared strings plus what each `{ items }` entry's installed items name now. */
function expand(declared: readonly PermissionEntry[], items: ItemReachOf, pick: keyof ItemReach): readonly string[] {
  return declared.flatMap(entry => (typeof entry === 'string' ? [entry] : items(entry.items)[pick]));
}
import { resolveEnv } from './adapters/process.ts';

export class PermissionError extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'PermissionError';
  }
}

const programName = (program: string): string => program.slice(program.lastIndexOf('/') + 1);

/**
 * Whether `program` is declared: a declared name matches the program or its basename (an absolute path to a declared
 * program passes, today's rule); an installed item that names an ABSOLUTE path allows exactly that path, never another
 * file of the same name. Shared with the test host so both refuse alike.
 */
export function spawnPermitted(declared: readonly PermissionEntry[], items: ItemReachOf, program: string): boolean {
  const named = expand(declared, items, 'programs');
  const exact = new Set(named.filter(entry => entry.includes('/')));
  const allowed = new Set(named.filter(entry => !entry.includes('/')));
  return exact.has(program) || allowed.has(program) || allowed.has(programName(program));
}

/** Whether `hostname` is declared, directly or by an installed item of a declared `{ items }` kind. */
export function hostPermitted(declared: readonly PermissionEntry[], items: ItemReachOf, hostname: string): boolean {
  return hostAllowed(hostname, expand(declared, items, 'hosts'));
}

/** Only programs the manifest declared in `permissions.spawn` (§3.7); refused before anything starts. */
export function restrictSpawn(
  plugin: string,
  declared: readonly PermissionEntry[],
  base: SpawnPort,
  items: ItemReachOf = NO_ITEMS,
): SpawnPort {
  const check = (program: string): void => {
    if (!spawnPermitted(declared, items, program))
      throw new PermissionError(`${plugin} may not run ${programName(program)}: its manifest does not declare it.`);
  };
  return {
    run: async (program, args, options) => {
      check(program);
      return await base.run(program, args, options);
    },
    runBytes: async (program, args, options) => {
      check(program);
      return await base.runBytes(program, args, options);
    },
    start: (program, args, options) => {
      check(program);
      return base.start(program, args, options);
    },
  };
}

/** `*.example.com` matches subdomains only; an exact host matches itself. */
export function hostAllowed(host: string, declared: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return declared.some(entry => {
    const pattern = entry.toLowerCase();
    return pattern.startsWith('*.')
      ? lower.endsWith(pattern.slice(1)) && lower !== pattern.slice(2)
      : lower === pattern;
  });
}

/** HTTP only to hosts the manifest declared in `permissions.network`; refused before a socket opens. */
export function restrictFetch(
  plugin: string,
  declared: readonly PermissionEntry[],
  base: FetchPort,
  items: ItemReachOf = NO_ITEMS,
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
      if (!hostPermitted(declared, items, parsed.hostname))
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
 * WebSocket clients only to hosts the manifest declared in `permissions.network`, `ws:`/`wss:` only; refused with the
 * same `PermissionError` as {@link restrictFetch}, synchronously, before a socket opens.
 */
export function restrictWebSocket(
  plugin: string,
  declared: readonly PermissionEntry[],
  base: WebSocketPort,
  items: ItemReachOf = NO_ITEMS,
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
      if (!hostPermitted(declared, items, parsed.hostname))
        throw new PermissionError(`${plugin} may not reach ${parsed.hostname}: its manifest does not declare it.`);
      return base.connect(parsed);
    },
  };
}
