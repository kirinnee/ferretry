import { baseName, coveringProject, normalizeProjectPath } from './folders.ts';
import type { ProjectInfo } from '../../contract/index.ts';

/** The one thing this half reads of a ferret: the folder it was started in, and when it last changed state. */
export interface FerretFolder {
  readonly folder: string;
  readonly stateAt: string;
}

/**
 * A folder a ferret used that no registered project covers. It carries no registry `id`: nothing about a recent path
 * has been declared, and giving its shape a slot for one would let a caller treat it as declared by accident.
 */
export interface RecentProjectOption {
  readonly kind: 'recent';
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly lastActivity: string;
}

/**
 * Recently used folders, newest first and deduplicated by path, with anything already covered by a registered project
 * folded away (the longest-prefix rule `coveringProject` applies everywhere). `null` when the ferret list is unread:
 * "recent" is a claim about ferrets this cannot support without reading them. An unread registry folds against no
 * known projects, so nothing is folded rather than guessed.
 */
export const discoveriesFrom = (
  ferrets: readonly FerretFolder[] | null,
  registry: readonly ProjectInfo[] | null,
): readonly RecentProjectOption[] | null => {
  if (ferrets === null) return null;
  const known = registry ?? [];
  const newest = new Map<string, string>();
  for (const ferret of ferrets) {
    const path = normalizeProjectPath(ferret.folder.trim());
    if (path === '') continue;
    const previous = newest.get(path);
    if (previous === undefined || Date.parse(ferret.stateAt) > Date.parse(previous)) newest.set(path, ferret.stateAt);
  }
  return [...newest.entries()]
    .map(([path, lastActivity]) => ({ path, lastActivity }))
    .sort((left, right) => {
      const recency = Date.parse(right.lastActivity) - Date.parse(left.lastActivity);
      return recency === 0 ? left.path.localeCompare(right.path) : recency;
    })
    .filter(entry => coveringProject(entry.path, known) === undefined)
    .map(entry => ({
      kind: 'recent' as const,
      key: entry.path,
      name: baseName(entry.path),
      path: entry.path,
      lastActivity: entry.lastActivity,
    }));
};
