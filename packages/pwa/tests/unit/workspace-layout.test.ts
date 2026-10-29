import { describe, expect, it } from 'bun:test';
import {
  AGENT_PANE_ID,
  activateWorkspaceTab,
  adoptAgentSurface,
  bringAskedSurfaceForward,
  canSplitWorkspacePane,
  clampWorkspaceRatio,
  closeWorkspaceTab,
  defaultWorkspaceLayout,
  focusedWorkspaceTab,
  focusWorkspacePane,
  hasAnnounced,
  isAgentTabId,
  isWorkspaceVisible,
  jumpToWorkspaceReference,
  markAnnounced,
  moveWorkspaceTab,
  openWorkspaceTab,
  parseWorkspaceLayout,
  resetWorkspaceRatio,
  serializeWorkspaceLayout,
  setWorkspaceRatio,
  setWorkspaceSplitDirection,
  splitWorkspacePane,
  toggleWorkspacePane,
  visibleTabsInOrder,
  WORKSPACE_ANNOUNCED_LIMIT,
  WORKSPACE_CHAT_TAB_ID,
  WORKSPACE_CONSOLE_TAB_ID,
  WORKSPACE_MIN_RATIO,
  WORKSPACE_ROOT_SPLIT_ID,
  type WorkspaceLayout,
  type WorkspaceTab,
  workspacePane,
  workspacePanes,
  workspaceTab,
} from '../../src/lib/workspace-layout.ts';

const dev = workspaceTab('terminal', 'dev');
const shell = workspaceTab('terminal', 'shell');
const app = workspaceTab('browser', 'app', { label: 'app', title: 'http://localhost:5173' });
const login = workspaceTab('file', 'src/login.tsx');

const ids = (layout: WorkspaceLayout): string[] => visibleTabsInOrder(layout).map(tab => tab.id);

const workspaceIds = (layout: WorkspaceLayout): string[] =>
  workspacePanes(layout.root)
    .filter(pane => pane.id !== AGENT_PANE_ID)
    .map(pane => pane.id);

/** dev + app + login in one workspace pane. */
const withThree = (): WorkspaceLayout =>
  [dev, app, login].reduce((layout, tab) => openWorkspaceTab(layout, tab), defaultWorkspaceLayout());

/** Two workspace panes, under a raised cap: [dev, app] | [login]. */
const twoWorkspacePanes = (): WorkspaceLayout => {
  const layout = withThree();
  const [paneId] = workspaceIds(layout);
  return splitWorkspacePane(layout, paneId as string, 'column', login.id, { maxPanes: 3 });
};

describe('workspace tab identity', () => {
  it('reuses the side-pane instance ids and derives labels', () => {
    expect(dev).toEqual({ id: 'terminal:dev', kind: 'terminal', key: 'dev', label: 'dev', title: 'dev' });
    expect(login.label).toBe('login.tsx');
    expect(login.title).toBe('src/login.tsx');
    expect(workspaceTab('file', '/').label).toBe('/');
    expect(app.title).toBe('http://localhost:5173');
    expect(isAgentTabId('chat')).toBe(true);
    expect(isAgentTabId('console')).toBe(true);
    expect(isAgentTabId('terminal:dev')).toBe(false);
  });
});

describe('default layout', () => {
  it('is the agent pane alone with Chat selected', () => {
    const layout = defaultWorkspaceLayout();
    expect(layout.root).toEqual({
      type: 'pane',
      id: AGENT_PANE_ID,
      tabs: ['chat', 'console', 'processes'],
      active: 'chat',
    });
    expect(isWorkspaceVisible(layout)).toBe(false);
    expect(ids(layout)).toEqual(['chat', 'console', 'processes']);
    expect(focusedWorkspaceTab(layout)).toBe(WORKSPACE_CHAT_TAB_ID);
  });
});

describe('openWorkspaceTab', () => {
  it('shows the workspace pane and opens the tab there, never in the agent pane', () => {
    const layout = openWorkspaceTab(defaultWorkspaceLayout(), dev);
    expect(isWorkspaceVisible(layout)).toBe(true);
    expect(layout.root.type === 'split' && layout.root.id).toBe(WORKSPACE_ROOT_SPLIT_ID);
    const [paneId] = workspaceIds(layout);
    expect(workspacePane(layout, paneId as string)).toMatchObject({ tabs: ['terminal:dev'], active: 'terminal:dev' });
    expect(layout.focused).toBe(paneId as string);
    expect(workspacePane(layout, AGENT_PANE_ID)?.tabs).toEqual(['chat', 'console', 'processes']);
    expect(focusedWorkspaceTab(layout)).toBe('terminal:dev');
  });

  it('focuses an already open tab instead of duplicating it, taking a fresh label', () => {
    const layout = withThree();
    const again = openWorkspaceTab(layout, dev);
    expect(ids(again)).toEqual(ids(layout));
    expect(focusedWorkspaceTab(again)).toBe('terminal:dev');
    const relabelled = openWorkspaceTab(layout, { ...app, label: 'App' });
    expect(relabelled.tabs[app.id]?.label).toBe('App');
    expect(openWorkspaceTab(layout, login)).toBe(layout);
  });

  it('focuses the agent tabs through the same call', () => {
    const layout = withThree();
    const tab = layout.tabs[WORKSPACE_CONSOLE_TAB_ID] as WorkspaceTab;
    const next = openWorkspaceTab(layout, tab);
    expect(next.focused).toBe(AGENT_PANE_ID);
    expect(focusedWorkspaceTab(next)).toBe('console');
  });

  it('honours an explicit workspace pane and ignores an agent or unknown one', () => {
    const layout = twoWorkspacePanes();
    const [first, second] = workspaceIds(layout);
    const intoFirst = openWorkspaceTab(layout, shell, { paneId: first as string });
    expect(workspacePane(intoFirst, first as string)?.tabs).toContain(shell.id);
    const intoAgent = openWorkspaceTab(layout, shell, { paneId: AGENT_PANE_ID });
    // Falls back to the focused workspace pane (the new split pane).
    expect(workspacePane(intoAgent, second as string)?.tabs).toContain(shell.id);
  });

  it('opens a parked tab by revealing the workspace', () => {
    const hidden = toggleWorkspacePane(withThree());
    const next = openWorkspaceTab(hidden, app);
    expect(isWorkspaceVisible(next)).toBe(true);
    expect(focusedWorkspaceTab(next)).toBe(app.id);
  });

  it('rejects a malformed tab record unchanged', () => {
    const layout = defaultWorkspaceLayout();
    expect(openWorkspaceTab(layout, { ...dev, id: 'terminal:other' })).toBe(layout);
    expect(openWorkspaceTab(layout, { ...dev, kind: 'browser' })).toBe(layout);
    expect(openWorkspaceTab(layout, { ...dev, id: 'nonsense' })).toBe(layout);
    expect(openWorkspaceTab(layout, { ...dev, id: 'chat' })).toBe(layout);
  });
});

describe('activateWorkspaceTab / focusWorkspacePane', () => {
  it('selects and focuses, and is a no-op when nothing changes', () => {
    const layout = withThree();
    const next = activateWorkspaceTab(layout, dev.id);
    expect(focusedWorkspaceTab(next)).toBe(dev.id);
    expect(activateWorkspaceTab(next, dev.id)).toBe(next);
    expect(activateWorkspaceTab(layout, 'terminal:missing')).toBe(layout);
    const chat = activateWorkspaceTab(layout, 'chat');
    expect(chat.focused).toBe(AGENT_PANE_ID);
  });

  it('reveals a parked tab', () => {
    const hidden = toggleWorkspacePane(withThree());
    const next = activateWorkspaceTab(hidden, dev.id);
    expect(isWorkspaceVisible(next)).toBe(true);
    expect(focusedWorkspaceTab(next)).toBe(dev.id);
  });

  it('focuses only visible panes', () => {
    const layout = withThree();
    const [paneId] = workspaceIds(layout);
    const agent = focusWorkspacePane(layout, AGENT_PANE_ID);
    expect(agent.focused).toBe(AGENT_PANE_ID);
    expect(focusWorkspacePane(agent, paneId as string).focused).toBe(paneId as string);
    expect(focusWorkspacePane(layout, layout.focused)).toBe(layout);
    expect(focusWorkspacePane(layout, 'nope')).toBe(layout);
  });
});

describe('closeWorkspaceTab', () => {
  it('never closes a pinned or unknown tab', () => {
    const layout = withThree();
    expect(closeWorkspaceTab(layout, 'chat')).toBe(layout);
    expect(closeWorkspaceTab(layout, 'console')).toBe(layout);
    expect(closeWorkspaceTab(layout, 'terminal:missing')).toBe(layout);
  });

  it('selects the neighbour of a closed active tab and keeps another selection', () => {
    const layout = withThree();
    const closedActive = closeWorkspaceTab(layout, login.id);
    expect(focusedWorkspaceTab(closedActive)).toBe(app.id);
    expect(closedActive.tabs[login.id]).toBeUndefined();
    const closedOther = closeWorkspaceTab(layout, dev.id);
    expect(focusedWorkspaceTab(closedOther)).toBe(login.id);
    const middle = closeWorkspaceTab(activateWorkspaceTab(layout, app.id), app.id);
    expect(focusedWorkspaceTab(middle)).toBe(login.id);
  });

  it('collapses an emptied workspace pane', () => {
    const one = openWorkspaceTab(defaultWorkspaceLayout(), dev);
    const closed = closeWorkspaceTab(one, dev.id);
    expect(isWorkspaceVisible(closed)).toBe(false);
    expect(closed.focused).toBe(AGENT_PANE_ID);
    const split = twoWorkspacePanes();
    const collapsed = closeWorkspaceTab(split, login.id);
    expect(workspaceIds(collapsed)).toHaveLength(1);
    expect(isWorkspaceVisible(collapsed)).toBe(true);
  });

  it('closes a parked tab without revealing the workspace', () => {
    const hidden = toggleWorkspacePane(withThree());
    const next = closeWorkspaceTab(hidden, dev.id);
    expect(isWorkspaceVisible(next)).toBe(false);
    expect(ids(next)).toEqual(['chat', 'console', 'processes', app.id, login.id]);
    const emptied = [app, login].reduce((layout, tab) => closeWorkspaceTab(layout, tab.id), next);
    expect(emptied.parked).toBeNull();
  });
});

describe('moveWorkspaceTab', () => {
  it('reorders within a pane', () => {
    const layout = withThree();
    const [paneId] = workspaceIds(layout);
    const next = moveWorkspaceTab(layout, login.id, paneId as string, 0);
    expect(ids(next)).toEqual(['chat', 'console', 'processes', login.id, dev.id, app.id]);
    const end = moveWorkspaceTab(layout, dev.id, paneId as string);
    expect(ids(end)).toEqual(['chat', 'console', 'processes', app.id, login.id, dev.id]);
    expect(moveWorkspaceTab(layout, login.id, paneId as string)).toBe(layout);
    const clamped = moveWorkspaceTab(layout, dev.id, paneId as string, 99);
    expect(ids(clamped)).toEqual(ids(end));
    const nan = moveWorkspaceTab(layout, dev.id, paneId as string, Number.NaN);
    expect(ids(nan)).toEqual(ids(end));
  });

  it('moves between panes and collapses the emptied source', () => {
    const layout = twoWorkspacePanes();
    const [first, second] = workspaceIds(layout);
    const moved = moveWorkspaceTab(layout, dev.id, second as string, 0);
    expect(workspacePane(moved, second as string)).toMatchObject({ tabs: [dev.id, login.id], active: dev.id });
    expect(moved.focused).toBe(second as string);
    const collapsed = moveWorkspaceTab(layout, login.id, first as string, -4);
    expect(workspaceIds(collapsed)).toEqual([first as string]);
    expect(workspacePane(collapsed, first as string)?.tabs).toEqual([login.id, dev.id, app.id]);
  });

  it('refuses agent tabs, the agent pane, unknown panes and a hidden workspace', () => {
    const layout = withThree();
    const [paneId] = workspaceIds(layout);
    expect(moveWorkspaceTab(layout, 'chat', paneId as string)).toBe(layout);
    expect(moveWorkspaceTab(layout, dev.id, AGENT_PANE_ID)).toBe(layout);
    expect(moveWorkspaceTab(layout, dev.id, 'nope')).toBe(layout);
    expect(moveWorkspaceTab(layout, 'terminal:missing', paneId as string)).toBe(layout);
    const hidden = toggleWorkspacePane(layout);
    expect(moveWorkspaceTab(hidden, dev.id, paneId as string)).toBe(hidden);
  });
});

describe('splitWorkspacePane', () => {
  it('respects the default cap of two panes', () => {
    const layout = withThree();
    const [paneId] = workspaceIds(layout);
    expect(canSplitWorkspacePane(layout, paneId as string)).toBe(false);
    expect(splitWorkspacePane(layout, paneId as string, 'row')).toBe(layout);
  });

  it('splits under a raised cap, moving the active tab by default', () => {
    const layout = withThree();
    const [paneId] = workspaceIds(layout);
    const next = splitWorkspacePane(layout, paneId as string, 'row', undefined, { maxPanes: 3 });
    const [, created] = workspaceIds(next);
    expect(workspacePane(next, created as string)).toMatchObject({ tabs: [login.id], active: login.id });
    expect(workspacePane(next, paneId as string)).toMatchObject({ tabs: [dev.id, app.id], active: app.id });
    expect(next.focused).toBe(created as string);
    // The cap is now reached.
    expect(canSplitWorkspacePane(next, paneId as string, { maxPanes: 3 })).toBe(false);
  });

  it('refuses the agent pane, a single-tab pane and a foreign tab', () => {
    const layout = withThree();
    const [paneId] = workspaceIds(layout);
    const cap = { maxPanes: 5 };
    expect(splitWorkspacePane(layout, AGENT_PANE_ID, 'row', undefined, cap)).toBe(layout);
    expect(splitWorkspacePane(layout, paneId as string, 'row', 'terminal:missing', cap)).toBe(layout);
    const single = openWorkspaceTab(defaultWorkspaceLayout(), dev);
    const [singlePane] = workspaceIds(single);
    expect(splitWorkspacePane(single, singlePane as string, 'row', undefined, cap)).toBe(single);
    expect(splitWorkspacePane(defaultWorkspaceLayout(), 'nope', 'row', undefined, cap)).toEqual(
      defaultWorkspaceLayout(),
    );
  });

  it('refuses a pane whose selection is empty', () => {
    const shown = toggleWorkspacePane(defaultWorkspaceLayout());
    const [paneId] = workspaceIds(shown);
    const odd: WorkspaceLayout = {
      ...shown,
      root: {
        ...(shown.root as Extract<WorkspaceLayout['root'], { type: 'split' }>),
        children: [
          workspacePane(shown, AGENT_PANE_ID) as never,
          { type: 'pane', id: paneId as string, tabs: [dev.id, app.id], active: null },
        ],
      },
    };
    expect(splitWorkspacePane(odd, paneId as string, 'row', undefined, { maxPanes: 3 })).toBe(odd);
  });
});

describe('toggleWorkspacePane', () => {
  it('shows an empty pane the first time', () => {
    const shown = toggleWorkspacePane(defaultWorkspaceLayout());
    expect(isWorkspaceVisible(shown)).toBe(true);
    const [paneId] = workspaceIds(shown);
    expect(workspacePane(shown, paneId as string)).toMatchObject({ tabs: [], active: null });
    expect(shown.focused).toBe(AGENT_PANE_ID);
  });

  it('hides and restores the same panes, tabs, direction and ratio', () => {
    const layout = setWorkspaceSplitDirection(
      setWorkspaceRatio(twoWorkspacePanes(), WORKSPACE_ROOT_SPLIT_ID, 0.3),
      WORKSPACE_ROOT_SPLIT_ID,
      'column',
    );
    const hidden = toggleWorkspacePane(layout);
    expect(isWorkspaceVisible(hidden)).toBe(false);
    expect(hidden.focused).toBe(AGENT_PANE_ID);
    expect(ids(hidden)).toEqual(ids(layout));
    const restored = toggleWorkspacePane(hidden);
    expect(restored.root).toEqual(layout.root);
    expect(restored.parked).toBeNull();
  });
});

describe('ratios and direction', () => {
  it('clamps both sides to the minimum and resets to even', () => {
    const layout = withThree();
    expect(setWorkspaceRatio(layout, WORKSPACE_ROOT_SPLIT_ID, 0.01).root).toMatchObject({ ratio: WORKSPACE_MIN_RATIO });
    expect(setWorkspaceRatio(layout, WORKSPACE_ROOT_SPLIT_ID, 0.99).root).toMatchObject({
      ratio: 1 - WORKSPACE_MIN_RATIO,
    });
    expect(setWorkspaceRatio(layout, WORKSPACE_ROOT_SPLIT_ID, 0.1, 0.05).root).toMatchObject({ ratio: 0.1 });
    const moved = setWorkspaceRatio(layout, WORKSPACE_ROOT_SPLIT_ID, 0.7);
    expect(resetWorkspaceRatio(moved, WORKSPACE_ROOT_SPLIT_ID).root).toMatchObject({ ratio: 0.5 });
    expect(setWorkspaceRatio(layout, WORKSPACE_ROOT_SPLIT_ID, 0.5)).toBe(layout);
    expect(setWorkspaceRatio(layout, WORKSPACE_ROOT_SPLIT_ID, Number.NaN)).toBe(layout);
    expect(setWorkspaceRatio(layout, WORKSPACE_ROOT_SPLIT_ID, 0.4, Number.NaN)).toBe(layout);
    expect(setWorkspaceRatio(layout, 'nope', 0.4)).toBe(layout);
    expect(setWorkspaceRatio(defaultWorkspaceLayout(), WORKSPACE_ROOT_SPLIT_ID, 0.4)).toEqual(defaultWorkspaceLayout());
  });

  it('clampWorkspaceRatio caps the minimum at an even split', () => {
    expect(clampWorkspaceRatio(0.9, 0.8)).toBe(0.5);
    expect(clampWorkspaceRatio(0.9, -1)).toBe(0.9);
  });

  it('flips a nested split and ignores a no-op', () => {
    const layout = twoWorkspacePanes();
    const inner = layout.root.type === 'split' ? layout.root.children[1] : null;
    const innerId = (inner as { id: string }).id;
    const flipped = setWorkspaceSplitDirection(layout, innerId, 'row');
    expect((flipped.root as { children: readonly { direction?: string }[] }).children[1]?.direction).toBe('row');
    expect(setWorkspaceSplitDirection(layout, innerId, 'column')).toBe(layout);
    expect(setWorkspaceSplitDirection(layout, 'nope', 'row')).toBe(layout);
    expect(setWorkspaceRatio(layout, innerId, 0.25).root).not.toEqual(layout.root);
  });
});

describe('visibleTabsInOrder / focusedWorkspaceTab', () => {
  it('lists chat, console, then every workspace tab in pane order, parked ones too', () => {
    const layout = twoWorkspacePanes();
    expect(ids(layout)).toEqual(['chat', 'console', 'processes', dev.id, app.id, login.id]);
    expect(ids(toggleWorkspacePane(layout))).toEqual(ids(layout));
  });

  it('falls back to the agent selection for an empty or missing focused pane', () => {
    const shown = toggleWorkspacePane(defaultWorkspaceLayout());
    const [paneId] = workspaceIds(shown);
    expect(focusedWorkspaceTab({ ...shown, focused: paneId as string })).toBe('chat');
    expect(focusedWorkspaceTab({ ...shown, focused: 'gone' })).toBe('chat');
  });

  it('skips a tab id with no record', () => {
    const layout = withThree();
    const { [dev.id]: _gone, ...tabs } = layout.tabs;
    expect(ids({ ...layout, tabs })).toEqual(['chat', 'console', 'processes', app.id, login.id]);
  });
});

describe('jumpToWorkspaceReference', () => {
  it('opens a referenced tab in the workspace pane, showing it', () => {
    const next = jumpToWorkspaceReference(defaultWorkspaceLayout(), { kind: 'terminal', key: 'dev' });
    expect(isWorkspaceVisible(next)).toBe(true);
    expect(focusedWorkspaceTab(next)).toBe('terminal:dev');
  });

  it('focuses an open tab, revealing a parked one', () => {
    const hidden = toggleWorkspacePane(activateWorkspaceTab(withThree(), dev.id));
    const next = jumpToWorkspaceReference(hidden, { kind: 'browser', key: 'app' });
    expect(isWorkspaceVisible(next)).toBe(true);
    expect(focusedWorkspaceTab(next)).toBe(app.id);
  });

  it('passes a label and title through', () => {
    const next = jumpToWorkspaceReference(withThree(), {
      kind: 'file',
      key: 'README.md',
      label: 'Readme',
      title: '/repo/README.md',
    });
    expect(next.tabs['file:README.md']).toMatchObject({ label: 'Readme', title: '/repo/README.md' });
    const relabel = jumpToWorkspaceReference(next, { kind: 'file', key: 'README.md', title: 'x' });
    expect(relabel.tabs['file:README.md']?.title).toBe('x');
  });
});

describe('parse / serialize', () => {
  it('round-trips a layout, including a parked one', () => {
    const layout = twoWorkspacePanes();
    expect(parseWorkspaceLayout(serializeWorkspaceLayout(layout))).toEqual(layout);
    const hidden = toggleWorkspacePane(layout);
    expect(parseWorkspaceLayout(serializeWorkspaceLayout(hidden))).toEqual(hidden);
    expect(parseWorkspaceLayout(JSON.parse(serializeWorkspaceLayout(hidden)))).toEqual(hidden);
  });

  it('adds the Processes tab to a layout saved with only Chat and Console, keeping its splits and tabs', () => {
    const saved = JSON.parse(serializeWorkspaceLayout(twoWorkspacePanes()));
    const legacyAgent = (node: { type: string; children?: unknown[]; tabs?: string[] }): void => {
      if (node.type === 'pane') node.tabs = ['chat', 'console'];
      else legacyAgent(node.children?.[0] as typeof node);
    };
    legacyAgent(saved.root);
    delete saved.tabs.processes;
    const parsed = parseWorkspaceLayout(saved);
    expect(parsed).toEqual(twoWorkspacePanes());
    expect(workspacePane(parsed, AGENT_PANE_ID)?.tabs).toEqual(['chat', 'console', 'processes']);
    expect(parsed.tabs.processes).toMatchObject({ kind: 'processes', label: 'Processes' });
  });

  it('migrates a legacy layout whose agent pane stands alone', () => {
    const alone = JSON.parse(serializeWorkspaceLayout(defaultWorkspaceLayout()));
    alone.root.tabs = ['chat', 'console'];
    delete alone.tabs.processes;
    expect(parseWorkspaceLayout(alone)).toEqual(defaultWorkspaceLayout());
  });

  it('raises seq above every restored id so new panes never collide', () => {
    const raw = JSON.parse(serializeWorkspaceLayout(twoWorkspacePanes()));
    const parsed = parseWorkspaceLayout({ ...raw, seq: 0 });
    expect(parsed.seq).toBeGreaterThanOrEqual(raw.seq);
    expect(parseWorkspaceLayout({ ...raw, seq: -1 }).seq).toBe(raw.seq);
  });

  it('refocuses a focused pane that is not visible and defaults a missing focus', () => {
    const hidden = toggleWorkspacePane(withThree());
    const raw = JSON.parse(serializeWorkspaceLayout(hidden));
    expect(parseWorkspaceLayout({ ...raw, focused: 'pane-1' }).focused).toBe(AGENT_PANE_ID);
    expect(parseWorkspaceLayout({ ...raw, focused: 7 }).focused).toBe(AGENT_PANE_ID);
  });

  const reset = defaultWorkspaceLayout();
  const good = JSON.parse(serializeWorkspaceLayout(withThree()));
  const goodHidden = JSON.parse(serializeWorkspaceLayout(toggleWorkspacePane(withThree())));
  const pane = (overrides: Record<string, unknown>) => ({
    type: 'pane',
    id: 'p',
    tabs: [],
    active: null,
    ...overrides,
  });
  const garbage: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['bad JSON', '{not json'],
    ['an array', []],
    ['an old version', { ...good, v: 0 }],
    ['no tabs record', { ...good, tabs: [] }],
    ['a bad root', { ...good, root: 'x' }],
    ['a root without an id', { ...good, root: { type: 'pane' } }],
    ['an unknown node type', { ...good, root: { type: 'grid', id: 'g' } }],
    ['bad pane tabs', { ...good, root: pane({ tabs: 'chat' }) }],
    ['non-string pane tabs', { ...good, root: pane({ tabs: [1] }) }],
    ['an active tab not in the pane', { ...good, root: pane({ id: 'agent', tabs: ['chat'], active: 'console' }) }],
    ['a null active with tabs', { ...good, root: pane({ id: 'agent', tabs: ['chat'], active: null }) }],
    ['a numeric active', { ...good, root: pane({ id: 'agent', tabs: ['chat'], active: 3 }) }],
    ['a bad direction', { ...good, root: { ...good.root, direction: 'diagonal' } }],
    ['a bad ratio', { ...good, root: { ...good.root, ratio: 'half' } }],
    ['an infinite ratio', { ...good, root: { ...good.root, ratio: null } }],
    ['one child', { ...good, root: { ...good.root, children: [good.root.children[0]] } }],
    ['a bad child', { ...good, root: { ...good.root, children: [good.root.children[0], 5] } }],
    ['a bad first child', { ...good, root: { ...good.root, children: [5, good.root.children[1]] } }],
    ['a duplicate id', { ...good, root: { ...good.root, children: [good.root.children[0], good.root.children[0]] } }],
    ['a wrong root split id', { ...good, root: { ...good.root, id: 'other' } }],
    [
      'an agent pane that is not first',
      { ...good, root: { ...good.root, children: [good.root.children[1], good.root.children[0]] } },
    ],
    [
      'an agent pane with the wrong tabs',
      {
        ...good,
        root: {
          ...good.root,
          children: [pane({ id: 'agent', tabs: ['chat'], active: 'chat' }), good.root.children[1]],
        },
      },
    ],
    ['a split as the agent side', { ...good, root: { ...good.root, children: [good.root, good.root.children[1]] } }],
    ['a bad tab record', { ...good, tabs: { ...good.tabs, chat: 'x' } }],
    ['a tab record missing fields', { ...good, tabs: { ...good.tabs, chat: { kind: 'chat' } } }],
    [
      'a tab record of the wrong kind',
      { ...good, tabs: { ...good.tabs, chat: { ...good.tabs.chat, kind: 'console' } } },
    ],
    ['a missing tab record', { ...good, tabs: { chat: good.tabs.chat, console: good.tabs.console } }],
    [
      'an extra tab record',
      { ...good, tabs: { ...good.tabs, 'terminal:x': { kind: 'terminal', key: 'x', label: 'x', title: 'x' } } },
    ],
    [
      'an agent tab in the workspace',
      {
        ...good,
        root: { ...good.root, children: [good.root.children[0], pane({ id: 'w', tabs: ['chat'], active: 'chat' })] },
      },
    ],
    [
      'a tab in two panes',
      {
        ...goodHidden,
        parked: {
          ...goodHidden.parked,
          node: pane({ id: 'w', tabs: ['terminal:dev', 'terminal:dev'], active: 'terminal:dev' }),
        },
      },
    ],
    ['parked while shown', { ...good, parked: goodHidden.parked }],
    ['a bad parked value', { ...goodHidden, parked: 5 }],
    ['a bad parked direction', { ...goodHidden, parked: { ...goodHidden.parked, direction: 'x' } }],
    ['a bad parked ratio', { ...goodHidden, parked: { ...goodHidden.parked, ratio: Number.POSITIVE_INFINITY } }],
    ['a bad parked node', { ...goodHidden, parked: { ...goodHidden.parked, node: 5 } }],
    [
      'a parked root split',
      {
        ...goodHidden,
        parked: {
          ...goodHidden.parked,
          node: {
            type: 'split',
            id: 'root',
            direction: 'row',
            ratio: 0.5,
            children: [goodHidden.parked.node, pane({ id: 'q' })],
          },
        },
      },
    ],
  ];
  for (const [what, raw] of garbage) {
    it(`resets on ${what}`, () => {
      expect(parseWorkspaceLayout(raw)).toEqual(reset);
    });
  }

  it('resets a pathologically deep tree', () => {
    let node: unknown = pane({ id: 'leaf' });
    for (let depth = 0; depth < 20; depth += 1) {
      node = {
        type: 'split',
        id: `s${depth}`,
        direction: 'row',
        ratio: 0.5,
        children: [node, pane({ id: `x${depth}` })],
      };
    }
    expect(parseWorkspaceLayout({ ...goodHidden, parked: { ...goodHidden.parked, node } })).toEqual(reset);
  });

  it('clamps a stored ratio and accepts a missing parked value', () => {
    const parsed = parseWorkspaceLayout({ ...good, root: { ...good.root, ratio: 2 }, parked: undefined });
    expect(parsed.root).toMatchObject({ ratio: 1 - WORKSPACE_MIN_RATIO });
    const hidden = parseWorkspaceLayout({ ...goodHidden, parked: { ...goodHidden.parked, ratio: -1 } });
    expect(hidden.parked?.ratio).toBe(WORKSPACE_MIN_RATIO);
  });
});

describe('agent-opened surfaces', () => {
  const opened = workspaceTab('terminal', 'a1b2c3d4e5f6', { label: 'dev', title: 'Terminal dev' });
  const alias = 'terminal:dev';

  it('adds the tab once, shows the workspace, and leaves the focus and the selected tab alone', () => {
    // Arrange
    const start = openWorkspaceTab(defaultWorkspaceLayout(), dev);
    const beforeFocus = start.focused;

    // Act
    const adopted = adoptAgentSurface(start, opened, 'open:terminal:a1b2c3d4e5f6');

    // Assert
    expect(ids(adopted)).toContain(opened.id);
    expect(adopted.focused).toBe(beforeFocus);
    expect(focusedWorkspaceTab(adopted)).toBe(focusedWorkspaceTab(start));
    expect(adopted.tabs[opened.id]).toEqual(opened);
    expect(hasAnnounced(adopted, 'open:terminal:a1b2c3d4e5f6')).toBe(true);
  });

  it('becomes the active tab only when its pane had none', () => {
    const adopted = adoptAgentSurface(defaultWorkspaceLayout(), opened, 'open:one');
    const pane = workspacePanes(adopted.root).find(candidate => candidate.id !== AGENT_PANE_ID);
    expect(pane?.active).toBe(opened.id);
    const second = adoptAgentSurface(adopted, shell, 'open:two');
    const same = workspacePanes(second.root).find(candidate => candidate.id !== AGENT_PANE_ID);
    expect(same?.active).toBe(opened.id);
    expect(same?.tabs).toEqual([opened.id, shell.id]);
  });

  it('does it once: a tab the owner closed stays closed, and an announcement made is a no-op', () => {
    // Arrange
    const adopted = adoptAgentSurface(defaultWorkspaceLayout(), opened, 'open:one');

    // Act
    const closed = closeWorkspaceTab(adopted, opened.id);
    const again = adoptAgentSurface(closed, opened, 'open:one');

    // Assert
    expect(again).toBe(closed);
    expect(ids(again)).not.toContain(opened.id);
  });

  it('does not add a second tab for a surface already open under another id, but remembers it', () => {
    const existing = openWorkspaceTab(defaultWorkspaceLayout(), dev);
    const adopted = adoptAgentSurface(existing, opened, 'open:one', [alias]);
    expect(Object.keys(adopted.tabs)).toEqual(Object.keys(existing.tabs));
    expect(hasAnnounced(adopted, 'open:one')).toBe(true);
    expect(adopted.root).toBe(existing.root);
  });

  it('refuses a malformed tab and the pinned agent tabs', () => {
    const layout = defaultWorkspaceLayout();
    expect(adoptAgentSurface(layout, { ...opened, key: 'other' }, 'open:bad')).toBe(layout);
    const chat: WorkspaceTab = { id: WORKSPACE_CHAT_TAB_ID, kind: 'chat', key: 'chat', label: 'Chat', title: 'Chat' };
    expect(adoptAgentSurface(layout, chat, 'open:chat')).toBe(layout);
    expect(bringAskedSurfaceForward(layout, chat, 'ask:chat')).toBe(layout);
  });

  it('brings an asked surface forward: opens it when missing, focuses it, and does so once per ask', () => {
    // Arrange
    const layout = openWorkspaceTab(defaultWorkspaceLayout(), dev);

    // Act
    const forward = bringAskedSurfaceForward(layout, opened, 'ask:1');
    const moved = focusWorkspacePane(forward, AGENT_PANE_ID);
    const repeat = bringAskedSurfaceForward(moved, opened, 'ask:1');

    // Assert
    expect(focusedWorkspaceTab(forward)).toBe(opened.id);
    expect(repeat).toBe(moved);
    expect(focusedWorkspaceTab(bringAskedSurfaceForward(moved, opened, 'ask:2'))).toBe(opened.id);
  });

  it('activates the tab that is already open, under its alias, instead of adding another', () => {
    const layout = openWorkspaceTab(openWorkspaceTab(defaultWorkspaceLayout(), dev), shell);
    const forward = bringAskedSurfaceForward(layout, opened, 'ask:1', [alias]);
    expect(focusedWorkspaceTab(forward)).toBe(alias);
    expect(forward.tabs[opened.id]).toBeUndefined();
  });

  it('keeps the announcements capped, drops non-strings on parse, and omits them while empty', () => {
    // Arrange
    let layout = defaultWorkspaceLayout();
    for (let count = 0; count < WORKSPACE_ANNOUNCED_LIMIT + 5; count += 1) layout = markAnnounced(layout, `a${count}`);

    // Act
    const raw = JSON.parse(serializeWorkspaceLayout(layout));
    const parsed = parseWorkspaceLayout({ ...raw, announced: ['x', 3, 'y'] });

    // Assert
    expect(layout.announced).toHaveLength(WORKSPACE_ANNOUNCED_LIMIT);
    expect(hasAnnounced(layout, 'a0')).toBe(false);
    expect(hasAnnounced(layout, `a${WORKSPACE_ANNOUNCED_LIMIT + 4}`)).toBe(true);
    expect(markAnnounced(layout, `a${WORKSPACE_ANNOUNCED_LIMIT + 4}`)).toBe(layout);
    expect(parsed.announced).toEqual(['x', 'y']);
    expect('announced' in parseWorkspaceLayout(JSON.parse(serializeWorkspaceLayout(defaultWorkspaceLayout())))).toBe(
      false,
    );
    expect('announced' in parseWorkspaceLayout({ ...raw, announced: 'nope' })).toBe(false);
    expect(parseWorkspaceLayout(raw).announced).toHaveLength(WORKSPACE_ANNOUNCED_LIMIT);
  });
});
