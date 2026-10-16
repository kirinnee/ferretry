/**
 * INFO — what one ferret IS, as rows a person can read and learn from. Pure.
 *
 * The session header's rule (the Info / Actions spec, §1–§2): Info is for LOOKING. It opens as a
 * resizable right panel on a desktop and a bottom sheet on a phone, with six tabs, and every row is
 * `label — value`: paths and ids in mono with a copy button, and a small `?` that explains the label
 * in one line ("Worktree: a separate checkout…"). That is the "see and learn" half of the page.
 *
 * Every fact here has an owner elsewhere — the session view, the managed worktree list, the fleet's
 * runtimes, the usage feed, the analytics read — and this module owns none of them. It owns only the
 * WORDS: which tab a fact is on, how it is said, and what its explainer says.
 */

import type { ManagedWorktreeView, SessionView } from '@ferretry/protocol';
import { launchedModel } from '../../components/composer-runtime.tsx';

export type InfoTab = 'overview' | 'runtime' | 'usage' | 'folder' | 'signals' | 'surfaces';

export const INFO_TABS: readonly InfoTab[] = ['overview', 'runtime', 'usage', 'folder', 'signals', 'surfaces'];

export const INFO_TAB_LABEL: Readonly<Record<InfoTab, string>> = {
  overview: 'Overview',
  runtime: 'Runtime',
  usage: 'Usage',
  folder: 'Folder',
  signals: 'Signals',
  surfaces: 'Surfaces',
};

/** The one-line explainers behind each `?`. Kept together so the words are reviewed as one glossary. */
export const INFO_HINT = {
  folder: 'The working directory the CLI was started in (its cwd).',
  worktree: 'Worktree: a separate checkout of the repo, so this ferret’s edits don’t collide with yours.',
  parent: 'Lineage: the ferret that forked or spawned this one. Click a name to switch to it.',
  sessionId: 'Ferretry’s id for this ferret. It survives renames and moves.',
  login: 'The login (runtime) this ferret runs on. Its quota is shared with every ferret on it.',
  model:
    'What was asked for, and what the CLI reports it is actually answering with. They differ when a request was declined or a fallback kicked in.',
  modelMismatch:
    'The CLI reported a different model than was requested — usually a fallback when the requested model is out of quota.',
  effort: 'How hard the model thinks before it answers. “default” is the CLI’s own setting.',
  mode: 'Interactive ferrets wait for you at their prompt; auto ferrets keep going on their own.',
  ferretryTools:
    'Ferretry’s own MCP server, which lets this ferret use the controls you allowed (Settings › Agent controls).',
  instructions: 'The instruction files at the root of this ferret’s folder, which the CLI reads.',
  context: 'How full the model’s context window is. Near 100% the CLI compacts the conversation.',
  cost: 'What the tokens would cost at the provider’s list prices. Without known pricing it says so, never a guess.',
  quota: 'The login’s own limits. Ferretry reads them only while someone is looking, at most once a minute.',
} as const;

/** The CLI a harness is, in words. */
export const harnessLabel = (view: SessionView): string =>
  view.config.harness === 'codex' ? 'Codex' : 'Claude Code';

/** A login only one CLI can use carries that CLI as a scope chip. */
export const loginScope = (view: SessionView): string =>
  view.config.harness === 'codex' ? 'Codex-only' : 'Claude-only';

export interface ModelFacts {
  /** What was asked for: the session's own model, else its launch hint. Null when neither is known. */
  readonly requested: string | null;
  /** What the CLI reports it is using. Null before it has said. */
  readonly observed: string | null;
  /** Both are known and they name different models. */
  readonly mismatch: boolean;
}

/** Strips a context-window or variant suffix (`[1m]`) and case, so a variant is not called a mismatch. */
const modelStem = (model: string): string => model.replace(/\[.*\]$/u, '').trim().toLocaleLowerCase();

/**
 * Requested (the model it was LAUNCHED on: an operator --model flag, else the resolved model — the
 * composer chip's own rule) vs observed, with a mismatch flagged only when both are known and genuinely differ: an
 * observed `claude-opus-4-5-20251101` matches a requested `opus` alias, because the alias is
 * contained in it.
 */
export const modelFacts = (view: SessionView): ModelFacts => {
  const requested = launchedModel(view.config) ?? null;
  const observed = view.state.observedModel ?? null;
  if (requested === null || observed === null) return { requested, observed, mismatch: false };
  const asked = modelStem(requested);
  const seen = modelStem(observed);
  return { requested, observed, mismatch: !(seen.includes(asked) || asked.includes(seen)) };
};

/** The effort the CLI reports, else the level it was launched with, else the CLI's own default. */
export const effortLabel = (view: SessionView): string =>
  view.state.observedReasoningEffort ?? view.config.launchReasoningEffort ?? 'default';

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
export const worktreeFact = (view: SessionView, worktrees: readonly ManagedWorktreeView[] | null): WorktreeFact => {
  if (worktrees === null) return { kind: 'unknown' };
  const match = worktrees
    .filter(tree => tree.removedAt === undefined && within(view.config.cwd, tree.path))
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

/** The ferret's lineage: the parent it came from and the children it started, among the sessions read. */
export const lineage = (
  view: SessionView,
  sessions: readonly SessionView[] | undefined,
): { readonly parent: SessionView | string | null; readonly children: readonly SessionView[] } => {
  const parentId = view.config.parent ?? null;
  const parent =
    parentId === null ? null : (sessions?.find(session => session.config.id === parentId) ?? parentId);
  const children = (sessions ?? []).filter(session => session.config.parent === view.config.id);
  return { parent, children };
};

/** A token count the way a person reads one: 812, 12.4k, 3.1M. */
export const formatTokens = (count: number): string =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1_000
      ? `${(count / 1_000).toFixed(1)}k`
      : String(Math.round(count));

/** Micro-dollars as a price: $0.42, $12.30, <$0.01. */
export const formatUsd = (micros: number): string => {
  const dollars = micros / 1_000_000;
  if (dollars > 0 && dollars < 0.01) return '<$0.01';
  return `$${dollars.toFixed(2)}`;
};
