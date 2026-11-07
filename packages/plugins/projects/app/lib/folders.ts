import type { ProjectInfo } from '../../contract/index.ts';

/**
 * The last path segment: `/home/k/.config/home-manager` → `home-manager`. A path with no segment names itself.
 */
export const baseName = (path: string): string => {
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : path;
};

/**
 * How daemon-provided paths compare: trailing separators are not part of a folder's identity, so `/work/repo` and
 * `/work/repo/` are one key. A path that is only separators answers itself.
 */
export const normalizeProjectPath = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? path : trimmed;
};

/**
 * The registered project a folder belongs to: the LONGEST registered path that prefixes it, so a worktree nested
 * inside a repository files under the worktree's own project rather than the parent. `undefined` when none covers it.
 */
export const coveringProject = (folder: string, projects: readonly ProjectInfo[]): ProjectInfo | undefined => {
  const target = normalizeProjectPath(folder);
  let best: ProjectInfo | undefined;
  let bestLength = -1;
  for (const project of projects) {
    const path = normalizeProjectPath(project.path);
    if ((target === path || target.startsWith(`${path}/`)) && path.length > bestLength) {
      best = project;
      bestLength = path.length;
    }
  }
  return best;
};

/** `3m ago`, `2h ago`, `4d ago`, `now`; `—` for a missing or unparseable instant. */
export const relativeTime = (at: number | string | undefined, now: number): string => {
  if (!at) return '—';
  const timestamp = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
