/**
 * INFO — what one ferret IS, as rows a person can read and learn from. Pure.
 *
 * The header's rule (the Info / Actions spec, §1–§2): Info is for LOOKING. It opens as a right panel on a desktop and
 * a bottom sheet on a phone, with tabs, and every row is `label — value`: paths and ids in mono with a copy button,
 * and a small `?` that explains the label in one line. That is the "see and learn" half of the page.
 *
 * Every fact here has an owner elsewhere — the ferret record, the managed worktree list, the ferret list — and this
 * module owns none of them. It owns only the WORDS: which tab a fact is on, how it is said, and what its explainer
 * says. The tabs whose facts belong to other plugins (agenda, cards, usage, context, surfaces, the Warden) are drawn
 * by those plugins' own `ferret.side` panels.
 */

import type { FerretSummary } from '../../../contract/index.ts';
import type { ManagedWorktree } from './info-wire.ts';

export type InfoTab = 'overview' | 'runtime';

export const INFO_TABS: readonly InfoTab[] = ['overview', 'runtime'];

export const INFO_TAB_LABEL: Readonly<Record<InfoTab, string>> = {
  overview: 'Overview',
  runtime: 'Runtime',
};

/** The one-line explainers behind each `?`. Kept together so the words are reviewed as one glossary. */
export const INFO_HINT = {
  folder: 'The working directory the CLI was started in (its cwd).',
  worktree: 'Worktree: a separate checkout of the repo, so this ferret’s edits don’t collide with yours.',
  parent: 'Lineage: the ferret that started this one. Click a name to switch to it.',
  ferretId: 'Ferretry’s id for this ferret. It survives renames and moves.',
  login: 'The login (runtime) this ferret runs on. Its quota is shared with every ferret on it.',
  runtime: 'The runtime the ferret was started on: a login with its model and settings.',
  model: 'The model this ferret was started with.',
  mode: 'Interactive ferrets wait for you at their prompt; auto ferrets keep going on their own.',
  state: 'Where the ferret stands: starting, working, idle, or stopped (a stopped ferret can resume).',
  pack: 'The pack this ferret belongs to: ferrets started together under one label.',
  runner: 'What runs the ferret’s CLI on this machine.',
} as const;

/** The CLI a harness is, in words. */
export const harnessLabel = (ferret: FerretSummary): string => (ferret.harness === 'codex' ? 'Codex' : 'Claude Code');

/** A login only one CLI can use carries that CLI as a scope chip. */
export const loginScope = (ferret: FerretSummary): string =>
  ferret.harness === 'codex' ? 'Codex-only' : 'Claude-only';

/** The state, in the person's words. */
export const STATE_WORD: Readonly<Record<FerretSummary['state'], string>> = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
};

export type WorktreeFact =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'main' }
  | {
      readonly kind: 'worktree';
      readonly path: string;
      readonly branch: string;
      /** The checkout has uncommitted changes. Null when Git's answer did not say. */
      readonly dirty: boolean | null;
    };

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * Which managed worktree this ferret works in: the deepest one containing its folder. A folder in no
 * managed worktree is the main checkout. An unread list is `unknown`, never "main checkout".
 */
export const worktreeFact = (ferret: FerretSummary, worktrees: readonly ManagedWorktree[] | null): WorktreeFact => {
  if (worktrees === null) return { kind: 'unknown' };
  const match = worktrees
    .filter(tree => tree.removedAt === undefined && within(ferret.folder, tree.path))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (match === undefined) return { kind: 'main' };
  const status = match.live?.status;
  return {
    kind: 'worktree',
    path: match.path,
    branch: match.live?.branch ?? match.branch,
    dirty: status === undefined ? null : status.staged || status.unstaged || status.untracked || status.conflicted,
  };
};

/** The ferret's lineage: the parent it came from and the children it started, among the ferrets read. */
export const lineage = (
  ferret: FerretSummary,
  ferrets: readonly FerretSummary[] | undefined,
): { readonly parent: FerretSummary | string | null; readonly children: readonly FerretSummary[] } => {
  const parentId = ferret.parent ?? null;
  const parent = parentId === null ? null : (ferrets?.find(other => other.id === parentId) ?? parentId);
  const children = (ferrets ?? [])
    .filter(other => other.parent === ferret.id && other.id !== ferret.id)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { parent, children };
};

/** The project row's value: the board project's id, or nothing for a ferret on no project. */
export const projectFact = (ferret: FerretSummary): string | null =>
  ferret.projectId === undefined || ferret.projectId === 'unfiled' ? null : ferret.projectId;

/** Where a sideways-scrolling tab row should sit so the tab at `[left, left + width)` is fully shown. */
export const scrollToShow = (scrollLeft: number, left: number, width: number, view: number): number => {
  if (left < scrollLeft) return left;
  if (left + width > scrollLeft + view) return left + width - view;
  return scrollLeft;
};

/** A failure in words a person can read: a raw parse dump says nothing to them. */
export const readableReason = (reason: string): string =>
  reason.length > 160 || /^\s*[[{]/u.test(reason) ? 'the daemon answered with something this page cannot read' : reason;

/** How long ago, in the short form a row reads: `now`, `5m ago`, `3h ago`, `2d ago`; `—` when unknown. */
export const relativeTime = (at: number | string | undefined, now = globalThis.Date.now()): string => {
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
