import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { FileInstanceSurface } from '../../../src/components/file-instance-surface.tsx';
import { FilesTab } from '../../../src/components/files-tab.tsx';
import { SessionTerminalDeck } from '../../../src/components/session-terminal-deck.tsx';
import type { BrowserAction, BrowserPageSummary, BrowserStatus } from '@ferretry/protocol';
import { BrowserSurfaceList } from '../../../src/features/browser/browser-surface-list.tsx';
import {
  browserEngineForSession,
  resetBrowserSurfaceSessions,
} from '../../../src/features/browser/unified-browser-model.ts';
import { UnifiedBrowserSurface } from '../../../src/features/browser/unified-browser-surface.tsx';
import type { SessionBrowser } from '../../../src/features/browser/use-session-browser.ts';
import { ContextRail } from '../../../src/features/context-rail/context-rail.tsx';
import { ContextRailBody } from '../../../src/features/context-rail/context-rail-body.tsx';
import { SessionSearchProvider } from '../../../src/features/session-search/session-search.tsx';
import { AgentControlMarker } from '../../../src/features/workspace/agent-control-marker.tsx';
import { ContextSheet, ContextSheetButton } from '../../../src/features/workspace/phone/context-sheet.tsx';
import type { WorkspaceFormFactor } from '../../../src/features/workspace/phone/phone-tab.ts';
import { PhoneWorkspace } from '../../../src/features/workspace/phone/phone-workspace.tsx';
import {
  type SessionContextPlacement,
  type SessionContextRailProps,
  SessionWorkspace,
  type SessionWorkspaceProps,
  useContextPlacement,
} from '../../../src/features/workspace/session-workspace.tsx';
import { RailDivider } from '../../../src/features/workspace/split-divider.tsx';
import {
  type SessionWorkspaceController,
  useSessionWorkspace,
  WORKSPACE_FILES_PICKER_KEY,
} from '../../../src/features/workspace/use-session-workspace.ts';
import {
  NO_SURFACE_DRIVING,
  type SurfaceDriving,
  useSurfaceDriving,
} from '../../../src/features/workspace/use-surface-driving.ts';
import {
  SESSION_TERMINALS_POLL_MS,
  useSessionTerminals,
  useWorkspaceFormFactor,
} from '../../../src/features/workspace/use-workspace-environment.ts';
import { WorkspaceView } from '../../../src/features/workspace/workspace-view.tsx';
import { ConsoleSurface } from '../../../src/features/workspace/console-surface.tsx';
import { ContextMenu } from '../../../src/shell/context-menu.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { openWorkspaceTab, workspaceTab } from '../../../src/lib/workspace-layout.ts';
import { WorkspaceLayoutStore } from '../../../src/lib/workspace-layout-store.ts';
import { WorkspaceRailPreferenceStore } from '../../../src/lib/workspace-rail-preferences.ts';
import '../../support/dom.ts';
import { render, run, runAsync } from '../../support/react.ts';
import { sessionView } from '../../support/sessions.ts';
import { fakeDeck, terminalListing, terminalView } from '../../support/terminal-deck.ts';
import { DOCS, fakeSignals, MCP, SKILLS } from './context-rail/context-rail-fixtures.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'alpha-token' });
const scope = daemonSessionScope(alpha, 'shared');
const TERMINAL = 'a1b2c3d4e5f6';

/** No browser storage behind a store: `undefined` would fall back to the shared localStorage. */
const NO_STORAGE = { getItem: () => null, setItem: () => undefined };

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => Response.json({ entries: [] })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
};

const railProps = (): SessionContextRailProps => ({
  agentName: 'Hadi',
  signals: fakeSignals(),
  loadMcp: async () => MCP,
  loadSkills: async () => SKILLS,
  loadDocs: async () => DOCS,
  onInsertSkill: () => undefined,
  onOpenFile: () => undefined,
});

/** Scripted browser engine: the surface's own chrome renders, no engine is reached. */
const browserEngine = { PreviewFrame: () => null, RemotePane: () => null };

interface Captured {
  workspace: SessionWorkspaceController;
  placement: SessionContextPlacement;
}

/** Mounts the workspace the way the page does: the controller and the placement are the host's. */
function Host({
  store,
  formFactor,
  captured,
  props,
}: {
  readonly store: WorkspaceLayoutStore;
  readonly formFactor: WorkspaceFormFactor;
  readonly captured: Captured;
  readonly props: Partial<SessionWorkspaceProps>;
}) {
  const workspace = useSessionWorkspace(store, scope);
  const placement = useContextPlacement(formFactor);
  captured.workspace = workspace;
  captured.placement = placement;
  return (
    <SessionWorkspace
      chat={<p data-chat="">the chat</p>}
      connection={alpha}
      context={placement}
      driving={NO_SURFACE_DRIVING}
      formFactor={formFactor}
      rails={new WorkspaceRailPreferenceStore(NO_STORAGE)}
      references={{}}
      renderHeader={(button: ReactNode) => <header data-header="">{button}</header>}
      session={sessionView('shared')}
      workspace={workspace}
      {...props}
    />
  );
}

const mountWorkspace = (
  formFactor: WorkspaceFormFactor,
  props: Partial<SessionWorkspaceProps> = {},
  store = new WorkspaceLayoutStore(NO_STORAGE),
) => {
  const captured = {} as Captured;
  const page = render(
    <SessionSearchProvider connection={alpha} focusSignal={0} scope={scope}>
      <Host captured={captured} formFactor={formFactor} props={props} store={store} />
    </SessionSearchProvider>,
    {
      createNodeMock: () => ({
        clientWidth: 800,
        clientHeight: 400,
        scrollTo: () => undefined,
        focus: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    },
  );
  return { page, captured, store };
};

const textOf = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('');

describe('SessionWorkspace on a desktop', () => {
  test('puts Chat in the agent pane and the context rail beside the split, resizable and collapsible', async () => {
    const rails = new WorkspaceRailPreferenceStore(NO_STORAGE);
    const { page, captured } = mountWorkspace('desktop', { rail: railProps(), rails });
    try {
      const view = page.root.findByType(WorkspaceView);
      expect(view.findAllByProps({ 'data-chat': '' })).toHaveLength(1);
      // Beside a rail there is no ◧ in the bar: the context is already on screen.
      expect(page.root.findAllByType(ContextSheetButton)).toHaveLength(0);
      expect(page.root.findByType(ContextRail).props.collapsed).toBe(false);

      const divider = page.root.findByType(RailDivider);
      run(() => divider.props.onPreview(400));
      expect(page.root.findByProps({ 'data-context-rail-frame': '' }).props.style.width).toBe('400px');
      run(() => page.root.findByType(RailDivider).props.onCommit(410));
      expect(rails.snapshot().right).toBe(410);

      run(() => captured.placement.setTab('docs'));
      expect(page.root.findByType(ContextRail).props.tab).toBe('docs');
      run(() => page.root.findByType(ContextRail).props.onCollapsedChange(true));
      expect(page.root.findByType(ContextRail).props.collapsed).toBe(true);
      expect(page.root.findAllByType(RailDivider)).toHaveLength(0);
      // A `/skill` chip brings the rail back on its Skills tab.
      run(() => captured.placement.reveal('skills'));
      expect(page.root.findByType(ContextRail).props.collapsed).toBe(false);
      expect(page.root.findByType(ContextRail).props.tab).toBe('skills');
      await settle();
    } finally {
      run(() => page.unmount());
    }
  });

  test('renders each workspace tab with the surface that already exists for it', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(TERMINAL)]));
    const store = new WorkspaceLayoutStore(NO_STORAGE);
    store.update(scope, layout =>
      [
        workspaceTab('terminal', TERMINAL, { label: 'dev' }),
        workspaceTab('browser', 'b1', { label: 'Browser' }),
        workspaceTab('file', WORKSPACE_FILES_PICKER_KEY, { label: 'Files' }),
      ].reduce((next, tab) => openWorkspaceTab(next, tab), layout),
    );
    const { page, captured } = mountWorkspace(
      'desktop',
      { deck: deck.dependencies, browser: browserEngine, readSnapshot: async () => 'pane text' },
      store,
    );
    try {
      await settle();
      // The terminal and the browser stay mounted behind the selected Files tab, as live bodies do.
      const terminal = page.root.findByType(SessionTerminalDeck);
      expect(terminal.props).toMatchObject({ focusTerminalId: TERMINAL, solo: true });
      expect(page.root.findByType(UnifiedBrowserSurface).props).toMatchObject({ isActive: false, streamTicket: null });
      const picker = page.root.findByType(FilesTab);
      expect(picker.props.cwd).toBe('/work/shared');

      // A file picked in the picker opens in its own tab, scrolled to the line it was opened at.
      run(() => picker.props.onOpenFile('src/app.ts', { line: 7 }));
      const file = page.root.findByType(FileInstanceSurface);
      expect(file.props.instance).toMatchObject({ key: 'src/app.ts', label: 'app.ts', selection: { line: 7 } });
      run(() => captured.workspace.openFile('src/app.ts'));
      expect(page.root.findByType(FileInstanceSurface).props.instance.selection).toBeUndefined();
      expect(page.root.findByType(FileInstanceSurface).props.instance.revision).toBe(2);

      // The Console is read from the agent's pane only while it is on screen.
      expect(page.root.findAllByProps({ 'data-workspace-console': '' })).toHaveLength(0);
      run(() => captured.workspace.showAgentTab('console'));
      await settle();
      expect(page.root.findAllByProps({ 'data-workspace-console': '' })).toHaveLength(1);
      expect(JSON.stringify(page.toJSON())).toContain('pane text');

      // The browser body is told when it is the one on screen.
      run(() => captured.workspace.openSurface('browser', 'b1'));
      expect(page.root.findByType(UnifiedBrowserSurface).props.isActive).toBe(true);
      run(() => page.root.findByType(UnifiedBrowserSurface).props.onClose());
    } finally {
      run(() => page.unmount());
    }
  });

  test('opens a new terminal, browser or Files tab from ＋, and says why when it cannot', async () => {
    let refuse = false;
    const deck = fakeDeck(async () => terminalListing([]));
    const create = deck.dependencies.create;
    deck.dependencies = {
      ...deck.dependencies,
      create: async (daemon, at) => {
        if (refuse) throw new Error('terminal capacity reached');
        return await create(daemon, at);
      },
    };
    const { page, store } = mountWorkspace('desktop', { deck: deck.dependencies, browser: browserEngine });
    try {
      const onNewTab = () => page.root.findByType(WorkspaceView).props.onNewTab;
      await runAsync(async () => {
        onNewTab()('terminal', 'agent');
        await Promise.resolve();
      });
      await settle();
      const tabs = () => Object.keys(store.snapshot(scope).tabs);
      expect(tabs()).toContain('terminal:100000000000');
      expect(store.snapshot(scope).tabs['terminal:100000000000']?.label).toBe('Terminal 1');

      run(() => onNewTab()('browser', 'agent'));
      run(() => onNewTab()('browser', 'agent'));
      expect(tabs()).toEqual(expect.arrayContaining(['browser:b1', 'browser:b2']));
      run(() => onNewTab()('file', 'agent'));
      expect(tabs()).toContain(`file:${WORKSPACE_FILES_PICKER_KEY}`);

      refuse = true;
      await runAsync(async () => {
        onNewTab()('terminal', 'agent');
        await Promise.resolve();
      });
      await settle();
      const alert = page.root.findAll(node => node.props.role === 'alert' && node.type === 'p');
      expect(alert.map(textOf)).toContain('Could not open a terminal: terminal capacity reached');
    } finally {
      run(() => page.unmount());
    }
  });

  test('without terminals, a terminal tab and ＋ › New terminal both say so', () => {
    const store = new WorkspaceLayoutStore(NO_STORAGE);
    store.update(scope, layout => openWorkspaceTab(layout, workspaceTab('terminal', TERMINAL)));
    const { page } = mountWorkspace('desktop', {}, store);
    try {
      expect(JSON.stringify(page.toJSON())).toContain('Terminals are not available on this page.');
      run(() => page.root.findByType(WorkspaceView).props.onNewTab('terminal', 'agent'));
      const alerts = page.root.findAll(node => node.props.role === 'alert' && node.type === 'p').map(textOf);
      expect(alerts).toContain('Terminals are not available on this page.');
    } finally {
      run(() => page.unmount());
    }
  });

  test('marks a driven tab and routes Take over and Hand back through the driving seam', () => {
    const intents: string[] = [];
    const driving: SurfaceDriving = {
      drivenTabIds: new Set([`terminal:${TERMINAL}`]),
      driverFor: () => ({ name: 'Hadi' }),
      takenOver: () => false,
      takeOver: tabId => intents.push(`take:${tabId}`),
      handBack: tabId => intents.push(`back:${tabId}`),
      failure: 'Could not take over dev: refused',
    };
    const store = new WorkspaceLayoutStore(NO_STORAGE);
    store.update(scope, layout => openWorkspaceTab(layout, workspaceTab('terminal', TERMINAL)));
    const deck = fakeDeck(async () => terminalListing([terminalView(TERMINAL)]));
    const { page } = mountWorkspace('desktop', { driving, deck: deck.dependencies }, store);
    try {
      expect(page.root.findByType(WorkspaceView).props.drivenTabIds).toBe(driving.drivenTabIds);
      const marker = page.root.findByType(AgentControlMarker);
      expect(marker.props.driver).toEqual({ name: 'Hadi' });
      run(() => marker.props.onTakeOver());
      run(() => marker.props.onHandBack());
      expect(intents).toEqual([`take:terminal:${TERMINAL}`, `back:terminal:${TERMINAL}`]);
      // Over a shell the marker has a strip of its own, and a refused control is said as an alert.
      expect(marker.props.inline).toBe(true);
      expect(page.root.findAllByProps({ className: 'fy-ws-marker-row' })).toHaveLength(1);
      const alerts = page.root.findAll(node => node.props.role === 'alert' && node.type === 'p').map(textOf);
      expect(alerts).toContain('Could not take over dev: refused');
    } finally {
      run(() => page.unmount());
    }
  });
});

const browserPage = (id: string, extra: Partial<BrowserPageSummary> = {}): BrowserPageSummary => ({
  id,
  url: `https://example.test/${id.toLowerCase()}`,
  title: `Title ${id}`,
  ownerSessionId: 'shared',
  ownerName: 'Hadi',
  ...extra,
});
const runningBrowser = (pages: readonly BrowserPageSummary[], active = pages[0]?.id): BrowserStatus =>
  ({
    sessionId: 'shared',
    state: 'running',
    pages: [...pages],
    activePageId: active,
    url: pages[0]?.url,
    title: pages[0]?.title,
    pageState: 'ready',
    canGoBack: false,
    canGoForward: false,
    viewport: { width: 1280, height: 800 },
    viewers: 1,
    persistentProfile: true,
    idleTimeoutSeconds: 900,
    capacity: { running: pages.length, maximum: 60 },
  }) as BrowserStatus;

/** A scripted session browser: records what the workspace asks of it, answers what the test says. */
const fakeSessionBrowser = (status: BrowserStatus | null, answer: (action: BrowserAction) => BrowserStatus | null) => {
  const activated: string[] = [];
  const acted: BrowserAction[] = [];
  const pages: SessionBrowser = {
    status,
    activatePage: pageId => activated.push(pageId),
    act: async action => {
      acted.push(action);
      return answer(action);
    },
  };
  return { pages, activated, acted };
};

describe('browser tabs', () => {
  afterEach(() => resetBrowserSurfaceSessions());

  test('lists the session pages over a browser tab, and a page tab brings its page into view in the real engine', async () => {
    // Arrange
    const APP = browserPage('PAGE1', { name: 'app' });
    const PR = browserPage('PAGE3');
    const NEW = browserPage('PAGE4');
    let next: BrowserStatus | null = runningBrowser([APP, PR, NEW], 'PAGE4');
    const browser = fakeSessionBrowser(runningBrowser([APP, PR]), action =>
      action.action === 'new-page' ? next : runningBrowser([PR]),
    );
    const driving: SurfaceDriving = {
      ...NO_SURFACE_DRIVING,
      driverFor: tabId => (tabId === 'browser:app' || tabId === 'browser:PAGE1' ? { name: 'Hadi' } : null),
    };
    const store = new WorkspaceLayoutStore(NO_STORAGE);
    store.update(scope, layout =>
      [workspaceTab('browser', 'b1', { label: 'Browser' }), workspaceTab('browser', 'app', { label: 'app' })].reduce(
        (layoutSoFar, tab) => openWorkspaceTab(layoutSoFar, tab),
        layout,
      ),
    );

    // Act
    const { page, captured } = mountWorkspace(
      'desktop',
      { browser: browserEngine, browserPages: browser.pages, driving },
      store,
    );
    try {
      await settle();

      // Assert — both tabs carry the strip; only the page tab names a page, and it is brought into view.
      const lists = page.root.findAllByType(BrowserSurfaceList);
      expect(lists).toHaveLength(2);
      expect(lists.map(list => list.props.selectedPageId).sort()).toEqual(['PAGE1', undefined]);
      expect(browser.activated).toEqual(['PAGE1']);
      expect(browserEngineForSession(scope)).toBe('remote');
      const surfaces = page.root.findAllByType(UnifiedBrowserSurface);
      expect(surfaces.every(surface => surface.props.showPageTabs === false)).toBe(true);
      const list = lists.find(candidate => candidate.props.selectedPageId === 'PAGE1') as ReactTestInstance;
      expect(list.props.driverFor(APP)).toEqual({ name: 'Hadi' });
      expect(list.props.takenOver(APP)).toBe(false);
      // The page tab's marker sits inline at the end of the strip.
      const markers = list.findAllByType(AgentControlMarker);
      expect(markers.map(marker => [marker.props.inline, marker.props.driver])).toEqual([[true, { name: 'Hadi' }]]);

      // A chip opens that page's own tab: by name when it has one, else by id, labelled for a reader.
      run(() => list.props.onOpenPage(PR));
      expect(store.snapshot(scope).tabs['browser:PAGE3']?.label).toBe('Title PAGE3');
      run(() => list.props.onClosePage(APP));
      await settle();
      expect(browser.acted).toContainEqual({ action: 'close-page', pageId: 'PAGE1' });

      // New page asks the daemon, then opens the page it made.
      run(() => page.root.findAllByType(BrowserSurfaceList)[0]?.props.onNewPage());
      await settle();
      expect(browser.acted).toContainEqual({ action: 'new-page' });
      expect(store.snapshot(scope).tabs['browser:PAGE4']).toBeDefined();

      // A refused new page says so.
      next = null;
      run(() => page.root.findAllByType(BrowserSurfaceList)[0]?.props.onNewPage());
      await settle();
      const alerts = page.root.findAll(node => node.props.role === 'alert' && node.type === 'p').map(textOf);
      expect(alerts).toContain('Could not open a new page in this session’s browser.');
      expect(captured.workspace.layout).toBe(store.snapshot(scope));
    } finally {
      run(() => page.unmount());
    }
  });

  test('without a page list, a browser tab keeps the engine page tabs and a floating marker', async () => {
    const store = new WorkspaceLayoutStore(NO_STORAGE);
    store.update(scope, layout => openWorkspaceTab(layout, workspaceTab('browser', 'b1', { label: 'Browser' })));
    const { page } = mountWorkspace('desktop', { browser: browserEngine }, store);
    try {
      await settle();
      expect(page.root.findAllByType(BrowserSurfaceList)).toHaveLength(0);
      expect(page.root.findByType(UnifiedBrowserSurface).props.showPageTabs).toBe(true);
      expect(page.root.findByType(AgentControlMarker).props.inline).toBe(false);
      expect(browserEngineForSession(scope)).toBe('preview');
    } finally {
      run(() => page.unmount());
    }
  });
});

describe('closing a terminal tab', () => {
  test('asks Close tab or End shell, and End shell ends it through the deck', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(TERMINAL)]));
    const store = new WorkspaceLayoutStore(NO_STORAGE);
    store.update(scope, layout => openWorkspaceTab(layout, workspaceTab('terminal', TERMINAL, { label: 'dev' })));
    const { page } = mountWorkspace('desktop', { deck: deck.dependencies }, store);
    try {
      await settle();
      const menu = () => page.root.findByType(ContextMenu);
      run(() =>
        page.root.findByType(WorkspaceView).props.onEndTerminal(store.snapshot(scope).tabs[`terminal:${TERMINAL}`]),
      );
      await settle();
      expect(deck.closed).toEqual([TERMINAL]);
      expect(menu().props.open).toBe(false);
    } finally {
      run(() => page.unmount());
    }
  });

  test('says so when the shell could not be ended', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(TERMINAL)]));
    deck.dependencies = {
      ...deck.dependencies,
      close: async () => {
        throw new Error('the shell is already gone');
      },
    };
    const store = new WorkspaceLayoutStore(NO_STORAGE);
    store.update(scope, layout => openWorkspaceTab(layout, workspaceTab('terminal', TERMINAL, { label: 'dev' })));
    const { page } = mountWorkspace('desktop', { deck: deck.dependencies }, store);
    try {
      await settle();
      run(() =>
        page.root.findByType(WorkspaceView).props.onEndTerminal(store.snapshot(scope).tabs[`terminal:${TERMINAL}`]),
      );
      await settle();
      const alerts = page.root.findAll(node => node.props.role === 'alert' && node.type === 'p').map(textOf);
      expect(alerts).toContain('Could not end the shell: the shell is already gone');
    } finally {
      run(() => page.unmount());
    }
  });

  test('offers no End shell where the page has no terminals', () => {
    const { page } = mountWorkspace('desktop');
    try {
      expect(page.root.findByType(WorkspaceView).props.onEndTerminal).toBeUndefined();
    } finally {
      run(() => page.unmount());
    }
  });
});

describe('SessionWorkspace on a phone and a tablet', () => {
  test('types into the Console from the key bar and the field, through the injected typer', async () => {
    const typed: string[] = [];
    const store = new WorkspaceLayoutStore(NO_STORAGE);
    const { page, captured } = mountWorkspace(
      'phone',
      {
        readSnapshot: async () => 'pane text',
        typeIntoConsole: async (_daemon, _scope, data) => {
          typed.push(data);
        },
      },
      store,
    );
    try {
      run(() => captured.workspace.showAgentTab('console'));
      await settle();
      const phone = () => page.root.findByType(PhoneWorkspace);
      expect(phone().props.activeId).toBe('console');
      expect(page.root.findByType(ConsoleSurface).props.scope).toBe(scope);
      run(() => phone().props.onTerminalInput('console', '\x1b[A'));
      run(() => phone().props.onFocusTerminal('console'));
      await settle();
      expect(typed).toEqual(['\x1b[A']);
    } finally {
      run(() => page.unmount());
    }
  });

  test('shows one tab at a time, with the key bar typing into the terminal on screen', async () => {
    const deck = fakeDeck(async () => terminalListing([terminalView(TERMINAL)]));
    const store = new WorkspaceLayoutStore(NO_STORAGE);
    store.update(scope, layout => openWorkspaceTab(layout, workspaceTab('terminal', TERMINAL, { label: 'dev' })));
    const { page, captured } = mountWorkspace(
      'phone',
      { deck: deck.dependencies, rail: railProps(), browser: browserEngine },
      store,
    );
    try {
      await settle();
      const phone = () => page.root.findByType(PhoneWorkspace);
      expect(phone().props.tabs.map((tab: { id: string }) => tab.id)).toEqual([`terminal:${TERMINAL}`]);
      expect(phone().props.activeId).toBe(`terminal:${TERMINAL}`);
      // The Console types through its own route now, so it gets the key bar a terminal gets.
      expect(phone().props.consoleTakesKeys).toBeUndefined();

      const socket = deck.sockets[0];
      if (socket === undefined) throw new Error('the terminal tab did not attach');
      await runAsync(async () => {
        socket.emit('open');
        await Promise.resolve();
      });
      run(() => phone().props.onTerminalInput(`terminal:${TERMINAL}`, '\t'));
      run(() => phone().props.onFocusTerminal(`terminal:${TERMINAL}`));
      run(() => phone().props.onTerminalInput('terminal:unknown', 'x'));
      const typed = socket.sent
        .filter((frame): frame is Uint8Array => frame instanceof Uint8Array)
        .map(frame => new TextDecoder().decode(frame));
      expect(typed).toEqual(['\t']);

      run(() => phone().props.onSelect('chat'));
      expect(phone().props.activeId).toBe('chat');
      run(() => phone().props.onNewBrowser());
      expect(phone().props.activeId).toBe('browser:b1');
      run(() => phone().props.onOpenFile());
      expect(phone().props.activeId).toBe(`file:${WORKSPACE_FILES_PICKER_KEY}`);
      await runAsync(async () => {
        phone().props.onNewTerminal();
        await Promise.resolve();
      });
      await settle();
      expect(phone().props.activeId).toBe('terminal:100000000000');

      // ◧ in the bar opens the context sheet, on the sub-tab the placement holds.
      const button = page.root.findByType(ContextSheetButton);
      run(() => button.props.onOpen());
      expect(page.root.findByType(ContextSheet).props.open).toBe(true);
      expect(page.root.findByType(ContextRailBody).props.tab).toBe('signals');
      run(() => captured.placement.reveal('mcp'));
      expect(page.root.findByType(ContextRailBody).props.tab).toBe('mcp');
      run(() => page.root.findByType(ContextSheet).props.onClose());
      expect(page.root.findByType(ContextSheet).props.open).toBe(false);
      await settle();
    } finally {
      run(() => page.unmount());
    }
  });

  test('keeps the split on a tablet, with the context behind ◧', () => {
    const { page } = mountWorkspace('tablet-split', { rail: railProps() });
    try {
      expect(page.root.findAllByType(WorkspaceView)).toHaveLength(1);
      expect(page.root.findAllByType(ContextRail)).toHaveLength(0);
      expect(page.root.findAllByType(ContextSheetButton)).toHaveLength(1);
    } finally {
      run(() => page.unmount());
    }
  });

  test('a phone with no terminals offers no New terminal', () => {
    const { page } = mountWorkspace('phone');
    try {
      expect(page.root.findByType(PhoneWorkspace).props.onNewTerminal).toBeUndefined();
      expect(page.root.findAllByType(ContextSheetButton)).toHaveLength(0);
    } finally {
      run(() => page.unmount());
    }
  });
});

describe('workspace seams', () => {
  test('the driving seam reports nobody driving and ignores both intents without a daemon client', () => {
    let seen: SurfaceDriving | undefined;
    function Probe() {
      seen = useSurfaceDriving(scope, alpha);
      return null;
    }
    const page = render(<Probe />);
    expect(seen).toBe(NO_SURFACE_DRIVING);
    expect(NO_SURFACE_DRIVING.drivenTabIds.size).toBe(0);
    expect(NO_SURFACE_DRIVING.driverFor('terminal:x')).toBeNull();
    expect(NO_SURFACE_DRIVING.takenOver('terminal:x')).toBe(false);
    expect(NO_SURFACE_DRIVING.takeOver('terminal:x')).toBeUndefined();
    expect(NO_SURFACE_DRIVING.handBack('terminal:x')).toBeUndefined();
    run(() => page.unmount());
  });

  test('the form factor follows the window', () => {
    const seen: WorkspaceFormFactor[] = [];
    function Probe() {
      seen.push(useWorkspaceFormFactor());
      return null;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    const resize = (w: number, h: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
      window.dispatchEvent(new Event('resize'));
    };
    try {
      resize(1440, 900);
      const page = render(<Probe />);
      expect(seen.at(-1)).toBe('desktop');
      run(() => resize(390, 844));
      expect(seen.at(-1)).toBe('phone');
      run(() => page.unmount());
    } finally {
      resize(width, height);
    }
  });

  test('the terminal listing is read through the deck, polled, and keeps its identity between equal reads', async () => {
    const reads: string[] = [];
    let fail = false;
    const deck = fakeDeck(async () => {
      reads.push('list');
      if (fail) throw new Error('down');
      return terminalListing([terminalView(TERMINAL)]);
    });
    const seen: unknown[] = [];
    function Probe({ withDeck }: { readonly withDeck: boolean }) {
      seen.push(useSessionTerminals(withDeck ? deck.dependencies : undefined, alpha, scope));
      return null;
    }
    const page = render(<Probe withDeck />);
    expect(seen.at(-1)).toBeNull();
    await settle();
    const first = seen.at(-1);
    expect(first).toMatchObject({ sessionId: 'shared' });

    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, SESSION_TERMINALS_POLL_MS + 50));
    });
    await settle();
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)).toBe(first);

    fail = true;
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, SESSION_TERMINALS_POLL_MS + 50));
    });
    await settle();
    expect(seen.at(-1)).toBe(first);

    run(() => page.update(<Probe withDeck={false} />));
    expect(seen.at(-1)).toBeNull();
    run(() => page.unmount());
  }, 30_000);

  test('a listing that lands after the page left is dropped', async () => {
    let answer: (value: ReturnType<typeof terminalListing>) => void = () => undefined;
    const deck = fakeDeck(
      () =>
        new Promise(resolve => {
          answer = resolve;
        }),
    );
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useSessionTerminals(deck.dependencies, alpha, scope));
      return null;
    }
    const page = render(<Probe />);
    run(() => page.unmount());
    await runAsync(async () => {
      answer(terminalListing([]));
      await Promise.resolve();
    });
    expect(seen.every(value => value === null)).toBe(true);
  });
});
