/**
 * THE SESSION WORKSPACE LAYOUT — a pure split tree of tabbed panes.
 *
 * A session page is one or more PANES, each with its own tab strip. Panes are
 * arranged by a binary split tree: a leaf is a pane, a node splits its two
 * children side by side (`row`) or stacked (`column`) at a ratio. The number of
 * panes is capped by `maxPanes` (default 2). The cap is an ARGUMENT, not a
 * constant baked into the shape, so allowing more panes later is a setting
 * change rather than a rewrite.
 *
 * THE AGENT PANE. The tree's first leaf is always the agent pane (`AGENT_PANE_ID`).
 * It holds exactly the two pinned agent tabs — Chat and the agent's own CLI
 * (`console`) — which can never be closed, dragged out, or joined by a workspace
 * tab. Everything else (terminals, browsers, files) is a WORKSPACE tab, living in
 * a workspace pane. The invariant the operations keep:
 *
 *     root = agent leaf                                (workspace hidden)
 *     root = split(agent leaf, workspace subtree)      (workspace shown)
 *
 * Hiding the workspace (the single ⫼ toggle) PARKS the workspace subtree instead
 * of dropping it, so showing it again restores the same panes, tabs and sizes.
 *
 * TAB IDENTITY reuses the side-pane instance convention (`terminal:<key>`,
 * `browser:<key>`, `file:<path>`) from `side-pane-tab-model.ts`; there is one
 * grammar for "which terminal is this", not two.
 *
 * Every operation is TOTAL: it returns a new layout, or the very same layout
 * object when the request does not apply (unknown pane, pinned tab, cap reached,
 * malformed input). Callers may compare by identity to learn "nothing changed".
 */

import {
  parseSidePaneInstanceTabId,
  type SidePaneInstanceKind,
  sidePaneInstanceTabId,
} from '../shell/side-pane-tab-model.ts';

// ---- identity ------------------------------------------------------------------

export type WorkspaceTabId = string;
export type WorkspaceAgentTabKind = 'chat' | 'console' | 'processes';
export type WorkspaceTabKind = WorkspaceAgentTabKind | SidePaneInstanceKind;

export const WORKSPACE_CHAT_TAB_ID: WorkspaceTabId = 'chat';
export const WORKSPACE_CONSOLE_TAB_ID: WorkspaceTabId = 'console';
export const WORKSPACE_PROCESSES_TAB_ID: WorkspaceTabId = 'processes';
export const AGENT_PANE_ID = 'agent';
/** The id of the split joining the agent pane to the workspace subtree. */
export const WORKSPACE_ROOT_SPLIT_ID = 'root';
export const WORKSPACE_DEFAULT_MAX_PANES = 2;
export const WORKSPACE_DEFAULT_RATIO = 0.5;
/** Neither side of a split may shrink below this share of it. */
export const WORKSPACE_MIN_RATIO = 0.15;
export const WORKSPACE_LAYOUT_VERSION = 1;
export const WORKSPACE_ANNOUNCED_LIMIT = 200;

/** One tab's record. `key` is the kind-scoped identity (terminal key, page key,
 *  file path); the agent tabs use their kind as their key. */
export interface WorkspaceTab {
  readonly id: WorkspaceTabId;
  readonly kind: WorkspaceTabKind;
  readonly key: string;
  /** Short strip label (basename, page host, terminal name). */
  readonly label: string;
  /** Full path / URL / name — the hover title and accessible description. */
  readonly title: string;
}

export type WorkspaceSplitDirection = 'row' | 'column';

export interface WorkspacePaneNode {
  readonly type: 'pane';
  readonly id: string;
  readonly tabs: readonly WorkspaceTabId[];
  /** The selected tab, or null for an empty pane. */
  readonly active: WorkspaceTabId | null;
}

export interface WorkspaceSplitNode {
  readonly type: 'split';
  readonly id: string;
  readonly direction: WorkspaceSplitDirection;
  /** The first child's share of the split, 0..1. */
  readonly ratio: number;
  readonly children: readonly [WorkspaceNode, WorkspaceNode];
}

export type WorkspaceNode = WorkspacePaneNode | WorkspaceSplitNode;

/** The hidden workspace subtree and the root split it was attached by. */
export interface ParkedWorkspace {
  readonly direction: WorkspaceSplitDirection;
  readonly ratio: number;
  readonly node: WorkspaceNode;
}

export interface WorkspaceLayout {
  readonly v: typeof WORKSPACE_LAYOUT_VERSION;
  readonly root: WorkspaceNode;
  readonly parked: ParkedWorkspace | null;
  /** Every open tab's record, the agent tabs included. */
  readonly tabs: Readonly<Record<WorkspaceTabId, WorkspaceTab>>;
  /** The pane that last took focus — the phone shows its active tab. */
  readonly focused: string;
  /** Monotonic id counter for new panes and splits. */
  readonly seq: number;
  /**
   * What the workspace has already done on an agent's behalf — a tab it added for a surface the agent
   * opened, an ask it brought forward — so each happens ONCE, and a tab the owner closed stays closed.
   * Not structure: omitted while empty, capped, and never read by the tree operations.
   */
  readonly announced?: readonly string[];
}

export interface WorkspaceCapOptions {
  readonly maxPanes?: number;
}

const AGENT_TABS: readonly WorkspaceTab[] = [
  { id: WORKSPACE_CHAT_TAB_ID, kind: 'chat', key: 'chat', label: 'Chat', title: 'Chat with the agent' },
  {
    id: WORKSPACE_CONSOLE_TAB_ID,
    kind: 'console',
    key: 'console',
    label: 'Console',
    title: "The agent's own CLI, live",
  },
  {
    id: WORKSPACE_PROCESSES_TAB_ID,
    kind: 'processes',
    key: 'processes',
    label: 'Processes',
    title: 'What is running under this agent',
  },
];

const AGENT_TAB_IDS: readonly WorkspaceTabId[] = AGENT_TABS.map(tab => tab.id);

export const isAgentTabId = (id: WorkspaceTabId): boolean => AGENT_TAB_IDS.includes(id);

const lastSegment = (value: string): string => {
  const parts = value.split('/').filter(part => part !== '');
  return parts[parts.length - 1] ?? value;
};

/** Builds a workspace tab record with the canonical id for its kind and key. */
export const workspaceTab = (
  kind: SidePaneInstanceKind,
  key: string,
  options: { readonly label?: string; readonly title?: string } = {},
): WorkspaceTab => ({
  id: sidePaneInstanceTabId(kind, key),
  kind,
  key,
  label: options.label ?? (kind === 'file' ? lastSegment(key) : key),
  title: options.title ?? key,
});

/** A fresh layout: the agent pane alone, Chat selected, workspace hidden. */
export const defaultWorkspaceLayout = (): WorkspaceLayout => ({
  v: WORKSPACE_LAYOUT_VERSION,
  root: { type: 'pane', id: AGENT_PANE_ID, tabs: AGENT_TAB_IDS, active: WORKSPACE_CHAT_TAB_ID },
  parked: null,
  tabs: Object.fromEntries(AGENT_TABS.map(tab => [tab.id, tab])),
  focused: AGENT_PANE_ID,
  seq: 0,
});

// ---- tree helpers ----------------------------------------------------------------

/** Leaves in reading order (left-to-right, top-to-bottom). */
export const workspacePanes = (node: WorkspaceNode): readonly WorkspacePaneNode[] =>
  node.type === 'pane' ? [node] : [...workspacePanes(node.children[0]), ...workspacePanes(node.children[1])];

const findPane = (node: WorkspaceNode, id: string): WorkspacePaneNode | undefined =>
  workspacePanes(node).find(pane => pane.id === id);

const findSplit = (node: WorkspaceNode, id: string): WorkspaceSplitNode | undefined => {
  if (node.type === 'pane') return undefined;
  if (node.id === id) return node;
  return findSplit(node.children[0], id) ?? findSplit(node.children[1], id);
};

const paneHolding = (node: WorkspaceNode, tabId: WorkspaceTabId): WorkspacePaneNode | undefined =>
  workspacePanes(node).find(pane => pane.tabs.includes(tabId));

const mapNode = (node: WorkspaceNode, fn: (node: WorkspaceNode) => WorkspaceNode): WorkspaceNode => {
  const mapped = fn(node);
  if (mapped !== node || node.type === 'pane') return mapped;
  const first = mapNode(node.children[0], fn);
  const second = mapNode(node.children[1], fn);
  return first === node.children[0] && second === node.children[1] ? node : { ...node, children: [first, second] };
};

const replacePane = (node: WorkspaceNode, pane: WorkspacePaneNode): WorkspaceNode =>
  mapNode(node, current => (current.type === 'pane' && current.id === pane.id ? pane : current));

/** Removes a leaf; its parent split collapses into the surviving sibling. */
const removePane = (node: WorkspaceNode, id: string): WorkspaceNode | null => {
  if (node.type === 'pane') return node.id === id ? null : node;
  const first = removePane(node.children[0], id);
  const second = removePane(node.children[1], id);
  if (first === null) return second;
  if (second === null) return first;
  return first === node.children[0] && second === node.children[1] ? node : { ...node, children: [first, second] };
};

const workspaceSubtree = (layout: WorkspaceLayout): WorkspaceNode | null =>
  layout.root.type === 'split' ? layout.root.children[1] : null;

const agentPane = (layout: WorkspaceLayout): WorkspacePaneNode => workspacePanes(layout.root)[0] as WorkspacePaneNode;

/** Whether the workspace (non-agent) side of the layout is on screen. */
export const isWorkspaceVisible = (layout: WorkspaceLayout): boolean => layout.root.type === 'split';

/** The pane a strip renders for, or undefined. Only visible panes are found. */
export const workspacePane = (layout: WorkspaceLayout, paneId: string): WorkspacePaneNode | undefined =>
  findPane(layout.root, paneId);

const withTabs = (pane: WorkspacePaneNode, tabs: readonly WorkspaceTabId[], active: WorkspaceTabId | null) => ({
  ...pane,
  tabs,
  active,
});

/** After removing `removed` at `index`, the neighbour that takes selection. */
const activeAfterRemoval = (
  pane: WorkspacePaneNode,
  remaining: readonly WorkspaceTabId[],
  index: number,
): WorkspaceTabId | null => {
  if (pane.active !== pane.tabs[index]) return pane.active;
  return remaining[Math.min(index, remaining.length - 1)] ?? null;
};

/** Removes `tabId` from whichever pane in `node` holds it; an emptied pane goes
 *  too, unless it is the agent pane. Returns null when the whole subtree empties. */
const removeTabFrom = (node: WorkspaceNode, tabId: WorkspaceTabId): WorkspaceNode | null => {
  const pane = paneHolding(node, tabId);
  if (!pane) return node;
  const index = pane.tabs.indexOf(tabId);
  const remaining = pane.tabs.filter(id => id !== tabId);
  if (remaining.length === 0 && pane.id !== AGENT_PANE_ID) return removePane(node, pane.id);
  return replacePane(node, withTabs(pane, remaining, activeAfterRemoval(pane, remaining, index)));
};

const nextId = (layout: WorkspaceLayout, prefix: string): [string, number] => {
  const seq = layout.seq + 1;
  return [`${prefix}-${seq}`, seq];
};

/** Keep `focused` naming a visible pane; fall back to the agent pane. */
const refocus = (layout: WorkspaceLayout): WorkspaceLayout =>
  findPane(layout.root, layout.focused) ? layout : { ...layout, focused: AGENT_PANE_ID };

const withWorkspace = (layout: WorkspaceLayout, workspace: WorkspaceNode | null): WorkspaceLayout => {
  const root = layout.root;
  // Callers only hand a workspace subtree back to a layout that already shows one.
  if (workspace === null || root.type !== 'split') return refocus({ ...layout, root: agentPane(layout) });
  return refocus({ ...layout, root: { ...root, children: [root.children[0], workspace] } });
};

// ---- show / hide -------------------------------------------------------------------

const showWorkspace = (layout: WorkspaceLayout): WorkspaceLayout => {
  if (isWorkspaceVisible(layout)) return layout;
  const agent = agentPane(layout);
  if (layout.parked) {
    const { direction, ratio, node } = layout.parked;
    return {
      ...layout,
      parked: null,
      root: { type: 'split', id: WORKSPACE_ROOT_SPLIT_ID, direction, ratio, children: [agent, node] },
    };
  }
  const [id, seq] = nextId(layout, 'pane');
  return {
    ...layout,
    seq,
    root: {
      type: 'split',
      id: WORKSPACE_ROOT_SPLIT_ID,
      direction: 'row',
      ratio: WORKSPACE_DEFAULT_RATIO,
      children: [agent, { type: 'pane', id, tabs: [], active: null }],
    },
  };
};

const hideWorkspace = (layout: WorkspaceLayout): WorkspaceLayout => {
  const root = layout.root;
  if (root.type !== 'split') return layout;
  return refocus({
    ...layout,
    root: root.children[0],
    parked: { direction: root.direction, ratio: root.ratio, node: root.children[1] },
  });
};

/** The single ⫼ control: show the workspace pane(s), or hide them while
 *  remembering their tabs and sizes so the next show restores them. */
export const toggleWorkspacePane = (layout: WorkspaceLayout): WorkspaceLayout =>
  isWorkspaceVisible(layout) ? hideWorkspace(layout) : showWorkspace(layout);

// ---- tab operations -----------------------------------------------------------------

/** Marks a visible pane as the one the reader is working in. */
export const focusWorkspacePane = (layout: WorkspaceLayout, paneId: string): WorkspaceLayout =>
  layout.focused === paneId || !findPane(layout.root, paneId) ? layout : { ...layout, focused: paneId };

/** Selects a tab wherever it lives, revealing the workspace if it was parked. */
export const activateWorkspaceTab = (layout: WorkspaceLayout, tabId: WorkspaceTabId): WorkspaceLayout => {
  const parkedHolds = layout.parked !== null && paneHolding(layout.parked.node, tabId) !== undefined;
  const shown = parkedHolds ? showWorkspace(layout) : layout;
  const pane = paneHolding(shown.root, tabId);
  if (!pane) return layout;
  if (pane.active === tabId && shown.focused === pane.id && shown === layout) return layout;
  return { ...shown, root: replacePane(shown.root, { ...pane, active: tabId }), focused: pane.id };
};

const isWellFormedTab = (tab: WorkspaceTab): boolean => {
  if (isAgentTabId(tab.id)) return tab.kind === tab.id;
  const parsed = parseSidePaneInstanceTabId(tab.id);
  return parsed !== null && parsed.kind === tab.kind && parsed.key === tab.key;
};

/** The workspace pane a new tab lands in: the requested one, else the focused
 *  workspace pane, else the first workspace pane. */
const targetPane = (layout: WorkspaceLayout, paneId: string | undefined): WorkspacePaneNode | undefined => {
  const workspace = workspaceSubtree(layout);
  if (!workspace) return undefined;
  const requested = paneId === undefined ? undefined : findPane(workspace, paneId);
  return requested ?? findPane(workspace, layout.focused) ?? workspacePanes(workspace)[0];
};

/**
 * Opens a tab, or focuses it if it is already open anywhere (a parked tab
 * reveals the workspace). A reopened tab takes the fresh label and title. New
 * workspace tabs never land in the agent pane: they go to `paneId` when that is
 * a workspace pane, else the focused workspace pane, showing the workspace
 * first when it is hidden.
 */
export const openWorkspaceTab = (
  layout: WorkspaceLayout,
  tab: WorkspaceTab,
  options: { readonly paneId?: string } = {},
): WorkspaceLayout => {
  if (!isWellFormedTab(tab)) return layout;
  const known = layout.tabs[tab.id];
  if (known) {
    const relabelled =
      known.label === tab.label && known.title === tab.title
        ? layout
        : { ...layout, tabs: { ...layout.tabs, [tab.id]: tab } };
    return activateWorkspaceTab(relabelled, tab.id);
  }
  const shown = showWorkspace(layout);
  const pane = targetPane(shown, options.paneId) as WorkspacePaneNode;
  return {
    ...shown,
    root: replacePane(shown.root, withTabs(pane, [...pane.tabs, tab.id], tab.id)),
    tabs: { ...shown.tabs, [tab.id]: tab },
    focused: pane.id,
  };
};

// ---- agent-opened surfaces -----------------------------------------------------------

/** Has the workspace already acted on this announcement? */
export const hasAnnounced = (layout: WorkspaceLayout, announcement: string): boolean =>
  (layout.announced ?? []).includes(announcement);

/** Remembers an announcement, the oldest forgotten past the cap. */
export const markAnnounced = (layout: WorkspaceLayout, announcement: string): WorkspaceLayout =>
  hasAnnounced(layout, announcement)
    ? layout
    : { ...layout, announced: [...(layout.announced ?? []), announcement].slice(-WORKSPACE_ANNOUNCED_LIMIT) };

/** The tab, among the ids that all name the one surface, that is already open. */
const openAmong = (layout: WorkspaceLayout, ids: readonly WorkspaceTabId[]): WorkspaceTabId | undefined =>
  ids.find(id => layout.tabs[id] !== undefined);

/**
 * An agent opened a surface: its tab appears in the workspace, ONCE, and nothing the owner is doing moves.
 * The workspace is shown if it was hidden; the tab joins the focused workspace pane and becomes that
 * pane's active tab only when the pane had none. The focused pane never changes, and neither does any
 * tab already selected, so the owner's typing and reading are not interrupted. An announcement already
 * made is a no-op, which is what keeps a tab the owner closed from coming back. `aliases` are the other
 * ids the same surface may already be open under (a browser page by id or by name).
 */
export const adoptAgentSurface = (
  layout: WorkspaceLayout,
  tab: WorkspaceTab,
  announcement: string,
  aliases: readonly WorkspaceTabId[] = [],
): WorkspaceLayout => {
  if (!isWellFormedTab(tab) || isAgentTabId(tab.id) || hasAnnounced(layout, announcement)) return layout;
  const marked = markAnnounced(layout, announcement);
  if (openAmong(marked, [tab.id, ...aliases]) !== undefined) return marked;
  const shown = showWorkspace(marked);
  const pane = targetPane(shown, undefined) as WorkspacePaneNode;
  return {
    ...shown,
    root: replacePane(shown.root, withTabs(pane, [...pane.tabs, tab.id], pane.active ?? tab.id)),
    tabs: { ...shown.tabs, [tab.id]: tab },
  };
};

/**
 * An agent handed a surface to the owner: switch to its tab and focus it — opening it first when the owner
 * closed it, or never had it. Once per ask: the announcement names the ask, so a reload, or the same ask
 * arriving by poll and by event, does not pull the owner back after they have moved on.
 */
export const bringAskedSurfaceForward = (
  layout: WorkspaceLayout,
  tab: WorkspaceTab,
  announcement: string,
  aliases: readonly WorkspaceTabId[] = [],
): WorkspaceLayout => {
  if (!isWellFormedTab(tab) || isAgentTabId(tab.id) || hasAnnounced(layout, announcement)) return layout;
  const marked = markAnnounced(layout, announcement);
  const open = openAmong(marked, [tab.id, ...aliases]);
  return open === undefined ? openWorkspaceTab(marked, tab) : activateWorkspaceTab(marked, open);
};

/** Closes a workspace tab. Pinned agent tabs never close. A workspace pane
 *  left empty collapses; a parked tab closes without revealing anything. */
export const closeWorkspaceTab = (layout: WorkspaceLayout, tabId: WorkspaceTabId): WorkspaceLayout => {
  if (isAgentTabId(tabId) || !layout.tabs[tabId]) return layout;
  const { [tabId]: _closed, ...tabs } = layout.tabs;
  const parkedNode = layout.parked ? removeTabFrom(layout.parked.node, tabId) : null;
  const parked = layout.parked && parkedNode ? { ...layout.parked, node: parkedNode } : null;
  const workspace = workspaceSubtree(layout);
  const nextWorkspace = workspace ? removeTabFrom(workspace, tabId) : null;
  return withWorkspace({ ...layout, tabs, parked }, nextWorkspace);
};

/**
 * Drags a workspace tab to `toPaneId` at `index` (default: the end). Within one
 * pane this reorders. Moving the last tab out of a workspace pane collapses that
 * pane. Agent tabs never move, nothing moves INTO the agent pane, and only
 * visible panes take part.
 */
export const moveWorkspaceTab = (
  layout: WorkspaceLayout,
  tabId: WorkspaceTabId,
  toPaneId: string,
  index?: number,
): WorkspaceLayout => {
  const workspace = workspaceSubtree(layout);
  if (isAgentTabId(tabId) || !workspace) return layout;
  const source = paneHolding(workspace, tabId);
  const target = findPane(workspace, toPaneId);
  if (!source || !target) return layout;
  const clamp = (list: readonly WorkspaceTabId[]) =>
    index === undefined || !Number.isFinite(index)
      ? list.length
      : Math.max(0, Math.min(list.length, Math.trunc(index)));
  if (source.id === target.id) {
    const rest = source.tabs.filter(id => id !== tabId);
    const at = clamp(rest);
    const tabs = [...rest.slice(0, at), tabId, ...rest.slice(at)];
    if (tabs.every((id, i) => id === source.tabs[i]) && source.active === tabId && layout.focused === source.id)
      return layout;
    return { ...layout, root: replacePane(layout.root, withTabs(source, tabs, tabId)), focused: source.id };
  }
  const without = removeTabFrom(workspace, tabId) as WorkspaceNode;
  const landing = findPane(without, toPaneId) as WorkspacePaneNode;
  const at = clamp(landing.tabs);
  const moved = replacePane(
    without,
    withTabs(landing, [...landing.tabs.slice(0, at), tabId, ...landing.tabs.slice(at)], tabId),
  );
  return { ...withWorkspace(layout, moved), focused: landing.id };
};

/** Whether `paneId` may split under the cap: a visible workspace pane holding
 *  at least two tabs (one stays, one moves). */
export const canSplitWorkspacePane = (
  layout: WorkspaceLayout,
  paneId: string,
  options: WorkspaceCapOptions = {},
): boolean => {
  const maxPanes = options.maxPanes ?? WORKSPACE_DEFAULT_MAX_PANES;
  const workspace = workspaceSubtree(layout);
  const pane = workspace ? findPane(workspace, paneId) : undefined;
  return pane !== undefined && pane.tabs.length >= 2 && workspacePanes(layout.root).length < maxPanes;
};

/**
 * Splits a workspace pane in `direction`, moving `tabId` (default: the active
 * tab) into the new pane after it. Refused — the layout comes back unchanged —
 * for the agent pane, an unknown pane, a pane with a single tab, or when the
 * cap is reached.
 */
export const splitWorkspacePane = (
  layout: WorkspaceLayout,
  paneId: string,
  direction: WorkspaceSplitDirection,
  tabId?: WorkspaceTabId,
  options: WorkspaceCapOptions = {},
): WorkspaceLayout => {
  if (!canSplitWorkspacePane(layout, paneId, options)) return layout;
  const pane = findPane(layout.root, paneId) as WorkspacePaneNode;
  const moving = tabId ?? pane.active;
  if (moving === null || !pane.tabs.includes(moving)) return layout;
  const [newPaneId, paneSeq] = nextId(layout, 'pane');
  const [splitId, seq] = nextId({ ...layout, seq: paneSeq }, 'split');
  const remaining = pane.tabs.filter(id => id !== moving);
  const index = pane.tabs.indexOf(moving);
  const split: WorkspaceSplitNode = {
    type: 'split',
    id: splitId,
    direction,
    ratio: WORKSPACE_DEFAULT_RATIO,
    children: [
      withTabs(pane, remaining, activeAfterRemoval(pane, remaining, index)),
      { type: 'pane', id: newPaneId, tabs: [moving], active: moving },
    ],
  };
  return {
    ...layout,
    seq,
    root: mapNode(layout.root, node => (node.type === 'pane' && node.id === paneId ? split : node)),
    focused: newPaneId,
  };
};

/** Flips a visible split between side by side and stacked. */
export const setWorkspaceSplitDirection = (
  layout: WorkspaceLayout,
  splitId: string,
  direction: WorkspaceSplitDirection,
): WorkspaceLayout => {
  const split = findSplit(layout.root, splitId);
  if (!split || split.direction === direction) return layout;
  return { ...layout, root: mapNode(layout.root, node => (node === split ? { ...split, direction } : node)) };
};

/** Clamps a ratio so both sides keep `minRatio` (capped at an even split). */
export const clampWorkspaceRatio = (ratio: number, minRatio = WORKSPACE_MIN_RATIO): number => {
  const min = Math.min(0.5, Math.max(0, minRatio));
  return Math.min(1 - min, Math.max(min, ratio));
};

/**
 * Commits a divider position. `minRatio` lets the view express a pixel
 * minimum (`minPanePx / containerPx`). Non-finite input is ignored.
 */
export const setWorkspaceRatio = (
  layout: WorkspaceLayout,
  splitId: string,
  ratio: number,
  minRatio = WORKSPACE_MIN_RATIO,
): WorkspaceLayout => {
  const split = findSplit(layout.root, splitId);
  if (!split || !Number.isFinite(ratio) || !Number.isFinite(minRatio)) return layout;
  const clamped = clampWorkspaceRatio(ratio, minRatio);
  if (clamped === split.ratio) return layout;
  return { ...layout, root: mapNode(layout.root, node => (node === split ? { ...split, ratio: clamped } : node)) };
};

/** The divider's double-click: back to an even split. */
export const resetWorkspaceRatio = (layout: WorkspaceLayout, splitId: string): WorkspaceLayout =>
  setWorkspaceRatio(layout, splitId, WORKSPACE_DEFAULT_RATIO);

// ---- reading ---------------------------------------------------------------------

/**
 * Every tab in one row, for the phone chip row: Chat, Console, then every
 * workspace tab in pane reading order — parked tabs included, because a phone
 * has no split to hide them behind.
 */
export const visibleTabsInOrder = (layout: WorkspaceLayout): readonly WorkspaceTab[] => {
  const nodes = layout.parked ? [layout.root, layout.parked.node] : [layout.root];
  return nodes
    .flatMap(node => workspacePanes(node))
    .flatMap(pane => pane.tabs)
    .map(id => layout.tabs[id])
    .filter((tab): tab is WorkspaceTab => tab !== undefined);
};

/** The one tab the phone shows: the focused pane's selection. */
export const focusedWorkspaceTab = (layout: WorkspaceLayout): WorkspaceTabId => {
  const pane = findPane(layout.root, layout.focused) ?? agentPane(layout);
  return pane.active ?? (agentPane(layout).active as WorkspaceTabId);
};

/** A `%terminal:` / `%browser:` / `@file` chip's target. */
export interface WorkspaceReferenceTarget {
  readonly kind: SidePaneInstanceKind;
  readonly key: string;
  readonly label?: string;
  readonly title?: string;
}

/**
 * Jump to a referenced tab: focus it if it is open (revealing a parked one),
 * otherwise open it in the workspace pane, showing that pane if it is hidden.
 */
export const jumpToWorkspaceReference = (
  layout: WorkspaceLayout,
  target: WorkspaceReferenceTarget,
): WorkspaceLayout => {
  const id = sidePaneInstanceTabId(target.kind, target.key);
  if (layout.tabs[id] && target.label === undefined && target.title === undefined) {
    return activateWorkspaceTab(layout, id);
  }
  const options = {
    ...(target.label === undefined ? {} : { label: target.label }),
    ...(target.title === undefined ? {} : { title: target.title }),
  };
  return openWorkspaceTab(layout, workspaceTab(target.kind, target.key, options));
};

// ---- persistence -------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseTab = (id: string, value: unknown): WorkspaceTab | null => {
  if (!isRecord(value)) return null;
  const { kind, key, label, title } = value;
  if (typeof kind !== 'string' || typeof key !== 'string' || typeof label !== 'string' || typeof title !== 'string') {
    return null;
  }
  const tab = { id, kind: kind as WorkspaceTabKind, key, label, title };
  return isWellFormedTab(tab) ? tab : null;
};

const parseNode = (value: unknown, seen: Set<string>, depth: number): WorkspaceNode | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || seen.has(value.id) || depth > 16) return null;
  seen.add(value.id);
  if (value.type === 'pane') {
    const { tabs, active } = value;
    if (!Array.isArray(tabs) || !tabs.every(tab => typeof tab === 'string')) return null;
    const ids = tabs as string[];
    if (active === null ? ids.length > 0 : typeof active !== 'string' || !ids.includes(active)) return null;
    return { type: 'pane', id: value.id, tabs: ids, active: active as string | null };
  }
  if (value.type !== 'split') return null;
  const { direction, ratio, children } = value;
  if (direction !== 'row' && direction !== 'column') return null;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  if (!Array.isArray(children) || children.length !== 2) return null;
  const first = parseNode(children[0], seen, depth + 1);
  const second = parseNode(children[1], seen, depth + 1);
  if (!first || !second) return null;
  return { type: 'split', id: value.id, direction, ratio: clampWorkspaceRatio(ratio), children: [first, second] };
};

const parseParked = (value: unknown, seen: Set<string>): ParkedWorkspace | null | undefined => {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const { direction, ratio, node } = value;
  if (direction !== 'row' && direction !== 'column') return undefined;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return undefined;
  const parsed = parseNode(node, seen, 1);
  return parsed ? { direction, ratio: clampWorkspaceRatio(ratio), node: parsed } : undefined;
};

/** Every structural invariant the operations keep, checked after a parse. */
const isCoherent = (layout: WorkspaceLayout): boolean => {
  const root = layout.root;
  if (layout.parked && root.type === 'split') return false;
  const agent = root.type === 'pane' ? root : root.children[0];
  if (agent.type !== 'pane' || agent.id !== AGENT_PANE_ID) return false;
  if (agent.tabs.length !== AGENT_TAB_IDS.length || !agent.tabs.every((id, i) => id === AGENT_TAB_IDS[i])) return false;
  if (root.type === 'split' && root.id !== WORKSPACE_ROOT_SPLIT_ID) return false;
  if (layout.parked && findSplit(layout.parked.node, WORKSPACE_ROOT_SPLIT_ID)) return false;
  const workspaceNodes = [workspaceSubtree(layout), layout.parked?.node ?? null].filter(
    (node): node is WorkspaceNode => node !== null,
  );
  const workspaceTabs = workspaceNodes.flatMap(node => workspacePanes(node)).flatMap(pane => pane.tabs);
  const allTabs = [...AGENT_TAB_IDS, ...workspaceTabs];
  if (new Set(allTabs).size !== allTabs.length) return false;
  if (workspaceTabs.some(isAgentTabId)) return false;
  const recorded = Object.keys(layout.tabs);
  return recorded.length === allTabs.length && allTabs.every(id => layout.tabs[id] !== undefined);
};

/**
 * A layout saved before the Processes tab existed pins only Chat and Console. Rather than reset it (and
 * lose the reader's splits and open tabs) the missing pinned tab is added to the end of the agent pane,
 * where a fresh layout would have put it.
 */
const withPinnedAgentTabs = (value: Record<string, unknown>): Record<string, unknown> => {
  const legacy = ['chat', 'console'];
  const root = value.root;
  if (!isRecord(root)) return value;
  const agentOf = (node: Record<string, unknown>): Record<string, unknown> | null => {
    if (node.type === 'pane') return node;
    const first = Array.isArray(node.children) ? (node.children[0] as unknown) : null;
    return isRecord(first) ? agentOf(first) : null;
  };
  const upgrade = (node: Record<string, unknown>): Record<string, unknown> => {
    if (node.type === 'pane') return { ...node, tabs: [...(node.tabs as unknown[]), WORKSPACE_PROCESSES_TAB_ID] };
    const children = node.children as unknown[];
    return { ...node, children: [upgrade(children[0] as Record<string, unknown>), children[1]] };
  };
  const agent = agentOf(root);
  const tabs = agent?.tabs;
  if (agent?.id !== AGENT_PANE_ID || !Array.isArray(tabs) || tabs.length !== legacy.length) return value;
  if (!tabs.every((id, i) => id === legacy[i]) || !isRecord(value.tabs)) return value;
  const processes = AGENT_TABS.find(tab => tab.id === WORKSPACE_PROCESSES_TAB_ID);
  return { ...value, root: upgrade(root), tabs: { ...value.tabs, [WORKSPACE_PROCESSES_TAB_ID]: processes } };
};

/**
 * Defensive, versioned parse. Garbage, an unknown version or a structurally
 * incoherent tree is a clean reset to the default layout — a remembered layout
 * is a convenience, never worth a broken session page.
 */
export const parseWorkspaceLayout = (raw: unknown): WorkspaceLayout => {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return defaultWorkspaceLayout();
    }
  }
  if (!isRecord(value) || value.v !== WORKSPACE_LAYOUT_VERSION || !isRecord(value.tabs))
    return defaultWorkspaceLayout();
  const saved = withPinnedAgentTabs(value);
  const seen = new Set<string>();
  const root = parseNode(saved.root, seen, 0);
  const parked = parseParked(saved.parked, seen);
  if (!root || parked === undefined) return defaultWorkspaceLayout();
  const tabs: Record<WorkspaceTabId, WorkspaceTab> = {};
  for (const [id, record] of Object.entries(isRecord(saved.tabs) ? saved.tabs : {})) {
    const tab = parseTab(id, record);
    if (!tab) return defaultWorkspaceLayout();
    tabs[id] = tab;
  }
  const seq = typeof saved.seq === 'number' && Number.isInteger(saved.seq) && saved.seq >= 0 ? saved.seq : 0;
  const focused = typeof saved.focused === 'string' ? saved.focused : AGENT_PANE_ID;
  const announced = Array.isArray(saved.announced)
    ? saved.announced.filter((entry): entry is string => typeof entry === 'string').slice(-WORKSPACE_ANNOUNCED_LIMIT)
    : [];
  const layout: WorkspaceLayout = {
    v: WORKSPACE_LAYOUT_VERSION,
    root,
    parked,
    tabs,
    focused,
    seq,
    ...(announced.length === 0 ? {} : { announced }),
  };
  if (!isCoherent(layout)) return defaultWorkspaceLayout();
  // Ids minted later must never collide with a restored one.
  const highest = Math.max(seq, ...[...seen].map(id => Number(/-(\d+)$/u.exec(id)?.[1] ?? 0)));
  return refocus({ ...layout, seq: highest });
};

export const serializeWorkspaceLayout = (layout: WorkspaceLayout): string => JSON.stringify(layout);
