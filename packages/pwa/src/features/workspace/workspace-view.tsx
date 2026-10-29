/**
 * THE SESSION WORKSPACE, rendered from its split tree (`lib/workspace-layout.ts`).
 *
 * Panes sit side by side or stacked with a resizable divider between each
 * pair; every pane is its own tab strip over its tab bodies. The view owns no
 * layout state of its own beyond a drag in flight: every intent becomes one
 * pure layout operation handed to `onLayoutChange`, so the caller (and its
 * persistence) holds the single copy.
 *
 * WHAT STAYS MOUNTED. A tab body is produced by `renderTab(tab, paneId)`. Live
 * bodies — Chat, Console, terminals and browsers, which hold a socket, a
 * scrollback or a logged-in page — stay mounted while another tab in the same
 * pane is selected, the same `retain` rule the side pane uses. The workspace
 * subtree is rendered in the same place whether it is shown or parked, so the
 * ⫼ toggle hides those bodies instead of tearing them down. A file body is a
 * cheap re-fetch and unmounts when deselected. (Moving a tab to another pane
 * does remount its body.)
 *
 * CLOSING A TERMINAL TAB ASKS WHICH CLOSE IS MEANT. A tab is a view of a shell, not the shell: closing
 * it can mean "get this out of my way" or "stop that process", and guessing either way loses something
 * — a build the reader still wanted, or a shell left running that they thought was gone. When the host
 * can end shells (`onEndTerminal`), ✕ and Delete on a terminal tab open the shared context menu at
 * the tab with both: Close tab, which keeps the shell running and reachable from the terminal list, and
 * End shell. A menu rather than `window.confirm`, which some embedding contexts block outright.
 */

import { type CSSProperties, type ReactNode, useId, useRef, useState } from 'react';
import {
  AGENT_PANE_ID,
  activateWorkspaceTab,
  canSplitWorkspacePane,
  closeWorkspaceTab,
  focusWorkspacePane,
  isWorkspaceVisible,
  moveWorkspaceTab,
  setWorkspaceRatio,
  setWorkspaceSplitDirection,
  splitWorkspacePane,
  toggleWorkspacePane,
  WORKSPACE_DEFAULT_RATIO,
  WORKSPACE_MIN_RATIO,
  type WorkspaceLayout,
  type WorkspaceNode,
  type WorkspacePaneNode,
  type WorkspaceSplitDirection,
  type WorkspaceSplitNode,
  type WorkspaceTab,
  type WorkspaceTabId,
  type WorkspaceTabKind,
  workspacePanes,
} from '../../lib/workspace-layout.ts';
import { ContextMenu, type MenuAnchor } from '../../shell/context-menu.tsx';
import { SplitDivider } from './split-divider.tsx';
import type { AgentSurfaceTabs } from './use-agent-surface-tabs.ts';
import {
  type WorkspaceNewTabKind,
  type WorkspaceStripLayoutControls,
  WorkspaceTabStrip,
  workspacePanelElementId,
  workspaceTabElementId,
} from './workspace-tab-strip.tsx';

/** Bodies of these kinds hold live state and stay mounted while deselected. */
const RETAINED_KINDS: ReadonlySet<WorkspaceTabKind> = new Set(['chat', 'console', 'processes', 'terminal', 'browser']);

export interface WorkspaceViewProps {
  readonly layout: WorkspaceLayout;
  readonly onLayoutChange: (next: WorkspaceLayout) => void;
  readonly renderTab: (tab: WorkspaceTab, paneId: string) => ReactNode;
  /** ＋ chose a new tab for `paneId`; the caller creates it, then opens it. */
  readonly onNewTab: (kind: WorkspaceNewTabKind, paneId: string) => void;
  /** A workspace tab was closed, so its terminal / page may be disposed. */
  readonly onTabClosed?: (tab: WorkspaceTab) => void;
  /**
   * Ends a terminal tab's shell. Present, a terminal tab's close asks Close tab or End shell; absent,
   * a close only closes the tab, as it always did.
   */
  readonly onEndTerminal?: (tab: WorkspaceTab) => void;
  /** The agent's first name, when it has one: the Chat and Console tabs say whose they are. */
  readonly agentName?: string;
  /** Words a tab shows instead of its layout label — the Processes tab's live count. The layout is untouched. */
  readonly tabLabels?: ReadonlyMap<WorkspaceTabId, string>;
  readonly drivenTabIds?: ReadonlySet<WorkspaceTabId>;
  readonly agentSurfaces?: AgentSurfaceTabs;
  readonly maxPanes?: number;
  /** Smallest share either side of a divider may shrink to. */
  readonly minRatio?: number;
}

interface ViewContext extends WorkspaceViewProps {
  readonly idPrefix: string;
  readonly dragging: WorkspaceTabId | null;
  readonly setDragging: (tabId: WorkspaceTabId | null) => void;
  readonly preview: { readonly splitId: string; readonly ratio: number } | null;
  readonly setPreview: (preview: { readonly splitId: string; readonly ratio: number } | null) => void;
  readonly change: (next: WorkspaceLayout) => void;
  /** Closes a tab — or, for a terminal the host can end, asks how. */
  readonly requestClose: (tabId: WorkspaceTabId) => void;
}

const otherPaneId = (layout: WorkspaceLayout, paneId: string): string | null => {
  const panes = workspacePanes(layout.root).filter(pane => pane.id !== AGENT_PANE_ID);
  if (panes.length < 2) return null;
  const at = panes.findIndex(pane => pane.id === paneId);
  return (panes[(at + 1) % panes.length] as WorkspacePaneNode).id;
};

/** The split directly holding `paneId`, for the side-by-side / stacked choice. */
const parentSplit = (node: WorkspaceNode, paneId: string): WorkspaceSplitNode | undefined => {
  if (node.type === 'pane') return undefined;
  if (node.children.some(child => child.type === 'pane' && child.id === paneId)) return node;
  return parentSplit(node.children[0], paneId) ?? parentSplit(node.children[1], paneId);
};

const layoutControls = (context: ViewContext, pane: WorkspacePaneNode): WorkspaceStripLayoutControls => {
  const { layout, change } = context;
  const capOptions = context.maxPanes === undefined ? {} : { maxPanes: context.maxPanes };
  // A parked pane has no visible parent split; it gets no layout commands.
  const split = parentSplit(layout.root, pane.id);
  const other = otherPaneId(layout, pane.id);
  const active = pane.active;
  return {
    ...(canSplitWorkspacePane(layout, pane.id, capOptions)
      ? {
          onSplit: direction => change(splitWorkspacePane(layout, pane.id, direction, undefined, capOptions)),
        }
      : {}),
    ...(split
      ? {
          direction: split.direction,
          onSetDirection: (direction: WorkspaceSplitDirection) =>
            change(setWorkspaceSplitDirection(layout, split.id, direction)),
        }
      : {}),
    ...(other !== null && active !== null
      ? { onMoveActiveToOtherPane: () => change(moveWorkspaceTab(layout, active, other)) }
      : {}),
  };
};

function PaneView({ context, pane }: { readonly context: ViewContext; readonly pane: WorkspacePaneNode }) {
  const { layout, change, idPrefix } = context;
  const agentPane = pane.id === AGENT_PANE_ID;
  const tabs = pane.tabs
    .map(id => layout.tabs[id])
    .filter((tab): tab is WorkspaceTab => tab !== undefined)
    .map(tab => agentTitled(tab, context.agentName))
    .map(tab => {
      const label = context.tabLabels?.get(tab.id);
      return label === undefined ? tab : { ...tab, label };
    });
  const bodies = tabs.filter(tab => tab.id === pane.active || RETAINED_KINDS.has(tab.kind));
  return (
    <section
      className="fy-ws-pane"
      data-pane-id={pane.id}
      data-focused={layout.focused === pane.id}
      aria-label={agentPane ? 'Agent' : 'Workspace'}
      onPointerDown={() => change(focusWorkspacePane(layout, pane.id))}
      onFocus={() => change(focusWorkspacePane(layout, pane.id))}
    >
      <WorkspaceTabStrip
        paneId={pane.id}
        idPrefix={idPrefix}
        tabs={tabs}
        active={pane.active}
        agentPane={agentPane}
        workspaceVisible={isWorkspaceVisible(layout)}
        {...(context.drivenTabIds ? { drivenTabIds: context.drivenTabIds } : {})}
        {...(context.agentSurfaces ? { agentSurfaces: context.agentSurfaces } : {})}
        draggingTabId={context.dragging}
        {...(agentPane ? {} : { layoutControls: layoutControls(context, pane) })}
        onActivate={tabId => change(activateWorkspaceTab(layout, tabId))}
        onClose={context.requestClose}
        onDragTab={context.setDragging}
        onDropTab={(tabId, index) => change(moveWorkspaceTab(layout, tabId, pane.id, index))}
        onToggleWorkspace={() => change(toggleWorkspacePane(layout))}
        onNewTab={kind => context.onNewTab(kind, pane.id)}
      />
      <div className="fy-ws-pane-body">
        {bodies.map(tab => (
          <div
            key={tab.id}
            role="tabpanel"
            id={workspacePanelElementId(idPrefix, tab.id)}
            aria-labelledby={workspaceTabElementId(idPrefix, tab.id)}
            hidden={tab.id !== pane.active}
            className="fy-ws-panel"
          >
            {context.renderTab(tab, pane.id)}
          </div>
        ))}
        {tabs.length === 0 && (
          <p className="fy-ws-empty">Nothing open here yet. Use ＋ to open a terminal, a browser or a file.</p>
        )}
      </div>
    </section>
  );
}

const flexShare = (share: number): CSSProperties => ({ flex: `${share} 1 0` });

/**
 * The agent's own tabs, titled with its name. Only the hover title and accessible description change —
 * the label stays "Chat" / "Console", the words the spec and every other session use — and the layout
 * is not touched, because a name belongs to the session and the layout is remembered per daemon.
 */
const agentTitled = (tab: WorkspaceTab, agentName: string | undefined): WorkspaceTab => {
  if (agentName === undefined || agentName === '') return tab;
  if (tab.kind === 'chat') return { ...tab, title: `Chat with ${agentName}` };
  if (tab.kind === 'console') return { ...tab, title: `${agentName}’s own CLI, live` };
  return tab;
};

function NodeView({ context, node }: { readonly context: ViewContext; readonly node: WorkspaceNode }) {
  if (node.type === 'pane') return <PaneView context={context} pane={node} />;
  const preview = context.preview?.splitId === node.id ? context.preview.ratio : null;
  const ratio = preview ?? node.ratio;
  return <SplitView context={context} split={node} ratio={ratio} first={node.children[0]} second={node.children[1]} />;
}

function SplitView({
  context,
  split,
  ratio,
  first,
  second,
  secondHidden: hiddenFlag = false,
}: {
  readonly context: ViewContext;
  readonly split: Pick<WorkspaceSplitNode, 'id' | 'direction'>;
  readonly ratio: number;
  readonly first: WorkspaceNode;
  /** Null when the workspace has never been shown: the agent pane alone. */
  readonly second: WorkspaceNode | null;
  readonly secondHidden?: boolean;
}) {
  const minRatio = context.minRatio ?? WORKSPACE_MIN_RATIO;
  const secondHidden = hiddenFlag || second === null;
  return (
    <div className="fy-ws-split" data-direction={split.direction} data-split-id={split.id}>
      <div className="fy-ws-split-child" style={secondHidden ? flexShare(1) : flexShare(ratio)}>
        <NodeView context={context} node={first} />
      </div>
      {!secondHidden && (
        <SplitDivider
          axis={split.direction}
          unit="ratio"
          value={ratio}
          min={minRatio}
          max={1 - minRatio}
          defaultValue={WORKSPACE_DEFAULT_RATIO}
          step={0.02}
          label="Resize panes"
          onPreview={value => context.setPreview({ splitId: split.id, ratio: value })}
          onCommit={value => {
            context.setPreview(null);
            context.change(setWorkspaceRatio(context.layout, split.id, value, minRatio));
          }}
        />
      )}
      {second && (
        <div className="fy-ws-split-child" style={flexShare(1 - ratio)} hidden={secondHidden}>
          <NodeView context={context} node={second} />
        </div>
      )}
    </div>
  );
}

export function WorkspaceView(props: WorkspaceViewProps) {
  const idPrefix = `fy-ws${useId().replaceAll(':', '')}`;
  const [dragging, setDragging] = useState<WorkspaceTabId | null>(null);
  const [preview, setPreview] = useState<ViewContext['preview']>(null);
  const [closing, setClosing] = useState<{ readonly tab: WorkspaceTab; readonly anchor: MenuAnchor } | null>(null);
  const closingTrigger = useRef<HTMLElement | null>(null);
  const { layout, onLayoutChange, onEndTerminal } = props;
  const change = (next: WorkspaceLayout): void => {
    if (next !== layout) onLayoutChange(next);
  };
  const closeTab = (tabId: WorkspaceTabId): void => {
    const next = closeWorkspaceTab(layout, tabId);
    if (next === layout) return;
    change(next);
    props.onTabClosed?.(layout.tabs[tabId] as WorkspaceTab);
  };
  const requestClose = (tabId: WorkspaceTabId): void => {
    const tab = layout.tabs[tabId];
    if (tab === undefined || tab.kind !== 'terminal' || onEndTerminal === undefined) {
      closeTab(tabId);
      return;
    }
    // Opened under the tab itself, whichever of ✕ or Delete asked, so the choice reads as being about it.
    const element = document.getElementById(workspaceTabElementId(idPrefix, tabId));
    closingTrigger.current = element;
    const rect = element?.getBoundingClientRect();
    setClosing({ tab, anchor: { x: rect?.left ?? 0, y: rect?.bottom ?? 0 } });
  };
  const context: ViewContext = {
    ...props,
    idPrefix,
    dragging,
    setDragging,
    preview,
    setPreview,
    change,
    requestClose,
  };
  const root = layout.root;
  // The agent pane and the workspace subtree render in fixed positions whether
  // the workspace is shown or parked, so hiding it never unmounts live bodies.
  const workspace = root.type === 'split' ? root.children[1] : (layout.parked?.node ?? null);
  const agent = root.type === 'split' ? root.children[0] : root;
  const split = root.type === 'split' ? root : { id: AGENT_PANE_ID, direction: layout.parked?.direction ?? 'row' };
  const ratio = root.type === 'split' ? (preview?.splitId === root.id ? preview.ratio : root.ratio) : 1;
  return (
    <div className="fy-ws">
      <SplitView
        context={context}
        split={split}
        ratio={ratio}
        first={agent}
        second={workspace}
        secondHidden={root.type !== 'split'}
      />
      <ContextMenu
        anchor={closing?.anchor ?? { x: 0, y: 0 }}
        ariaLabel={closing === null ? 'Close terminal tab' : `Close ${closing.tab.label}`}
        items={
          closing === null
            ? []
            : [
                {
                  key: 'close-tab',
                  label: 'Close tab',
                  detail: 'the shell keeps running',
                  onSelect: () => closeTab(closing.tab.id),
                },
                {
                  key: 'end-shell',
                  label: 'End shell',
                  detail: 'stops its process',
                  danger: true,
                  onSelect: () => {
                    closeTab(closing.tab.id);
                    onEndTerminal?.(closing.tab);
                  },
                },
              ]
        }
        onClose={() => setClosing(null)}
        open={closing !== null}
        triggerRef={closingTrigger}
      />
    </div>
  );
}
