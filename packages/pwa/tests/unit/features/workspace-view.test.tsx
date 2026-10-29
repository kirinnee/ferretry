import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { useWorkspaceLayout, useWorkspaceRails } from '../../../src/features/workspace/use-workspace-layout.ts';
import type { WorkspaceNewTabKind } from '../../../src/features/workspace/workspace-tab-strip.tsx';
import { WorkspaceView, type WorkspaceViewProps } from '../../../src/features/workspace/workspace-view.tsx';
import type { DaemonId } from '../../../src/lib/daemon-connection.ts';
import {
  AGENT_PANE_ID,
  defaultWorkspaceLayout,
  isWorkspaceVisible,
  openWorkspaceTab,
  toggleWorkspacePane,
  WORKSPACE_ROOT_SPLIT_ID,
  type WorkspaceLayout,
  type WorkspaceTab,
  workspacePanes,
  workspaceTab,
} from '../../../src/lib/workspace-layout.ts';
import { WorkspaceLayoutStore, type WorkspaceStorage } from '../../../src/lib/workspace-layout-store.ts';
import { WorkspaceRailPreferenceStore } from '../../../src/lib/workspace-rail-preferences.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const dev = workspaceTab('terminal', 'dev');
const app = workspaceTab('browser', 'app');
const login = workspaceTab('file', 'src/login.tsx');
const readme = workspaceTab('file', 'README.md');

const withTabs = (...tabs: WorkspaceTab[]): WorkspaceLayout =>
  tabs.reduce((layout, tab) => openWorkspaceTab(layout, tab), defaultWorkspaceLayout());

interface Recorder {
  readonly layouts: WorkspaceLayout[];
  readonly created: [WorkspaceNewTabKind, string][];
  readonly closed: string[];
  readonly mounts: string[];
  current: () => WorkspaceLayout;
}

/** A controlled host: the view's every change is applied, as the session page will. */
const host = async (initial: WorkspaceLayout, extra: Partial<WorkspaceViewProps> = {}) => {
  const recorder: Recorder = { layouts: [], created: [], closed: [], mounts: [], current: () => initial };
  function Body({ tab }: { readonly tab: WorkspaceTab }) {
    useState(() => {
      recorder.mounts.push(tab.id);
      return null;
    });
    return <span data-body={tab.id}>{tab.label}</span>;
  }
  function Host() {
    const [layout, setLayout] = useState(initial);
    recorder.current = () => layout;
    return (
      <WorkspaceView
        layout={layout}
        onLayoutChange={next => {
          recorder.layouts.push(next);
          setLayout(next);
        }}
        renderTab={tab => <Body tab={tab} />}
        onNewTab={(kind, paneId) => recorder.created.push([kind, paneId])}
        onTabClosed={tab => recorder.closed.push(tab.id)}
        {...extra}
      />
    );
  }
  const mounted = await mount(<Host />);
  const q = <T extends Element = HTMLElement>(selector: string) =>
    must(mounted.container.querySelector<T & HTMLElement>(selector), selector) as T & HTMLElement;
  const openMenuItem = async (paneId: string, label: string) => {
    await interact(() => q(`[data-pane-id="${paneId}"] [aria-haspopup="menu"]`).click());
    const item = [...mounted.container.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(
      node => node.textContent === label,
    );
    await interact(() => must(item, label).click());
  };
  return { ...mounted, recorder, q, openMenuItem };
};

const workspacePaneIds = (layout: WorkspaceLayout): string[] =>
  workspacePanes(layout.root)
    .map(pane => pane.id)
    .filter(id => id !== AGENT_PANE_ID);

describe('WorkspaceView', () => {
  it('renders the agent pane alone, then shows and hides the workspace with ⫼', async () => {
    const view = await host(defaultWorkspaceLayout());
    expect(view.container.querySelectorAll('.fy-ws-pane')).toHaveLength(1);
    expect(view.container.querySelector('[role="separator"]')).toBeNull();
    const chatPanel = view.q('[data-body="chat"]').parentElement as HTMLElement;
    expect(chatPanel.getAttribute('role')).toBe('tabpanel');
    expect(chatPanel.hidden).toBe(false);
    expect((view.q('[data-body="console"]').parentElement as HTMLElement).hidden).toBe(true);
    await interact(() => view.q('[aria-label="Show workspace pane"]').click());
    expect(view.container.querySelectorAll('.fy-ws-pane')).toHaveLength(2);
    expect(view.q('.fy-ws-empty').textContent).toContain('Nothing open here yet');
    expect(view.container.querySelector('[role="separator"]')).not.toBeNull();
    await interact(() => view.q('[aria-label="Hide workspace pane"]').click());
    const parked = view.q('[data-pane-id="pane-1"]').parentElement as HTMLElement;
    expect(parked.hidden).toBe(true);
    expect(view.container.querySelector('[role="separator"]')).toBeNull();
    await view.unmount();
  });

  it('keeps live bodies mounted across tab switches and hide/show, but not file bodies', async () => {
    const view = await host(withTabs(dev, app, login, readme));
    expect(view.recorder.mounts).toEqual(['chat', 'console', 'processes', dev.id, app.id, readme.id]);
    expect(view.container.querySelector(`[data-body="${login.id}"]`)).toBeNull();
    await interact(() => view.q(`[data-tab-id="${dev.id}"]`).click());
    expect(view.container.querySelector(`[data-body="${readme.id}"]`)).toBeNull();
    await interact(() => view.q('[aria-label="Hide workspace pane"]').click());
    await interact(() => view.q('[aria-label="Show workspace pane"]').click());
    expect(view.recorder.mounts).toEqual(['chat', 'console', 'processes', dev.id, app.id, readme.id]);
    await view.unmount();
  });

  it('selects the agent tabs and focuses the pane a pointer lands in', async () => {
    const view = await host(withTabs(dev));
    await interact(() => view.q('[data-tab-id="console"]').click());
    expect(view.recorder.current().focused).toBe(AGENT_PANE_ID);
    await interact(() => view.q('[data-pane-id="pane-1"]').dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(view.recorder.current().focused).toBe('pane-1');
    // Focusing the pane already focused changes nothing.
    const before = view.recorder.layouts.length;
    await interact(() => view.q(`[data-tab-id="${dev.id}"]`).focus());
    expect(view.recorder.layouts).toHaveLength(before);
    await view.unmount();
  });

  it('closes a workspace tab and reports it; a pinned tab never closes', async () => {
    const view = await host(withTabs(dev, app));
    await interact(() => pressKey(view.q(`[data-tab-id="${dev.id}"]`), 'Delete'));
    expect(view.recorder.closed).toEqual([dev.id]);
    await interact(() => pressKey(view.q('[data-tab-id="chat"]'), 'Delete'));
    expect(view.recorder.closed).toEqual([dev.id]);
    await view.unmount();
  });

  it('closes without a closed-tab listener', async () => {
    const view = await host(withTabs(dev, app), { onTabClosed: undefined });
    await interact(() => pressKey(view.q(`[data-tab-id="${dev.id}"]`), 'Delete'));
    expect(view.recorder.current().tabs[dev.id]).toBeUndefined();
    await view.unmount();
  });

  it('asks Close tab or End shell for a terminal when the host can end shells', async () => {
    const ended: string[] = [];
    const view = await host(withTabs(dev, app, readme), { onEndTerminal: tab => ended.push(tab.id) });
    const menuItem = (label: string) =>
      must(
        [...view.container.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(node =>
          node.textContent?.startsWith(label),
        ),
        label,
      );

    // ✕ on the terminal opens the choice at the tab; nothing is closed yet.
    await interact(() => view.q(`[data-tab-id="${dev.id}"] [data-tab-close]`).click());
    expect(view.q('[role="menu"]').getAttribute('aria-label')).toBe(`Close ${dev.label}`);
    expect(menuItem('Close tab').textContent).toContain('the shell keeps running');
    expect(menuItem('End shell').textContent).toContain('stops its process');
    expect(view.recorder.closed).toEqual([]);

    // Close tab: the tab goes, the shell is left running.
    await interact(() => menuItem('Close tab').click());
    expect(view.recorder.closed).toEqual([dev.id]);
    expect(ended).toEqual([]);
    expect(view.container.querySelector('[role="menu"]')).toBeNull();

    // Delete on a fresh terminal asks too, and End shell closes the tab AND ends the shell.
    const shell = workspaceTab('terminal', 'shell');
    await view.unmount();
    const again = await host(withTabs(shell, readme), { onEndTerminal: tab => ended.push(tab.id) });
    await interact(() => pressKey(again.q(`[data-tab-id="${shell.id}"]`), 'Delete'));
    await interact(() =>
      must(
        [...again.container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node =>
          node.textContent?.startsWith('End shell'),
        ),
        'End shell',
      ).click(),
    );
    expect(again.recorder.closed).toEqual([shell.id]);
    expect(ended).toEqual([shell.id]);

    // A file closes at once: only a terminal has a process behind it.
    await interact(() => pressKey(again.q(`[data-tab-id="${readme.id}"]`), 'Delete'));
    expect(again.recorder.closed).toEqual([shell.id, readme.id]);
    expect(again.container.querySelector('[role="menu"]')).toBeNull();
    await again.unmount();
  });

  it('titles the agent’s own tabs with its name, and leaves every other tab and the label alone', async () => {
    const view = await host(withTabs(dev), { agentName: 'Hadi' });
    expect(view.q('[data-tab-id="chat"]').getAttribute('title')).toBe('Chat with Hadi');
    expect(view.q('[data-tab-id="console"]').getAttribute('title')).toBe('Hadi’s own CLI, live');
    expect(view.q('[data-tab-id="console"]').getAttribute('aria-label')).toBe('Console');
    expect(view.q(`[data-tab-id="${dev.id}"]`).getAttribute('title')).toBe(dev.title);
    await view.unmount();
    const unnamed = await host(withTabs(dev), { agentName: '' });
    expect(unnamed.q('[data-tab-id="console"]').getAttribute('title')).toBe("The agent's own CLI, live");
    await unnamed.unmount();
  });

  it('dismisses the close choice with Escape and closes nothing', async () => {
    const view = await host(withTabs(dev), { onEndTerminal: () => undefined });
    await interact(() => pressKey(view.q(`[data-tab-id="${dev.id}"]`), 'Delete'));
    await interact(() => pressKey(view.q('[role="menu"]'), 'Escape'));
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    expect(view.recorder.closed).toEqual([]);
    await view.unmount();
  });

  it('asks the host for a new tab in the right pane', async () => {
    const view = await host(withTabs(dev));
    await view.openMenuItem('pane-1', 'New terminal');
    expect(view.recorder.created).toEqual([['terminal', 'pane-1']]);
    await view.unmount();
  });

  it('flips the panes between side by side and stacked', async () => {
    const view = await host(withTabs(dev));
    await view.openMenuItem('pane-1', 'Stacked');
    expect(view.q(`[data-split-id="${WORKSPACE_ROOT_SPLIT_ID}"]`).dataset.direction).toBe('column');
    await view.unmount();
  });

  it('splits under a raised cap, moves tabs by menu and by drag, and collapses an emptied pane', async () => {
    const view = await host(withTabs(dev, app, login), { maxPanes: 3, drivenTabIds: new Set([dev.id]) });
    expect(view.q(`[data-tab-id="${dev.id}"]`).textContent).toContain('AGENT');
    await view.openMenuItem('pane-1', 'Split down');
    const [first, second] = workspacePaneIds(view.recorder.current());
    expect(second).toBeDefined();
    expect(view.container.querySelectorAll('[role="separator"]')).toHaveLength(2);
    // The new pane holds the moved tab; send it back with the menu.
    await view.openMenuItem(second as string, 'Move tab to other pane');
    expect(workspacePaneIds(view.recorder.current())).toEqual([first as string]);
    // Split again and drag a tab across.
    await view.openMenuItem(first as string, 'Split right');
    const [, again] = workspacePaneIds(view.recorder.current());
    await interact(() => view.q(`[data-tab-id="${dev.id}"]`).dispatchEvent(new Event('dragstart', { bubbles: true })));
    const strip = view.q(`[data-pane-id="${again}"] [role="tablist"]`);
    await interact(() => strip.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })));
    const layout = view.recorder.current();
    const target = workspacePanes(layout.root).find(pane => pane.id === again);
    expect(target?.tabs.at(-1)).toBe(dev.id);
    await view.unmount();
  });

  it('previews a divider drag locally and commits one layout change', async () => {
    const view = await host(withTabs(dev));
    const divider = view.q('[role="separator"]');
    (divider.parentElement as HTMLElement).getBoundingClientRect = () => ({ width: 1000, height: 500 }) as DOMRect;
    divider.setPointerCapture = () => undefined;
    divider.hasPointerCapture = () => false;
    const fire = (type: string, clientX: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, clientX, clientY: 0, button: 0 });
      divider.dispatchEvent(event);
    };
    const before = view.recorder.layouts.length;
    await interact(() => fire('pointerdown', 500));
    await interact(() => fire('pointermove', 300));
    const agentSide = view.q('.fy-ws-split-child');
    expect(agentSide.style.flex).toContain('0.3');
    expect(view.recorder.layouts.length).toBe(before);
    await interact(() => fire('pointerup', 300));
    expect(view.recorder.current().root).toMatchObject({ ratio: 0.3 });
    await interact(() => divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(view.recorder.current().root).toMatchObject({ ratio: 0.5 });
    await view.unmount();
  });

  it('renders a nested split preview and honours a custom minimum ratio', async () => {
    const base = withTabs(dev, app);
    const view = await host(base, { maxPanes: 3, minRatio: 0.3 });
    await view.openMenuItem('pane-1', 'Split right');
    const dividers = view.container.querySelectorAll<HTMLElement>('[role="separator"]');
    const inner = dividers[1] as HTMLElement;
    expect(inner.getAttribute('aria-valuemin')).toBe('30');
    await interact(() => pressKey(inner, 'Home'));
    const root = view.recorder.current().root;
    expect(root.type === 'split' && root.children[1].type === 'split' && root.children[1].ratio).toBe(0.3);
    await view.unmount();
  });

  it('renders a parked layout with its workspace hidden from the start', async () => {
    const view = await host(toggleWorkspacePane(withTabs(dev)));
    expect(isWorkspaceVisible(view.recorder.current())).toBe(false);
    expect((view.q('[data-pane-id="pane-1"]').parentElement as HTMLElement).hidden).toBe(true);
    await view.unmount();
  });
});

describe('workspace store hooks', () => {
  class MemoryStorage implements WorkspaceStorage {
    readonly values = new Map<string, string>();
    getItem(key: string): string | null {
      return this.values.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
      this.values.set(key, value);
    }
  }

  it('binds a session layout and the rail widths', async () => {
    const layouts = new WorkspaceLayoutStore(new MemoryStorage());
    const rails = new WorkspaceRailPreferenceStore(new MemoryStorage());
    const scope = { daemonId: 'd' as DaemonId, sessionId: 's' };
    const seen: { visible: boolean; left: number }[] = [];
    let set: ((next: WorkspaceLayout) => void) | undefined;
    let setRail: ((side: 'left' | 'right', width: number) => void) | undefined;
    function Probe() {
      const { layout, setLayout } = useWorkspaceLayout(layouts, scope);
      const { rails: widths, setRailWidth } = useWorkspaceRails(rails);
      set = setLayout;
      setRail = setRailWidth;
      seen.push({ visible: isWorkspaceVisible(layout), left: widths.left });
      return null;
    }
    const mounted = await mount(<Probe />);
    await interact(() => set?.(toggleWorkspacePane(layouts.snapshot(scope))));
    await interact(() => setRail?.('left', 300));
    expect(seen.at(-1)).toEqual({ visible: true, left: 300 });
    expect(layouts.snapshot(scope).root.type).toBe('split');
    await mounted.unmount();
  });
});
