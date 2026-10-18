import { describe, expect, it } from 'bun:test';
import {
  type WorkspaceNewTabKind,
  WorkspaceTabStrip,
  type WorkspaceTabStripProps,
  workspacePanelElementId,
  workspaceTabElementId,
} from '../../../src/features/workspace/workspace-tab-strip.tsx';
import { defaultWorkspaceLayout, type WorkspaceTab, workspaceTab } from '../../../src/lib/workspace-layout.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const agentTabs = Object.values(defaultWorkspaceLayout().tabs) as WorkspaceTab[];
const dev = workspaceTab('terminal', 'dev');
const app = workspaceTab('browser', 'app');
const login = workspaceTab('file', 'src/login.tsx');

interface Calls {
  activated: string[];
  closed: string[];
  dragged: (string | null)[];
  dropped: [string, number][];
  toggled: number;
  created: WorkspaceNewTabKind[];
}

const render = async (overrides: Partial<WorkspaceTabStripProps> = {}) => {
  const calls: Calls = { activated: [], closed: [], dragged: [], dropped: [], toggled: 0, created: [] };
  const props: WorkspaceTabStripProps = {
    paneId: 'pane-1',
    idPrefix: 'ws',
    tabs: [dev, app, login],
    active: app.id,
    agentPane: false,
    workspaceVisible: true,
    draggingTabId: null,
    onActivate: id => calls.activated.push(id),
    onClose: id => calls.closed.push(id),
    onDragTab: id => calls.dragged.push(id),
    onDropTab: (id, index) => calls.dropped.push([id, index]),
    onToggleWorkspace: () => {
      calls.toggled += 1;
    },
    onNewTab: kind => calls.created.push(kind),
    ...overrides,
  };
  const mounted = await mount(<WorkspaceTabStrip {...props} />);
  const tab = (id: string) =>
    must(mounted.container.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"]`), `tab ${id}`);
  return { ...mounted, calls, tab };
};

const dragEvent = (type: string, withTransfer: boolean) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  if (withTransfer) {
    const data: Record<string, string> = {};
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        effectAllowed: 'none',
        dropEffect: 'none',
        setData: (format: string, value: string) => {
          data[format] = value;
        },
        data,
      },
    });
  }
  return event;
};

describe('WorkspaceTabStrip ids', () => {
  it('derives tab and panel element ids', () => {
    expect(workspaceTabElementId('ws', 'terminal:dev')).toBe('ws-tab-terminal:dev');
    expect(workspacePanelElementId('ws', 'terminal:dev')).toBe('ws-panel-terminal:dev');
  });
});

describe('WorkspaceTabStrip — agent pane', () => {
  it('pins Chat and Console with no close or drag, and offers the ⫼ toggle', async () => {
    const strip = await render({ agentPane: true, tabs: agentTabs, active: 'chat', workspaceVisible: false });
    const tablist = must(strip.container.querySelector('[role="tablist"]'), 'tablist');
    expect(tablist.getAttribute('aria-label')).toBe('Agent tabs');
    const chat = strip.tab('chat');
    expect(chat.getAttribute('aria-selected')).toBe('true');
    expect(chat.getAttribute('draggable')).toBe('false');
    expect(chat.getAttribute('aria-keyshortcuts')).toBeNull();
    expect(strip.container.querySelector('[data-tab-close]')).toBeNull();
    expect(strip.container.querySelector('[aria-haspopup="menu"]')).toBeNull();
    const toggle = must(strip.container.querySelector<HTMLButtonElement>('[aria-pressed]'), 'toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Show workspace pane');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await interact(() => toggle.click());
    expect(strip.calls.toggled).toBe(1);
    await interact(() => pressKey(chat, 'Delete'));
    expect(strip.calls.closed).toEqual([]);
    await interact(() => pressKey(chat, 'ArrowRight'));
    expect(strip.calls.activated).toEqual(['console']);
    // Nothing drops into the agent pane, even mid-drag.
    await strip.unmount();
    const dragging = await render({ agentPane: true, tabs: agentTabs, active: 'chat', draggingTabId: dev.id });
    await interact(() => dragging.tab('chat').dispatchEvent(dragEvent('drop', false)));
    expect(dragging.calls.dropped).toEqual([]);
    expect(must(dragging.container.querySelector('[aria-pressed]'), 'toggle').getAttribute('aria-label')).toBe(
      'Hide workspace pane',
    );
    await dragging.unmount();
  });
});

describe('WorkspaceTabStrip — workspace pane', () => {
  it('selects, closes by ✕ and Delete, and moves focus with arrows', async () => {
    const strip = await render({ drivenTabIds: new Set([dev.id]) });
    expect(strip.tab(app.id).tabIndex).toBe(0);
    expect(strip.tab(dev.id).tabIndex).toBe(-1);
    expect(strip.tab(dev.id).getAttribute('aria-label')).toBe('dev, agent is driving');
    expect(strip.tab(dev.id).textContent).toContain('AGENT');
    expect(strip.tab(app.id).textContent).not.toContain('AGENT');
    expect(strip.tab(login.id).title).toBe('src/login.tsx');
    await interact(() => strip.tab(dev.id).click());
    await interact(() => strip.tab(app.id).click());
    expect(strip.calls.activated).toEqual([dev.id]);
    const close = must(strip.tab(login.id).querySelector<HTMLElement>('[data-tab-close]'), 'close');
    await interact(() => close.click());
    await interact(() => pressKey(strip.tab(dev.id), 'Delete'));
    expect(strip.calls.closed).toEqual([login.id, dev.id]);
    await interact(() => pressKey(strip.tab(app.id), 'End'));
    await interact(() => pressKey(strip.tab(app.id), 'q'));
    expect(strip.calls.activated).toEqual([dev.id, login.id]);
    expect(document.activeElement).toBe(strip.tab(login.id));
    await strip.unmount();
  });

  it('closes a workspace tab on a middle-click, never an agent tab, and holds off autoscroll', async () => {
    const mouse = (target: HTMLElement, type: string, button: number): MouseEvent => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
      target.dispatchEvent(event);
      return event;
    };
    const strip = await render();
    expect(mouse(strip.tab(login.id), 'mousedown', 1).defaultPrevented).toBe(true);
    expect(mouse(strip.tab(login.id), 'mousedown', 0).defaultPrevented).toBe(false);
    await interact(() => mouse(strip.tab(login.id), 'auxclick', 1));
    // A right button's auxclick is the context menu's, not a close.
    await interact(() => mouse(strip.tab(dev.id), 'auxclick', 2));
    expect(strip.calls.closed).toEqual([login.id]);
    await strip.unmount();

    const agent = await render({ agentPane: true, tabs: agentTabs, active: 'chat' });
    expect(mouse(agent.tab('chat'), 'mousedown', 1).defaultPrevented).toBe(false);
    await interact(() => mouse(agent.tab('console'), 'auxclick', 1));
    expect(agent.calls.closed).toEqual([]);
    await agent.unmount();
  });

  it('makes the first tab the focus stop when nothing is selected', async () => {
    const strip = await render({ active: null });
    expect(strip.tab(dev.id).tabIndex).toBe(0);
    await strip.unmount();
  });

  it('drags a tab out and drops one in at the hovered position or the end', async () => {
    const strip = await render();
    const start = dragEvent('dragstart', true);
    await interact(() => strip.tab(dev.id).dispatchEvent(start));
    expect((start as unknown as { dataTransfer: { data: Record<string, string> } }).dataTransfer.data).toEqual({
      'text/plain': dev.id,
    });
    await interact(() => strip.tab(dev.id).dispatchEvent(dragEvent('dragstart', false)));
    await interact(() => strip.tab(dev.id).dispatchEvent(dragEvent('dragend', false)));
    expect(strip.calls.dragged).toEqual([dev.id, dev.id, null]);
    // Not accepting (no drag in flight): over and drop do nothing.
    const idle = dragEvent('dragover', false);
    await interact(() => strip.tab(app.id).dispatchEvent(idle));
    expect(idle.defaultPrevented).toBe(false);
    await strip.unmount();

    const target = await render({ draggingTabId: 'terminal:other' });
    const tablist = must(target.container.querySelector<HTMLElement>('[role="tablist"]'), 'tablist');
    expect(tablist.getAttribute('data-drop-target')).toBe('true');
    const over = dragEvent('dragover', true);
    await interact(() => target.tab(app.id).dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    await interact(() => target.tab(app.id).dispatchEvent(dragEvent('dragover', false)));
    await interact(() => target.tab(app.id).dispatchEvent(dragEvent('drop', false)));
    await interact(() => tablist.dispatchEvent(dragEvent('drop', false)));
    const stray = document.createElement('span');
    stray.dataset.tabId = 'unknown';
    tablist.appendChild(stray);
    await interact(() => stray.dispatchEvent(dragEvent('drop', false)));
    expect(target.calls.dropped).toEqual([
      ['terminal:other', 1],
      ['terminal:other', 3],
      ['terminal:other', 3],
    ]);
    expect(target.calls.dragged).toEqual([null, null, null]);
    await target.unmount();
  });

  it('opens the ＋ menu with the create commands only', async () => {
    const strip = await render();
    const trigger = must(strip.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]'), 'trigger');
    await interact(() => trigger.click());
    const menu = must(strip.container.querySelector<HTMLElement>('[role="menu"]'), 'menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual(['New terminal', 'New browser', 'Open file']);
    expect(document.activeElement).toBe(items[0] as Element);
    await interact(() => pressKey(menu, 'ArrowUp'));
    expect(document.activeElement).toBe(items[2] as Element);
    await interact(() => pressKey(menu, 'ArrowDown'));
    expect(document.activeElement).toBe(items[0] as Element);
    await interact(() => pressKey(menu, 'Tab'));
    await interact(() => (items[1] as HTMLButtonElement).click());
    expect(strip.calls.created).toEqual(['browser']);
    expect(strip.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    for (const index of [0, 2]) {
      await interact(() => trigger.click());
      const again = must(strip.container.querySelector<HTMLElement>('[role="menu"]'), 'menu');
      await interact(() =>
        (again.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index] as HTMLButtonElement).click(),
      );
    }
    expect(strip.calls.created).toEqual(['browser', 'terminal', 'file']);
    await strip.unmount();
  });

  it('closes the menu on Escape and on an outside pointer, but not on its trigger', async () => {
    const strip = await render();
    const trigger = must(strip.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]'), 'trigger');
    await interact(() => trigger.click());
    await interact(() => pressKey(must(strip.container.querySelector('[role="menu"]'), 'menu'), 'Escape'));
    expect(strip.container.querySelector('[role="menu"]')).toBeNull();
    await interact(() => trigger.click());
    const menu = must(strip.container.querySelector<HTMLElement>('[role="menu"]'), 'menu');
    await interact(() => menu.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await interact(() => trigger.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(strip.container.querySelector('[role="menu"]')).not.toBeNull();
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(strip.container.querySelector('[role="menu"]')).toBeNull();
    await strip.unmount();
  });

  it('adds the layout commands it is given', async () => {
    const ran: string[] = [];
    const strip = await render({
      layoutControls: {
        onSplit: direction => ran.push(`split:${direction}`),
        direction: 'row',
        onSetDirection: direction => ran.push(`dir:${direction}`),
        onMoveActiveToOtherPane: () => ran.push('move'),
      },
    });
    const trigger = must(strip.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]'), 'trigger');
    const labels = ['Split right', 'Split down', 'Side by side', 'Stacked', 'Move tab to other pane'];
    for (const label of labels) {
      await interact(() => trigger.click());
      const menu = must(strip.container.querySelector<HTMLElement>('[role="menu"]'), 'menu');
      expect(menu.querySelectorAll('hr')).toHaveLength(1);
      const item = must(
        [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(node => node.textContent === label),
        label,
      );
      if (label === 'Side by side') expect(item.getAttribute('aria-checked')).toBe('true');
      if (label === 'Stacked') expect(item.getAttribute('aria-checked')).toBe('false');
      await interact(() => item.click());
    }
    expect(ran).toEqual(['split:row', 'split:column', 'dir:row', 'dir:column', 'move']);
    await strip.unmount();
  });

  it('skips a direction choice it cannot act on', async () => {
    const strip = await render({ layoutControls: { direction: 'row' } });
    await interact(() =>
      must(strip.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]'), 'trigger').click(),
    );
    expect(strip.container.querySelectorAll('hr')).toHaveLength(0);
    await strip.unmount();
  });
});
