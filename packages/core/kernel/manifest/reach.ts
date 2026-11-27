import { historyPoolFault } from './history-pool.ts';
import { delegateProblems } from './delegate.ts';
import type { ItemKind, Manifest, Needer } from './types.ts';

/** `'*'` in `permissions.spawn` / `network`: any program or host. A core piece's alone: `effectivePermissions` drops it from any other manifest. */
export const WILDCARD = '*';

/** The last path segment of a program (`/usr/bin/tmux` → `tmux`). */
export const programName = (program: string): string => program.slice(program.lastIndexOf('/') + 1);

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

/**
 * `'$daemon'` in `permissions.spawn`: the daemon's OWN executable (`process.execPath`, exactly), for a plugin that runs a
 * program of its own in a child process (Voice's native speech host: `fyd --plugin-child`). It is a name no program has, so it
 * cannot be matched by a basename, and it never allows a path other than the one this process was started from. The spawn
 * guard (`spawnPermitted`) also admits it only with `--plugin-child` as the first argument, never with arguments of the plugin's own.
 */
export const DAEMON_PROGRAM = '$daemon';

/**
 * Whether a program is among `named` program names (no installed items): a declared name matches the program or its
 * basename, a declared path only that exact path, `'$daemon'` the daemon's own executable, and `'*'` anything. The kernel's
 * own spawn check reads the same rule.
 */
export function programAmong(named: readonly string[], program: string): boolean {
  if (named.includes(WILDCARD)) return true;
  if (named.includes(DAEMON_PROGRAM) && program === process.execPath) return true;
  const exact = new Set(named.filter(entry => entry.includes('/')));
  const allowed = new Set(named.filter(entry => !entry.includes('/') && entry !== DAEMON_PROGRAM));
  return exact.has(program) || allowed.has(program) || allowed.has(programName(program));
}

const strings = (entries: readonly unknown[] | undefined): readonly string[] =>
  (entries ?? []).filter((entry): entry is string => typeof entry === 'string');

/**
 * What a provider that acts for a caller narrows to (§3.7). Only literal entries count: an `{ items }` or resolver
 * entry names hosts and programs the kernel reads at the call, which a provider cannot see, so it grants nothing here
 * (fail closed). A needer's `'*'` was already dropped unless it is a core piece.
 */
export const neederMayRun = (needer: Needer, program: string): boolean =>
  programAmong(strings(needer.permissions.spawn), program);

/** Whether the needer's literal `network` entries allow `hostname` (no port). */
export const neederMayReach = (needer: Needer, hostname: string): boolean => {
  const named = strings(needer.permissions.network);
  return named.includes(WILDCARD) || hostAllowed(hostname, named);
};

/**
 * The plugin that owns the items of `kind` as a config collection: an `item` plugin whose collection declares
 * `itemKind: kind`. Only a declared collection counts, never one that merely shares the kind's name.
 */
export function itemOwnersOf(manifests: readonly Manifest[], kind: ItemKind): readonly string[] {
  return manifests
    .filter(
      manifest =>
        manifest.kinds.includes('item') &&
        (manifest.data?.config ?? []).some(def => def.shape === 'collection' && def.itemKind === kind),
    )
    .map(manifest => manifest.id);
}

/** One way a manifest's reach declarations are wrong; the plugin is not started (boot) and the graph fails (build). */
export interface ReachFault {
  readonly plugin: string;
  readonly code: 'item-owner' | 'resolver-axes' | 'history-pool' | 'delegate';
  /** A sentence that starts with a verb, to follow the plugin's name. */
  readonly sentence: string;
}

/**
 * The reach declarations the kernel does not honour (K1, K2), over every known manifest:
 * - `{ items: kind }` for a kind whose items are an owner's config collection is that owner's alone, and a kind has one
 *   owner; `itemKind` on a collection belongs to an `item` plugin;
 * - one resolver name is in `spawn` OR `network`, never both: its answers are programs on one axis and hosts on the
 *   other, so a name in both lets a host answer authorize a same-named program and the reverse.
 * - `permissions.historyPool` must name an opaque `<folder>/*` state tree of the plugin's own, list only entries the
 *   kernel's deny list allows, and sit beside the `agent-homes` root it links into.
 * The build-time graph check and the boot refusal read this one rule.
 */
export function reachFaults(manifests: readonly Manifest[]): readonly ReachFault[] {
  const faults: ReachFault[] = [];
  for (const manifest of manifests) {
    for (const sentence of delegateProblems(manifest, manifests))
      faults.push({ plugin: manifest.id, code: 'delegate', sentence });
    if (!manifest.kinds.includes('item'))
      for (const def of manifest.data?.config ?? [])
        if (def.shape === 'collection' && def.itemKind !== undefined)
          faults.push({
            plugin: manifest.id,
            code: 'item-owner',
            sentence: `declares collection ${def.collection} with itemKind '${def.itemKind}' but is not an item plugin`,
          });
    for (const def of manifest.data?.config ?? []) {
      if (def.shape !== 'collection' || def.itemKind === undefined || !manifest.kinds.includes('item')) continue;
      const owners = itemOwnersOf(manifests, def.itemKind);
      if (owners[0] !== manifest.id)
        faults.push({
          plugin: manifest.id,
          code: 'item-owner',
          sentence: `declares collection ${def.collection} with itemKind '${def.itemKind}', which ${owners[0] ?? 'another plugin'} already owns`,
        });
    }
    for (const field of ['spawn', 'network'] as const)
      for (const entry of manifest.permissions?.[field] ?? []) {
        if (typeof entry !== 'object' || !('items' in entry)) continue;
        const owners = itemOwnersOf(manifests, entry.items);
        const owner = owners[0];
        if (owner !== undefined && owner !== manifest.id)
          faults.push({
            plugin: manifest.id,
            code: 'item-owner',
            sentence: `declares permissions.${field} { items: '${entry.items}' }, whose items are ${owner}'s config collection; only ${owner} may`,
          });
      }
    const pool = manifest.permissions?.historyPool;
    if (pool !== undefined) {
      const fault =
        historyPoolFault(pool, manifest.data?.state ?? []) ??
        ((manifest.permissions?.roots ?? []).includes('agent-homes')
          ? undefined
          : 'declares permissions.historyPool without the agent-homes root it links into');
      if (fault !== undefined)
        faults.push({
          plugin: manifest.id,
          code: 'history-pool',
          sentence: fault.startsWith('declares') ? fault : `declares an illegal permissions.historyPool: ${fault}`,
        });
    }
    const spawnResolvers = new Set(resolverNames(manifest.permissions?.spawn));
    for (const name of new Set(resolverNames(manifest.permissions?.network)))
      if (spawnResolvers.has(name))
        faults.push({
          plugin: manifest.id,
          code: 'resolver-axes',
          sentence: `names resolver '${name}' in both permissions.spawn and permissions.network; use one resolver for programs and another for hosts`,
        });
  }
  return faults;
}

const resolverNames = (entries: readonly unknown[] | undefined): readonly string[] =>
  (entries ?? []).flatMap(entry =>
    typeof entry === 'object' && entry !== null && 'resolver' in entry
      ? [(entry as { resolver: string }).resolver]
      : [],
  );
