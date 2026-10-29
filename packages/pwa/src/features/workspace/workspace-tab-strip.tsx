/**
 * ONE PANE'S TAB STRIP.
 *
 *   AGENT PANE      the two pinned tabs — 💬 Chat and ⌨ Console — and, at the
 *                   end, the single ⫼ that shows or hides the workspace pane.
 *                   No close, no drag, no ＋: those tabs are the agent.
 *   WORKSPACE PANE  its terminals, browsers and files, each closable and
 *                   draggable to another pane, then ＋ — one menu holding
 *                   New terminal / New browser / Open file and the layout
 *                   commands (split, side by side / stacked, and "Move tab to
 *                   other pane", the keyboard alternative to dragging).
 *
 * A real WAI-ARIA tablist: roving tabindex, wrap-around arrows, Home / End,
 * Delete or a middle-click closes a workspace tab. The ✕ lives inside the tab (a nested button is
 * invalid in role=tab), so the tab's click handler tells the two apart.
 *
 * Presentational: the workspace view owns the layout and maps every intent to
 * a pure layout operation.
 */

import { Columns2, ListTree, MessageSquare, Plus, SquareTerminal, X } from 'lucide-react';
import { type DragEvent, useEffect, useId, useRef, useState } from 'react';
import type { WorkspaceSplitDirection, WorkspaceTab, WorkspaceTabId } from '../../lib/workspace-layout.ts';
import { sidePaneTabIcon } from '../../shell/side-pane-tab-icons.ts';
import { nextSidePaneTab } from '../../shell/side-pane-tabs.tsx';
import type { AgentSurfaceTabs } from './use-agent-surface-tabs.ts';

export type WorkspaceNewTabKind = 'terminal' | 'browser' | 'file';

/** The layout commands a workspace pane's menu may offer. */
export interface WorkspaceStripLayoutControls {
  /** Present when this pane may split under the pane cap. */
  readonly onSplit?: (direction: WorkspaceSplitDirection) => void;
  /** The split this pane sits in, for the side-by-side / stacked choice. */
  readonly direction?: WorkspaceSplitDirection;
  readonly onSetDirection?: (direction: WorkspaceSplitDirection) => void;
  /** Present when another workspace pane exists to move the active tab to. */
  readonly onMoveActiveToOtherPane?: () => void;
}

export interface WorkspaceTabStripProps {
  readonly paneId: string;
  /** Prefix for tab and panel element ids; the view supplies one per mount. */
  readonly idPrefix: string;
  readonly tabs: readonly WorkspaceTab[];
  readonly active: WorkspaceTabId | null;
  readonly agentPane: boolean;
  /** Agent pane: whether the ⫼ currently shows the workspace. */
  readonly workspaceVisible: boolean;
  /** Tabs the agent is driving right now; they wear the AGENT badge. */
  readonly drivenTabIds?: ReadonlySet<WorkspaceTabId>;
  /** Tabs an agent added, tabs it handed over, and surfaces ＋ can bring back. */
  readonly agentSurfaces?: AgentSurfaceTabs;
  readonly draggingTabId: WorkspaceTabId | null;
  readonly layoutControls?: WorkspaceStripLayoutControls;
  readonly onActivate: (tabId: WorkspaceTabId) => void;
  readonly onClose: (tabId: WorkspaceTabId) => void;
  readonly onDragTab: (tabId: WorkspaceTabId | null) => void;
  /** A dragged tab dropped on this strip, before the tab at `index` (or last). */
  readonly onDropTab: (tabId: WorkspaceTabId, index: number) => void;
  readonly onToggleWorkspace: () => void;
  readonly onNewTab: (kind: WorkspaceNewTabKind) => void;
}

export const workspaceTabElementId = (idPrefix: string, tabId: WorkspaceTabId): string => `${idPrefix}-tab-${tabId}`;

export const workspacePanelElementId = (idPrefix: string, tabId: WorkspaceTabId): string =>
  `${idPrefix}-panel-${tabId}`;

const TabIcon = ({ tab }: { readonly tab: WorkspaceTab }) => {
  if (tab.kind === 'chat') return <MessageSquare size={14} aria-hidden="true" />;
  if (tab.kind === 'console') return <SquareTerminal size={14} aria-hidden="true" />;
  if (tab.kind === 'processes') return <ListTree size={14} aria-hidden="true" />;
  const Icon = sidePaneTabIcon(tab.kind);
  return <Icon size={14} aria-hidden="true" />;
};

interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly checked?: boolean;
  readonly run: () => void;
}

const menuItems = (props: WorkspaceTabStripProps): readonly (readonly MenuItem[])[] => {
  const controls = props.layoutControls ?? {};
  const create: MenuItem[] = [
    { key: 'terminal', label: 'New terminal', run: () => props.onNewTab('terminal') },
    { key: 'browser', label: 'New browser', run: () => props.onNewTab('browser') },
    { key: 'file', label: 'Open file', run: () => props.onNewTab('file') },
  ];
  const layout: MenuItem[] = [];
  const { onSplit, onSetDirection, direction, onMoveActiveToOtherPane } = controls;
  if (onSplit) {
    layout.push({ key: 'split-row', label: 'Split right', run: () => onSplit('row') });
    layout.push({ key: 'split-column', label: 'Split down', run: () => onSplit('column') });
  }
  if (onSetDirection && direction) {
    layout.push({
      key: 'row',
      label: 'Side by side',
      checked: direction === 'row',
      run: () => onSetDirection('row'),
    });
    layout.push({
      key: 'column',
      label: 'Stacked',
      checked: direction === 'column',
      run: () => onSetDirection('column'),
    });
  }
  if (onMoveActiveToOtherPane) {
    layout.push({ key: 'move', label: 'Move tab to other pane', run: onMoveActiveToOtherPane });
  }
  const reopen: MenuItem[] = (props.agentSurfaces?.reopenable ?? []).map(surface => ({
    key: `reopen-${surface.tabId}`,
    label: `Reopen ${surface.kind === 'terminal' ? 'terminal' : 'page'} ${surface.label}`,
    run: () => props.agentSurfaces?.reopen(surface.tabId),
  }));
  return [create, ...(reopen.length > 0 ? [reopen] : []), ...(layout.length > 0 ? [layout] : [])];
};

function NewTabMenu(props: WorkspaceTabStripProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const groups = menuItems(props);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="fy-ws-strip-menu">
      <button
        ref={triggerRef}
        type="button"
        className="fy-ws-strip-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Open a tab or change the layout"
        title="New terminal, browser or file"
        onClick={() => setOpen(value => !value)}
      >
        <Plus size={15} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Workspace pane"
          tabIndex={-1}
          className="fy-ws-menu"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const items = [...(menuRef.current as HTMLDivElement).querySelectorAll<HTMLElement>('[role^="menuitem"]')];
            const at = items.indexOf(document.activeElement as HTMLElement);
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            items[(at + delta + items.length) % items.length]?.focus();
          }}
        >
          {groups.map((group, index) => [
            index > 0 && <hr key={`sep-${group[0]?.key}`} className="fy-ws-menu-sep" />,
            ...group.map(item => {
              const run = () => {
                item.run();
                close();
              };
              return item.checked === undefined ? (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="fy-ws-menu-item"
                  onClick={run}
                >
                  {item.label}
                </button>
              ) : (
                <button
                  key={item.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.checked}
                  tabIndex={-1}
                  className="fy-ws-menu-item"
                  onClick={run}
                >
                  {item.label}
                </button>
              );
            }),
          ])}
        </div>
      )}
    </div>
  );
}

const dropIndex = (event: DragEvent<HTMLElement>, tabs: readonly WorkspaceTab[]): number => {
  const over = (event.target as HTMLElement).closest<HTMLElement>('[data-tab-id]');
  const index = over ? tabs.findIndex(tab => tab.id === over.dataset.tabId) : -1;
  return index === -1 ? tabs.length : index;
};

export function WorkspaceTabStrip(props: WorkspaceTabStripProps) {
  const { tabs, active, agentPane, idPrefix, draggingTabId, drivenTabIds, agentSurfaces } = props;
  const refs = useRef(new Map<WorkspaceTabId, HTMLButtonElement>());
  const order = tabs.map(tab => tab.id);
  const focusStop = active !== null && order.includes(active) ? active : order[0];
  const acceptsDrop = !agentPane && draggingTabId !== null;

  return (
    <div className="fy-ws-strip" data-agent-pane={agentPane}>
      <div
        role="tablist"
        aria-label={agentPane ? 'Agent tabs' : 'Workspace tabs'}
        className="fy-ws-tabs"
        data-drop-target={acceptsDrop}
        onDragOver={event => {
          if (!acceptsDrop) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={event => {
          if (!acceptsDrop) return;
          event.preventDefault();
          props.onDropTab(draggingTabId, dropIndex(event, tabs));
          props.onDragTab(null);
        }}
      >
        {tabs.map(tab => {
          const selected = tab.id === active;
          const closable = !agentPane;
          const driven = drivenTabIds?.has(tab.id) ?? false;
          const asked = agentSurfaces?.askedTabIds.has(tab.id) ?? false;
          const fresh = !asked && (agentSurfaces?.unseenTabIds.has(tab.id) ?? false);
          const said = [driven && 'agent is driving', asked && 'your turn', fresh && 'opened by the agent']
            .filter(Boolean)
            .join(', ');
          return (
            <button
              key={tab.id}
              ref={element => {
                if (element) refs.current.set(tab.id, element);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={workspaceTabElementId(idPrefix, tab.id)}
              aria-selected={selected}
              aria-controls={workspacePanelElementId(idPrefix, tab.id)}
              aria-label={said === '' ? tab.label : `${tab.label}, ${said}`}
              aria-keyshortcuts={closable ? 'Delete' : undefined}
              tabIndex={tab.id === focusStop ? 0 : -1}
              title={tab.title}
              className="fy-ws-tab"
              data-tab-id={tab.id}
              data-pinned={!closable}
              data-dragging={draggingTabId === tab.id}
              data-asked={asked}
              data-fresh={fresh}
              draggable={closable}
              onDragStart={event => {
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', tab.id);
                }
                props.onDragTab(tab.id);
              }}
              onDragEnd={() => props.onDragTab(null)}
              // A middle-click closes, as it does on a browser's own tabs; the press is held off so it
              // never starts the browser's autoscroll over the pane.
              onMouseDown={event => {
                if (closable && event.button === 1) event.preventDefault();
              }}
              onAuxClick={event => {
                if (!closable || event.button !== 1) return;
                event.preventDefault();
                props.onClose(tab.id);
              }}
              onClick={event => {
                if ((event.target as HTMLElement).closest('[data-tab-close]') !== null) {
                  event.stopPropagation();
                  props.onClose(tab.id);
                  return;
                }
                if (!selected) props.onActivate(tab.id);
              }}
              onKeyDown={event => {
                if (closable && event.key === 'Delete') {
                  event.preventDefault();
                  props.onClose(tab.id);
                  return;
                }
                const next = nextSidePaneTab(event.key, tab.id, order);
                if (next === null) return;
                event.preventDefault();
                props.onActivate(next);
                refs.current.get(next)?.focus();
              }}
            >
              <TabIcon tab={tab} />
              <span aria-hidden="true" className="fy-ws-tab-label">
                {tab.label}
              </span>
              {driven && (
                <span aria-hidden="true" className="fy-ws-agent-badge">
                  AGENT
                </span>
              )}
              {asked && (
                <span aria-hidden="true" className="fy-ws-ask-badge">
                  YOUR TURN
                </span>
              )}
              {fresh && <span aria-hidden="true" className="fy-ws-new-dot" />}
              {closable && (
                <span
                  data-tab-close="true"
                  role="presentation"
                  title={`Close ${tab.label}`}
                  className="fy-ws-tab-close"
                >
                  <X size={12} aria-hidden="true" />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="fy-ws-strip-end">
        {agentPane ? (
          <button
            type="button"
            className="fy-ws-strip-button"
            aria-pressed={props.workspaceVisible}
            aria-label={props.workspaceVisible ? 'Hide workspace pane' : 'Show workspace pane'}
            title={props.workspaceVisible ? 'Hide workspace pane' : 'Show workspace pane'}
            onClick={props.onToggleWorkspace}
          >
            <Columns2 size={15} aria-hidden="true" />
          </button>
        ) : (
          <NewTabMenu {...props} />
        )}
      </div>
    </div>
  );
}
