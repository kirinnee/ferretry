/** One inventory of pending app halves and the precise source exclusions their unfinished ports need. */
import { readPendingMerged } from './pending-files.ts';

export interface PendingAppPort {
  readonly plugin: string;
  readonly path: string;
  readonly reason: string;
}

const HALF_NAMES: readonly string[] = ['daemon', 'app', 'cli'];

export interface PendingApps {
  /** Every half a plugin's pendingHalves entry names, by plugin id (the two-way skeleton rule reads this). */
  readonly named: ReadonlyMap<string, ReadonlySet<string>>;
  /** A whole app half is not registered until its port removes it from pendingHalves. */
  readonly halves: ReadonlySet<string>;
  /** Partial app ports can exclude files while their already ported views remain registered. */
  readonly exclusions: readonly PendingAppPort[];
}

export function readPendingApps(root: string): PendingApps {
  const text = readPendingMerged(root);
  const value = JSON.parse(text) as {
    format?: unknown;
    pendingHalves?: unknown;
    pendingAppPorts?: unknown;
  };
  if (value.format !== 1) throw new Error('ports-pending: format is not 1');
  const halves = new Set<string>();
  const named = new Map<string, ReadonlySet<string>>();
  if (value.pendingHalves !== undefined) {
    if (typeof value.pendingHalves !== 'object' || value.pendingHalves === null || Array.isArray(value.pendingHalves))
      throw new Error('ports-pending: pendingHalves must name plugins and their pending halves');
    for (const [plugin, pending] of Object.entries(value.pendingHalves)) {
      if (!Array.isArray(pending) || pending.some(half => typeof half !== 'string' || !HALF_NAMES.includes(half)))
        throw new Error(`ports-pending: ${plugin} pendingHalves names only daemon, app or cli`);
      named.set(plugin, new Set(pending as string[]));
      if (pending.includes('app')) halves.add(plugin);
    }
  }
  const exclusions: PendingAppPort[] = [];
  if (value.pendingAppPorts !== undefined) {
    if (!Array.isArray(value.pendingAppPorts)) throw new Error('ports-pending: pendingAppPorts must be a list');
    for (const entry of value.pendingAppPorts) {
      if (typeof entry !== 'object' || entry === null) throw new Error('ports-pending: invalid pending app port');
      const { plugin, path, reason } = entry as { plugin?: unknown; path?: unknown; reason?: unknown };
      if (
        typeof plugin !== 'string' ||
        !/^[a-z][a-z0-9-]*$/u.test(plugin) ||
        typeof path !== 'string' ||
        path.includes('*') ||
        path.includes('..') ||
        !new RegExp(`^packages/(?:core|plugins)/${plugin}/(?:app(?:/|$)|tests/(?:unit|support)/app(?:/|$))`, 'u').test(
          path,
        ) ||
        typeof reason !== 'string' ||
        reason.trim() === ''
      )
        throw new Error('ports-pending: each pending app port needs its plugin, exact path and reason');
      if (exclusions.some(port => port.path === path))
        throw new Error(`ports-pending: duplicate app exclusion ${path}`);
      exclusions.push({ plugin, path, reason });
    }
  }
  return { named, halves, exclusions };
}
