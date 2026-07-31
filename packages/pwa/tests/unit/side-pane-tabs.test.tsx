import { describe, expect, it } from 'bun:test';
import {
  nextSidePaneTab,
  SidePaneTabPickerList,
  SidePaneTabs,
  SidePaneTabSwitcherList,
  sidePanePanelId,
  sidePaneTabId,
} from '../../src/shell/side-pane-tabs.tsx';
import type { SidePaneTabDefinition } from '../../src/shell/side-pane-tab-model.ts';
import { interact, mount, pressKey } from '../support/dom.ts';

const singleton = (id: string, label: string, extra: Partial<SidePaneTabDefinition> = {}): SidePaneTabDefinition => ({
  id,
  label,
  shortLabel: label.slice(0, 4),
  closeLabel: `Close ${label}`,
  icon: 'pins',
  order: 10,
  ...extra,
});

const fileTab = (path: string): SidePaneTabDefinition => {
  const basename = path.split('/').pop() ?? path;
  return {
    id: `file:${path}`,
    label: path,
    shortLabel: basename,
    closeLabel: `Close ${basename}`,
    icon: 'file',
    order: 1001,
    instance: {
      id: `file:${path}`,
      kind: 'file',
      key: path,
      label: basename,
      title: path,
      order: 1,
      revision: 1,
    },
  };
};

const browserCatalogue = singleton('browser', 'Browser', { icon: 'browser', instanceKind: 'browser', order: 80 });
const mcp = singleton('mcp', 'MCP', { icon: 'mcp', unavailableReason: 'No MCP data source is connected yet.' });

const tabs = [singleton('pins', 'Pins'), singleton('tasks', 'Tasks'), fileTab('src/api.ts')];
const all = [singleton('pins', 'Pins'), singleton('tasks', 'Tasks'), mcp, browserCatalogue];

interface Calls {
  selected: string[];
  added: string[];
  removed: string[];
  spawned: string[];
}

const emptyCalls = (): Calls => ({ selected: [], added: [], removed: [], spawned: [] });

const strip = (calls: Calls, current = 'pins', withSpawn = true) => (
  <SidePaneTabs
    paneId="pane"
    presentation="pane"
    tabs={tabs}
    all={all}
    current={current}
    onSelect={id => calls.selected.push(id)}
    onAdd={id => calls.added.push(id)}
    onRemove={id => calls.removed.push(id)}
    {...(withSpawn ? { onNewInstance: (kind: string) => calls.spawned.push(kind) } : {})}
  />
);

const control = (calls: Calls, current = 'pins') => (
  <SidePaneTabs
    paneId="pane"
    presentation="sheet"
    tabs={tabs}
    all={all}
    current={current}
    onSelect={id => calls.selected.push(id)}
    onAdd={id => calls.added.push(id)}
    onRemove={id => calls.removed.push(id)}
    onNewInstance={kind => calls.spawned.push(kind)}
  />
);

const byLabel = (container: HTMLElement, label: string): HTMLElement =>
  container.querySelector(`[aria-label="${label}"]`) as HTMLElement;

describe('tab element ids', () => {
  it('names the tab and its panel from the pane and the surface', () => {
    expect(sidePaneTabId('pane-1', 'pins')).toBe('pane-1-tab-pins');
    expect(sidePanePanelId('pane-1', 'pins')).toBe('pane-1-tabpanel-pins');
  });
});

describe('nextSidePaneTab', () => {
  const order = ['a', 'b', 'c'] as const;

  it('wraps around in both directions', () => {
    expect(nextSidePaneTab('ArrowRight', 'c', order)).toBe('a');
    expect(nextSidePaneTab('ArrowDown', 'a', order)).toBe('b');
    expect(nextSidePaneTab('ArrowLeft', 'a', order)).toBe('c');
    expect(nextSidePaneTab('ArrowUp', 'b', order)).toBe('a');
  });

  it('jumps to the ends', () => {
    expect(nextSidePaneTab('Home', 'c', order)).toBe('a');
    expect(nextSidePaneTab('End', 'a', order)).toBe('c');
  });

  it('claims no other key, and no key at all for a tab outside the order', () => {
    expect(nextSidePaneTab('Enter', 'a', order)).toBeNull();
    expect(nextSidePaneTab('ArrowRight', 'z', order)).toBeNull();
    expect(nextSidePaneTab('Home', 'a', [])).toBeNull();
  });
});

describe('desktop strip', () => {
  it('is a real tablist that scrolls in one direction only', async () => {
    const view = await mount(strip(emptyCalls()));
    const tablist = view.container.querySelector('[role="tablist"]') as HTMLElement;

    expect(tablist.getAttribute('aria-label')).toBe('Side pane tabs');
    expect(tablist.className).toContain('overflow-x-auto');
    expect(tablist.className).toContain('overflow-y-hidden');
    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(3);

    await view.unmount();
  });

  it('keeps exactly one roving tab stop, on the active tab', async () => {
    const view = await mount(strip(emptyCalls(), 'tasks'));
    const stops = [...view.container.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute('tabindex'));

    expect(stops).toEqual(['-1', '0', '-1']);
    await view.unmount();
  });

  it('falls back to the first tab for a stop when the active tab has no strip entry', async () => {
    const view = await mount(strip(emptyCalls(), 'vanished'));
    const stops = [...view.container.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute('tabindex'));

    expect(stops).toEqual(['0', '-1', '-1']);
    expect(
      [...view.container.querySelectorAll('[role="tab"]')].every(tab => tab.getAttribute('aria-selected') === 'false'),
    ).toBe(true);
    await view.unmount();
  });

  it('gives an instance tab its full path as the accessible name and a Delete shortcut', async () => {
    const view = await mount(strip(emptyCalls()));
    const instance = byLabel(view.container, 'src/api.ts');

    expect(instance.getAttribute('aria-keyshortcuts')).toBe('Delete');
    expect(instance.getAttribute('title')).toBe('src/api.ts');
    expect(instance.textContent).toContain('api.ts');

    const singletonTab = byLabel(view.container, 'Pins');
    expect(singletonTab.getAttribute('aria-keyshortcuts')).toBeNull();

    await view.unmount();
  });

  it('selects on click, and never re-selects the tab already showing', async () => {
    const calls = emptyCalls();
    const view = await mount(strip(calls));

    await interact(() => byLabel(view.container, 'Tasks').click());
    await interact(() => byLabel(view.container, 'Pins').click());

    expect(calls.selected).toEqual(['tasks']);
    await view.unmount();
  });

  it('moves selection with the arrow keys and the Home/End keys', async () => {
    const calls = emptyCalls();
    const view = await mount(strip(calls));
    const pins = byLabel(view.container, 'Pins');

    await interact(() => pressKey(pins, 'ArrowRight'));
    await interact(() => pressKey(pins, 'ArrowLeft'));
    await interact(() => pressKey(pins, 'End'));
    await interact(() => pressKey(pins, 'Enter'));

    expect(calls.selected).toEqual(['tasks', 'file:src/api.ts', 'file:src/api.ts']);
    await view.unmount();
  });

  it('closes an instance tab with Delete, and leaves Delete alone on a singleton', async () => {
    const calls = emptyCalls();
    const view = await mount(strip(calls));

    await interact(() => pressKey(byLabel(view.container, 'src/api.ts'), 'Delete'));
    await interact(() => pressKey(byLabel(view.container, 'Pins'), 'Delete'));

    expect(calls.removed).toEqual(['file:src/api.ts']);
    await view.unmount();
  });

  it('closes an instance tab with the pointer ✕ without also selecting it', async () => {
    const calls = emptyCalls();
    const view = await mount(strip(calls));
    const close = view.container.querySelector('[role="presentation"]') as HTMLElement;

    expect(close.getAttribute('title')).toBe('Close api.ts');
    await interact(() => close.click());

    expect(calls.removed).toEqual(['file:src/api.ts']);
    expect(calls.selected).toEqual([]);
    await view.unmount();
  });

  it('opens the + picker, marks what is already in the strip, and dismisses on an outside pointer', async () => {
    const calls = emptyCalls();
    const view = await mount(strip(calls));
    const trigger = byLabel(view.container, 'Add or remove tabs');

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await interact(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(
      view.container.querySelector('[role="dialog"]')?.getAttribute('id') ?? '',
    );

    expect(byLabel(view.container, 'Remove Pins tab').getAttribute('aria-pressed')).toBe('true');
    expect(byLabel(view.container, 'Add MCP tab').getAttribute('aria-pressed')).toBe('false');

    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();

    await view.unmount();
  });

  it('keeps the picker open for a pointer inside it or on its trigger', async () => {
    const view = await mount(strip(emptyCalls()));
    const trigger = byLabel(view.container, 'Add or remove tabs');
    await interact(() => trigger.click());

    const popover = view.container.querySelector('[role="dialog"]') as HTMLElement;
    await interact(() => popover.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();

    await interact(() => trigger.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();

    await view.unmount();
  });

  it('closes the picker on Escape and returns focus to its trigger', async () => {
    const view = await mount(strip(emptyCalls()));
    const trigger = byLabel(view.container, 'Add or remove tabs');
    await interact(() => trigger.click());

    await interact(() => pressKey(document, 'Escape'));

    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    await interact(async () => {
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    });
    expect(document.activeElement).toBe(trigger);

    await view.unmount();
  });

  it('ignores other keys while the picker is open', async () => {
    const view = await mount(strip(emptyCalls()));
    await interact(() => byLabel(view.container, 'Add or remove tabs').click());

    await interact(() => pressKey(document, 'a'));

    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    await view.unmount();
  });

  it('adds, removes and spawns from the picker', async () => {
    const calls = emptyCalls();
    const view = await mount(strip(calls));
    await interact(() => byLabel(view.container, 'Add or remove tabs').click());

    await interact(() => byLabel(view.container, 'Add MCP tab').click());
    await interact(() => byLabel(view.container, 'Remove Pins tab').click());
    await interact(() => byLabel(view.container, 'New Browser tab').click());

    expect(calls.added).toEqual(['mcp']);
    expect(calls.removed).toEqual(['pins']);
    expect(calls.spawned).toEqual(['browser']);
    await view.unmount();
  });

  it('falls back to a plain add when no instance spawner is supplied', async () => {
    const calls = emptyCalls();
    const view = await mount(strip(calls, 'pins', false));
    await interact(() => byLabel(view.container, 'Add or remove tabs').click());

    await interact(() => byLabel(view.container, 'New Browser tab').click());

    expect(calls.added).toEqual(['browser']);
    expect(calls.spawned).toEqual([]);
    await view.unmount();
  });
});

describe('picker rows', () => {
  it('says what an instance entry and an unavailable entry actually are', async () => {
    const view = await mount(<SidePaneTabPickerList all={all} openIds={[]} onAdd={() => {}} onRemove={() => {}} />);

    expect(byLabel(view.container, 'New Browser tab').textContent).toContain('Opens a new tab');
    expect(byLabel(view.container, 'New Browser tab').getAttribute('aria-pressed')).toBeNull();
    expect(byLabel(view.container, 'Add MCP tab').textContent).toContain('Unavailable');

    await view.unmount();
  });
});

describe('phone control', () => {
  it('is never a tablist — one 44px control naming the active tab', async () => {
    const view = await mount(control(emptyCalls()));
    const trigger = byLabel(view.container, 'Switch tab — Pins is showing');

    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(view.container.querySelector('[role="tab"]')).toBeNull();
    expect(trigger.className).toContain('min-h-[44px]');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');

    await view.unmount();
  });

  it('names an instance tab by its short label', async () => {
    const view = await mount(control(emptyCalls(), 'file:src/api.ts'));

    expect(byLabel(view.container, 'Switch tab — api.ts is showing')).not.toBeNull();
    await view.unmount();
  });

  it('says so honestly when nothing is showing', async () => {
    const view = await mount(control(emptyCalls(), 'vanished'));
    const trigger = byLabel(view.container, 'Switch tab');

    expect(trigger.textContent).toContain('Choose a tab');
    await view.unmount();
  });

  it('opens the switcher modal, and every pick closes it again', async () => {
    const calls = emptyCalls();
    const view = await mount(control(calls));

    await interact(() => byLabel(view.container, 'Switch tab — Pins is showing').click());
    expect(byLabel(view.container, 'Switch tab').getAttribute('role')).toBe('dialog');

    await interact(() => byLabel(view.container, 'Tasks').click());

    expect(calls.selected).toEqual(['tasks']);
    expect(view.container.querySelector('[data-bottom-sheet]')?.getAttribute('aria-hidden')).toBe('true');
    await view.unmount();
  });

  it('offers per-tab close in the switcher, naming instances by what they close', async () => {
    const calls = emptyCalls();
    const view = await mount(control(calls));
    await interact(() => byLabel(view.container, 'Switch tab — Pins is showing').click());

    await interact(() => byLabel(view.container, 'Close api.ts tab').click());
    await interact(() => byLabel(view.container, 'Remove Tasks tab').click());

    expect(calls.removed).toEqual(['file:src/api.ts', 'tasks']);
    await view.unmount();
  });
});

describe('switcher list', () => {
  it('marks the current tab and lists only closed catalogue entries under Add a tab', async () => {
    const view = await mount(
      <SidePaneTabSwitcherList
        tabs={tabs}
        all={all}
        current="tasks"
        onSelect={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(byLabel(view.container, 'Tasks').getAttribute('aria-current')).toBe('true');
    expect(byLabel(view.container, 'Pins').getAttribute('aria-current')).toBeNull();
    expect(view.container.textContent).toContain('Add a tab');
    // An instanceKind entry stays offered even while pages are open.
    expect(byLabel(view.container, 'New Browser tab')).not.toBeNull();
    expect(byLabel(view.container, 'Add MCP tab')).not.toBeNull();
    expect(byLabel(view.container, 'Add Pins tab')).toBeNull();

    await view.unmount();
  });

  it('drops the Add section entirely when the catalogue is exhausted', async () => {
    const view = await mount(
      <SidePaneTabSwitcherList
        tabs={tabs}
        all={[singleton('pins', 'Pins'), singleton('tasks', 'Tasks')]}
        current="pins"
        onSelect={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(view.container.textContent).not.toContain('Add a tab');
    await view.unmount();
  });

  it('adds a closed tab from the switcher', async () => {
    const added: string[] = [];
    const view = await mount(
      <SidePaneTabSwitcherList
        tabs={tabs}
        all={all}
        current="pins"
        onSelect={() => {}}
        onAdd={id => added.push(id)}
        onRemove={() => {}}
      />,
    );

    await interact(() => byLabel(view.container, 'Add MCP tab').click());

    expect(added).toEqual(['mcp']);
    await view.unmount();
  });
});
