import { describe, expect, test } from 'bun:test';
import type { FyEvent, IFyApiClient, SurfaceAsked, SurfaceOpened } from '@ferretry/protocol';
import { useSyncExternalStore } from 'react';
import type { z } from 'zod';
import {
  AGENT_SURFACE_NOTICE_MS,
  type AgentSurfaceTabs,
  NO_AGENT_SURFACE_TABS,
  surfaceTabFor,
  useAgentSurfaceTabs,
} from '../../../../src/features/workspace/use-agent-surface-tabs.ts';
import { useSurfaceDriving } from '../../../../src/features/workspace/use-surface-driving.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../../src/lib/daemon-scope.ts';
import { createSurfaceEventHub } from '../../../../src/lib/surface-control.ts';
import {
  AGENT_PANE_ID,
  closeWorkspaceTab,
  focusedWorkspaceTab,
  focusWorkspacePane,
  openWorkspaceTab,
  serializeWorkspaceLayout,
  visibleTabsInOrder,
  type WorkspaceLayout,
  workspaceTab,
} from '../../../../src/lib/workspace-layout.ts';
import { WorkspaceLayoutStore, type WorkspaceStorage } from '../../../../src/lib/workspace-layout-store.ts';
import { render, run, runAsync } from '../../../support/react.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'alpha-token' });
const scope = daemonSessionScope(alpha, 'sess-1');
const other = daemonSessionScope(alpha, 'sess-2');
const AT = '2026-10-16T10:00:00.000Z';
const LATER = '2026-10-16T10:05:00.000Z';

class MemoryStorage implements WorkspaceStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const terminal = (overrides: Partial<SurfaceOpened> = {}): SurfaceOpened => ({
  surface: 'terminal',
  id: 'a1b2c3d4e5f6',
  name: 'dev',
  agentSessionId: 'sess-1',
  agentName: 'Hadi',
  at: AT,
  ...overrides,
});
const page: SurfaceOpened = { surface: 'browser', id: 'PAGE1', name: 'login', agentSessionId: 'sess-1', at: AT };
const ask = (overrides: Partial<SurfaceAsked> = {}): SurfaceAsked => ({
  ...terminal({ at: LATER }),
  message: 'Type the sudo password',
  ...overrides,
});

interface Timers {
  readonly scheduled: { readonly callback: () => void; readonly delayMs: number; cancelled: boolean }[];
  readonly timer: (callback: () => void, delayMs: number) => () => void;
}
const fakeTimers = (): Timers => {
  const scheduled: Timers['scheduled'] = [];
  return {
    scheduled,
    timer: (callback, delayMs) => {
      const entry = { callback, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
};

interface Props {
  readonly opened: readonly SurfaceOpened[];
  readonly asked: readonly SurfaceAsked[];
}

function mount(
  initial: Props,
  options: { readonly store?: WorkspaceLayoutStore; readonly timers?: Timers; readonly at?: typeof scope } = {},
) {
  const store = options.store ?? new WorkspaceLayoutStore(new MemoryStorage());
  const timers = options.timers ?? fakeTimers();
  const seen: { tabs: AgentSurfaceTabs; layout: WorkspaceLayout } = {
    tabs: NO_AGENT_SURFACE_TABS,
    layout: store.snapshot(options.at ?? scope),
  };
  function Probe({ opened, asked }: Props) {
    const at = options.at ?? scope;
    const layout = useSyncExternalStore(store.subscribe, () => store.snapshot(at));
    seen.layout = layout;
    seen.tabs = useAgentSurfaceTabs({ store, scope: at, layout, opened, asked, timer: timers.timer });
    return null;
  }
  const renderer = render(<Probe {...initial} />);
  return { seen, store, timers, renderer, set: (next: Props) => run(() => renderer.update(<Probe {...next} />)) };
}

const tabIds = (layout: WorkspaceLayout): string[] => visibleTabsInOrder(layout).map(tab => tab.id);

describe('surfaceTabFor', () => {
  test('should key a terminal by its id and a browser page by its name, each aliasing the other spelling', () => {
    expect(surfaceTabFor(terminal())).toEqual({
      tab: workspaceTab('terminal', 'a1b2c3d4e5f6', { label: 'dev', title: 'Terminal dev' }),
      aliases: ['terminal:dev'],
    });
    expect(surfaceTabFor(page)).toEqual({
      tab: workspaceTab('browser', 'login', { label: 'login', title: 'Browser page login' }),
      aliases: ['browser:PAGE1'],
    });
    const { name: _name, ...nameless } = terminal();
    expect(surfaceTabFor(nameless).aliases).toEqual([]);
    expect(surfaceTabFor({ surface: 'browser', id: 'PAGE2' }).aliases).toEqual([]);
  });
});

describe('useAgentSurfaceTabs — an agent opens a surface', () => {
  test('should add the tab beside Chat and Console without moving the focus, and say what happened', () => {
    // Arrange
    const focusBefore = new WorkspaceLayoutStore(new MemoryStorage()).snapshot(scope).focused;

    // Act
    const mounted = mount({ opened: [terminal()], asked: [] });

    // Assert
    expect(tabIds(mounted.seen.layout)).toContain('terminal:a1b2c3d4e5f6');
    expect(mounted.seen.layout.focused).toBe(focusBefore);
    expect(mounted.seen.tabs.unseenTabIds.has('terminal:a1b2c3d4e5f6')).toBe(true);
    expect(mounted.seen.tabs.notice).toEqual({
      tabId: 'terminal:a1b2c3d4e5f6',
      text: 'Hadi opened terminal dev',
    });
    expect(mounted.seen.tabs.askedTabIds.size).toBe(0);
    expect(mounted.timers.scheduled[0]?.delayMs).toBe(AGENT_SURFACE_NOTICE_MS);
  });

  test('should add a tab for an event that arrives later, and say "The agent" when it has no name', () => {
    const { seen, set } = mount({ opened: [], asked: [] });
    const { agentName: _agent, ...nameless } = terminal();
    set({ opened: [page, nameless as SurfaceOpened], asked: [] });
    expect(tabIds(seen.layout)).toEqual(expect.arrayContaining(['browser:login', 'terminal:a1b2c3d4e5f6']));
    expect(seen.tabs.notice?.text).toBe('The agent opened terminal dev');
  });

  test('should auto-dismiss the notice, and Show brings the tab forward', () => {
    // Arrange
    const { seen, timers } = mount({ opened: [terminal()], asked: [] });
    expect(seen.tabs.notice).not.toBeNull();

    // Act
    run(() => timers.scheduled[0]?.callback());

    // Assert
    expect(seen.tabs.notice).toBeNull();
  });

  test('should bring the noticed tab forward on Show, and clear the dot once it is focused', () => {
    // Arrange
    const { seen } = mount({ opened: [terminal(), page], asked: [] });
    const tabId = seen.tabs.notice?.tabId as string;

    // Act
    run(() => seen.tabs.showNotice());

    // Assert
    expect(focusedWorkspaceTab(seen.layout)).toBe(tabId);
    expect(seen.tabs.notice).toBeNull();
    expect(seen.tabs.unseenTabIds.has(tabId)).toBe(false);
    run(() => seen.tabs.showNotice());
    expect(seen.tabs.notice).toBeNull();
  });

  test('should dismiss the notice without touching the tab', () => {
    const { seen } = mount({ opened: [terminal()], asked: [] });
    run(() => seen.tabs.dismissNotice());
    expect(seen.tabs.notice).toBeNull();
    expect(seen.tabs.unseenTabIds.has('terminal:a1b2c3d4e5f6')).toBe(true);
  });

  test('should not steal the focus from a pane the owner is in, nor re-add a tab they closed', () => {
    // Arrange
    const store = new WorkspaceLayoutStore(new MemoryStorage());
    store.update(scope, layout =>
      focusWorkspacePane(openWorkspaceTab(layout, workspaceTab('file', 'a.ts')), AGENT_PANE_ID),
    );
    const { seen, set } = mount({ opened: [terminal()], asked: [] }, { store });
    const focused = seen.layout.focused;
    expect(focused).toBe(AGENT_PANE_ID);

    // Act
    run(() => store.update(scope, layout => closeWorkspaceTab(layout, 'terminal:a1b2c3d4e5f6')));
    set({ opened: [terminal(), page], asked: [] });

    // Assert
    expect(seen.layout.focused).toBe(focused);
    expect(tabIds(seen.layout)).not.toContain('terminal:a1b2c3d4e5f6');
    expect(tabIds(seen.layout)).toContain('browser:login');
  });

  test('should offer a closed surface back in ＋ and reopen it on request, only while it is alive', () => {
    // Arrange
    const { seen, store, set } = mount({ opened: [terminal(), page], asked: [] });
    run(() => store.update(scope, layout => closeWorkspaceTab(layout, 'terminal:a1b2c3d4e5f6')));
    expect(seen.tabs.reopenable).toEqual([{ tabId: 'terminal:a1b2c3d4e5f6', kind: 'terminal', label: 'dev' }]);

    // Act
    run(() => seen.tabs.reopen('terminal:a1b2c3d4e5f6'));

    // Assert
    expect(tabIds(seen.layout)).toContain('terminal:a1b2c3d4e5f6');
    expect(seen.tabs.reopenable).toEqual([]);
    run(() => seen.tabs.reopen('terminal:nope'));
    set({ opened: [], asked: [] });
    expect(seen.tabs.reopenable).toEqual([]);
  });

  test('should treat a tab opened by reference under the other spelling as the same tab', () => {
    const store = new WorkspaceLayoutStore(new MemoryStorage());
    store.update(scope, layout => openWorkspaceTab(layout, workspaceTab('terminal', 'dev')));
    const { seen } = mount({ opened: [terminal()], asked: [] }, { store });
    expect(tabIds(seen.layout).filter(id => id.startsWith('terminal:'))).toEqual(['terminal:dev']);
    expect(seen.tabs.reopenable).toEqual([]);
    expect(seen.tabs.notice).toBeNull();
  });

  test('should do it once per session across a reload, and not for another session', () => {
    // Arrange
    const storage = new MemoryStorage();
    const first = mount({ opened: [terminal()], asked: [] }, { store: new WorkspaceLayoutStore(storage) });
    run(() => first.renderer.unmount());

    // Act
    const reloaded = mount({ opened: [terminal()], asked: [] }, { store: new WorkspaceLayoutStore(storage) });
    const elsewhere = mount({ opened: [], asked: [] }, { store: new WorkspaceLayoutStore(storage), at: other });

    // Assert
    expect(tabIds(reloaded.seen.layout)).toContain('terminal:a1b2c3d4e5f6');
    expect(reloaded.seen.tabs.notice).toBeNull();
    expect(tabIds(elsewhere.seen.layout)).not.toContain('terminal:a1b2c3d4e5f6');
    expect(storage.values.size).toBe(1);
  });
});

describe('useAgentSurfaceTabs — an agent hands a surface to the owner', () => {
  test('should switch to the tab, focus it, mark it YOUR TURN and carry the message', () => {
    // Arrange
    const { seen, set } = mount({ opened: [terminal()], asked: [] });
    const store = seen;

    // Act
    set({ opened: [terminal()], asked: [ask()] });

    // Assert
    expect(focusedWorkspaceTab(store.layout)).toBe('terminal:a1b2c3d4e5f6');
    expect(seen.tabs.askedTabIds.has('terminal:a1b2c3d4e5f6')).toBe(true);
    expect(seen.tabs.askFor('terminal:a1b2c3d4e5f6')).toEqual({ agent: 'Hadi', message: 'Type the sudo password' });
    expect(seen.tabs.askFor('terminal:other')).toBeNull();
  });

  test('should open a tab the owner closed, and come forward once per ask — not again on reload or a re-poll', () => {
    // Arrange
    const storage = new MemoryStorage();
    const store = new WorkspaceLayoutStore(storage);
    const { seen, set } = mount({ opened: [terminal()], asked: [] }, { store });
    run(() => store.update(scope, layout => closeWorkspaceTab(layout, 'terminal:a1b2c3d4e5f6')));

    // Act
    set({ opened: [terminal()], asked: [ask()] });
    const forward = focusedWorkspaceTab(seen.layout);
    run(() => store.update(scope, layout => focusWorkspacePane(layout, AGENT_PANE_ID)));
    set({ opened: [terminal()], asked: [ask()] });
    const reloaded = mount({ opened: [terminal()], asked: [ask()] }, { store: new WorkspaceLayoutStore(storage) });

    // Assert
    expect(forward).toBe('terminal:a1b2c3d4e5f6');
    expect(seen.layout.focused).toBe(AGENT_PANE_ID);
    expect(reloaded.seen.layout.focused).toBe(AGENT_PANE_ID);
    set({ opened: [terminal()], asked: [ask({ at: '2026-10-16T10:09:00.000Z' })] });
    expect(focusedWorkspaceTab(seen.layout)).toBe('terminal:a1b2c3d4e5f6');
  });

  test('should hold an ask for a browser page by name or id, and a surface opened already asking is a tab', () => {
    const { seen } = mount({ opened: [], asked: [{ ...page, at: LATER }] });
    expect(tabIds(seen.layout)).toContain('browser:login');
    expect(seen.tabs.askFor('browser:login')).toEqual({ agent: 'The agent' });
  });

  test('should let the owner dismiss an ask, for good', () => {
    // Arrange
    const storage = new MemoryStorage();
    const store = new WorkspaceLayoutStore(storage);
    const { seen } = mount({ opened: [terminal()], asked: [ask()] }, { store });

    // Act
    run(() => seen.tabs.dismissAsk('terminal:a1b2c3d4e5f6'));
    run(() => seen.tabs.dismissAsk('terminal:a1b2c3d4e5f6'));

    // Assert
    expect(seen.tabs.askedTabIds.size).toBe(0);
    expect(seen.tabs.askFor('terminal:a1b2c3d4e5f6')).toBeNull();
  });

  test('should show the ask on the tab that is open under the other spelling', () => {
    const store = new WorkspaceLayoutStore(new MemoryStorage());
    store.update(scope, layout => openWorkspaceTab(layout, workspaceTab('terminal', 'dev')));
    const { seen } = mount({ opened: [terminal()], asked: [ask()] }, { store });
    expect(seen.tabs.askedTabIds.has('terminal:dev')).toBe(true);
    expect(focusedWorkspaceTab(seen.layout)).toBe('terminal:dev');
  });
});

describe('useAgentSurfaceTabs — the real timer', () => {
  test('should let the notice go by itself when no timer is injected', async () => {
    // Arrange
    const store = new WorkspaceLayoutStore(new MemoryStorage());
    const seen: { tabs: AgentSurfaceTabs } = { tabs: NO_AGENT_SURFACE_TABS };
    function Probe() {
      const layout = useSyncExternalStore(store.subscribe, () => store.snapshot(scope));
      seen.tabs = useAgentSurfaceTabs({ store, scope, layout, opened: [terminal()], asked: [], noticeMs: 10 });
      return null;
    }
    const renderer = render(<Probe />);
    expect(seen.tabs.notice).not.toBeNull();

    // Act
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
    });

    // Assert
    expect(seen.tabs.notice).toBeNull();
    run(() => renderer.unmount());
  });
});

describe('NO_AGENT_SURFACE_TABS', () => {
  test('should report nothing and do nothing', () => {
    expect(NO_AGENT_SURFACE_TABS.notice).toBeNull();
    expect(NO_AGENT_SURFACE_TABS.reopenable).toEqual([]);
    expect(NO_AGENT_SURFACE_TABS.askFor('terminal:x')).toBeNull();
    for (const act of [
      NO_AGENT_SURFACE_TABS.dismissNotice,
      NO_AGENT_SURFACE_TABS.showNotice,
      () => NO_AGENT_SURFACE_TABS.dismissAsk('terminal:x'),
      () => NO_AGENT_SURFACE_TABS.reopen('terminal:x'),
    ])
      expect(act()).toBeUndefined();
  });
});

describe('daemon event → workspace tab', () => {
  const event = (type: string, data: unknown): FyEvent => ({
    sequence: 1,
    time: AT,
    sessionId: 'sess-1',
    type,
    source: 'daemon',
    data,
  });
  const empty = (kind: string) => ({
    sessionId: 'sess-1',
    driving: [],
    takeovers: [],
    handed: [],
    opened: [],
    asked: [],
    kind,
  });

  test('should add the tab when surface.opened arrives on the session feed, and bring it forward on surface.asked', async () => {
    // Arrange
    const hub = createSurfaceEventHub();
    const client: NonNullable<Parameters<typeof useSurfaceDriving>[2]>['client'] = async () =>
      ({
        request: async <T,>(_path: string, schema: z.ZodType<T>): Promise<T> => schema.parse(empty('x')),
      }) satisfies Pick<IFyApiClient, 'request'>;
    const store = new WorkspaceLayoutStore(new MemoryStorage());
    const { timer } = fakeTimers();
    const seen: { layout: WorkspaceLayout; tabs: AgentSurfaceTabs } = {
      layout: store.snapshot(scope),
      tabs: NO_AGENT_SURFACE_TABS,
    };
    function Probe() {
      const driving = useSurfaceDriving(scope, alpha, { client, events: hub });
      const layout = useSyncExternalStore(store.subscribe, () => store.snapshot(scope));
      seen.layout = layout;
      seen.tabs = useAgentSurfaceTabs({
        store,
        scope,
        layout,
        opened: driving.opened,
        asked: driving.asked,
        timer,
      });
      return null;
    }
    const renderer = render(<Probe />);
    await runAsync(async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });
    expect(tabIds(seen.layout)).not.toContain('terminal:a1b2c3d4e5f6');

    // Act
    run(() => hub.publish(event('surface.opened', terminal())));
    const afterOpen = serializeWorkspaceLayout(seen.layout);
    const noticed = seen.tabs.notice?.text;
    run(() => hub.publish(event('surface.asked', ask())));

    // Assert
    expect(afterOpen).toContain('terminal:a1b2c3d4e5f6');
    expect(noticed).toBe('Hadi opened terminal dev');
    expect(focusedWorkspaceTab(seen.layout)).toBe('terminal:a1b2c3d4e5f6');
    expect(seen.tabs.askFor('terminal:a1b2c3d4e5f6')?.message).toBe('Type the sudo password');

    // Act — the owner takes the surface over: the ask clears
    run(() =>
      hub.publish(
        event('surface.takeover', {
          surface: 'terminal',
          id: 'a1b2c3d4e5f6',
          name: 'dev',
          by: { by: 'local' },
          since: LATER,
        }),
      ),
    );
    expect(seen.tabs.askedTabIds.size).toBe(0);
    run(() => renderer.unmount());
  });
});
