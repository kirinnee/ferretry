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

import {
  type LaunchInstructionSectionId,
  type ManagedWorktreeView,
  type SessionView,
  sessionAgendaEnabled,
  sessionHypermediaEnabled,
} from '@ferretry/protocol';
import { launchedModel } from '../../components/composer-runtime.tsx';

export type InfoTab = 'overview' | 'tasks' | 'runtime' | 'usage' | 'folder' | 'signals' | 'surfaces';

export const INFO_TABS: readonly InfoTab[] = ['overview', 'tasks', 'runtime', 'usage', 'folder', 'signals', 'surfaces'];

/** The tabs a host without a board shows: Tasks is the board filtered to this ferret, so it needs one. */
export const INFO_TABS_WITHOUT_BOARD: readonly InfoTab[] = INFO_TABS.filter(tab => tab !== 'tasks');

export const INFO_TAB_LABEL: Readonly<Record<InfoTab, string>> = {
  overview: 'Overview',
  tasks: 'Tasks',
  runtime: 'Runtime',
  usage: 'Usage',
  // The id stays `folder` (links and remembered sub-tabs name it); what a person reads is Context.
  folder: 'Context',
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
  instructionFiles: 'The instruction files at the root of this ferret’s folder, which the CLI reads.',
  instructions:
    'The parts of the system prompt Ferretry added when this ferret was launched, with their sizes, and whether it may stop to ask you a question. Recorded at each launch: a switch changed since takes effect at the next one.',
  context: 'How full the model’s context window is. Near 100% the CLI compacts the conversation.',
  cost: 'What the tokens would cost at the provider’s list prices. Without known pricing it says so, never a guess.',
  quota: 'The login’s own limits. Ferretry reads them only while someone is looking, at most once a minute.',
  learning:
    'Passive learning only controls whether this ferret is instructed to file lessons with fy lesson suggest. Change it in Actions.',
  hypermedia:
    'Whether this ferret is told it may explain with diagrams, drawings, interactive pages and media in chat. A change takes effect when it next starts. Change it in Actions.',
  remoteControl:
    'Whether this Claude Code session is published to claude.ai/code and the Claude app so another device can drive it. Ferretry starts every session with it off unless it was asked for in New session › Advanced options. Takes effect at the next launch.',
  pack: 'Pack mode: whether this ferret is told it may delegate to sub-ferrets and pick the model each one runs on. The machine’s own switch and the depth limit still apply. A change takes effect at its next launch. Change it in Actions.',
  agenda:
    'Agenda mode: whether this ferret is told to keep an agenda of open items you can see in chat and the inbox. Off, it only has the short notify rule. A change takes effect at its next launch. Change it in Actions.',
} as const;

/** The CLI a harness is, in words. */
export const harnessLabel = (view: SessionView): string => (view.config.harness === 'codex' ? 'Codex' : 'Claude Code');

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
const modelStem = (model: string): string =>
  model
    .replace(/\[.*\]$/u, '')
    .trim()
    .toLocaleLowerCase();

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
  const parent = parentId === null ? null : (sessions?.find(session => session.config.id === parentId) ?? parentId);
  const children = (sessions ?? []).filter(session => session.config.parent === view.config.id);
  return { parent, children };
};

/** The Learning row's value, from the session's passive flag: said as what the ferret was told to do. */
export const learningLabel = (passive: boolean): string =>
  passive ? 'On · instructed to file lessons' : 'Off · not instructed';

/** Whether a ferret is told it may use hypermedia: its switch, else its mode's default (docs/hypermedia.md). */
export const hypermediaOn = (view: SessionView): boolean => sessionHypermediaEnabled(view.config);

/** The Hypermedia row's value: said as what the ferret is told. */
export const hypermediaLabel = (on: boolean): string =>
  on ? 'On · may explain with diagrams and media' : 'Off · plain text';

/**
 * Whether a ferret is told it may delegate to sub-ferrets (docs/pack-mode.md). ABSENT MEANS ON, as for
 * hypermedia: the machine's own switch and the depth limit still apply on top of it.
 */
export const packOn = (view: SessionView): boolean => view.config.pack !== false;

/** Whether a ferret is told to keep an agenda (docs/agenda.md). ABSENT MEANS OFF. */
export const agendaOn = (view: SessionView): boolean => sessionAgendaEnabled(view.config);

/** The Agenda mode row's value: said as what the ferret is told. */
export const agendaLabel = (on: boolean): string =>
  on ? 'On · keeps an agenda of open items' : 'Off · notify rule only';

/** Each Ferretry system-prompt section, by the name a person knows it by. */
export const LAUNCH_SECTION_LABEL: Readonly<Record<LaunchInstructionSectionId, string>> = {
  tools: 'Ferretry tools',
  settings: 'Settings rules',
  attention: 'Notify rule',
  notify: 'Notify rule',
  hypermedia: 'Hypermedia',
  pack: 'Pack mode',
  agenda: 'Agenda mode',
  learning: 'Learning',
};

/** A section's size in characters, short: "640 chars", "1.2k chars". */
export const charsLabel = (chars: number): string =>
  chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1).replace(/\.0$/u, '')}k chars`;

/** The Instructions row's facts, or `undefined` for a ferret last launched before they were recorded. */
export interface LaunchInstructionFacts {
  readonly sections: readonly { readonly id: LaunchInstructionSectionId; readonly label: string }[];
  readonly mode: 'Interactive' | 'Agent';
  readonly questions: 'Yes' | 'No';
}

/** What this ferret was told at its last launch, in words (never the prompt text — the daemon keeps none). */
export const launchInstructionFacts = (view: SessionView): LaunchInstructionFacts | undefined => {
  const launched = view.state.launchInstructions;
  if (launched === undefined) return undefined;
  return {
    sections: launched.sections.map(section => ({
      id: section.id,
      label: `${LAUNCH_SECTION_LABEL[section.id]} · ${charsLabel(section.chars)}`,
    })),
    mode: launched.mode === 'interactive' ? 'Interactive' : 'Agent',
    questions: launched.questions ? 'Yes' : 'No',
  };
};

/** The Pack mode row's value: said as what the ferret is told, and when a change lands. */
export const packLabel = (on: boolean): string => (on ? 'On · may delegate to sub-ferrets' : 'Off · works alone');

/** The Remote Control row's value: off unless the session asked for it, and not offered at all on Codex. */
export const remoteControlLabel = (view: SessionView): string => {
  if (view.config.harness === 'codex') return 'Not available on Codex';
  return view.config.remoteControl ? 'On · another device can drive this session' : 'Off';
};

/** Where a sideways-scrolling tab row should sit so the tab at `[left, left + width)` is fully shown. */
export const scrollToShow = (scrollLeft: number, left: number, width: number, view: number): number => {
  if (left < scrollLeft) return left;
  if (left + width > scrollLeft + view) return left + width - view;
  return scrollLeft;
};
