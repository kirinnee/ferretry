/**
 * `ferrets.list-scope`, provided: the registry names the group a folder files under, and the folder-mode machine (store
 * first, one history entry) moves the focus the list draws. Every dependency is a hand-made fake: no window, no daemon.
 */
import { describe, expect, test } from 'bun:test';
import type { ProjectInfo } from '../../../contract/index.ts';
import { createListScope, ferretListRoutes, type ListScopeControls } from '../../../app/lib/list-scope.ts';
import { ProjectsStore } from '../../../app/lib/projects-store.ts';
import type { ScopeNavigation } from '../../../app/lib/project-scope.ts';

const DAEMON = 'laptop';

const project = (name: string, path: string): ProjectInfo =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    name,
    path,
    source: 'existing-folder',
    createdAt: '2026-08-01T10:00:00.000Z',
  }) as ProjectInfo;

const routes = ferretListRoutes(daemon => `/d/${encodeURIComponent(daemon)}`);

const fakeControls = (): ListScopeControls & { readonly changed: () => void; readonly listening: () => number } => {
  const values = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  return {
    projectScope: id => values.get(id) ?? null,
    setProjectScope: (id, scope) => {
      values.set(id, scope);
      for (const listener of listeners) listener();
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    changed: () => {
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
  };
};

const fakeNavigation = (initial = '/d/laptop/ferrets') => {
  let current = new URL(initial, 'https://app.example.test');
  let state: unknown = null;
  const entries: { kind: 'push' | 'replace'; url: string }[] = [];
  const listeners = new Set<() => void>();
  const navigation: ScopeNavigation = {
    snapshot: () => ({ pathname: current.pathname, search: current.search, state }),
    push: (next, url) => {
      entries.push({ kind: 'push', url });
      current = new URL(url, 'https://app.example.test');
      state = next;
    },
    replace: (next, url) => {
      entries.push({ kind: 'replace', url });
      current = new URL(url, 'https://app.example.test');
      state = next;
    },
    announce: () => {
      for (const listener of listeners) listener();
    },
    listen: onPop => {
      listeners.add(onPop);
      return () => listeners.delete(onPop);
    },
  };
  return {
    navigation,
    entries,
    listening: () => listeners.size,
    go: (url: string) => {
      current = new URL(url, 'https://app.example.test');
      state = null;
      for (const listener of listeners) listener();
    },
  };
};

const setup = (
  projects: readonly ProjectInfo[] = [project('App', '/work/app/'), project('Tree', '/work/app/tree')],
) => {
  let reads = 0;
  const store = new ProjectsStore({
    projects: async () => {
      reads += 1;
      return projects;
    },
  });
  const controls = fakeControls();
  const nav = fakeNavigation();
  const scope = createListScope({ daemonId: DAEMON, store, controls, routes, navigation: nav.navigation });
  return { scope, store, controls, nav, reads: () => reads };
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
};

describe('the ferret list routes', () => {
  test('a daemon’s ferret list is /d/<daemon>/ferrets, and nothing else is a list', () => {
    expect(routes.dashboardDaemon('/d/laptop/ferrets')).toBe('laptop');
    expect(routes.dashboardDaemon('/d/lap%2Ftop/ferrets/')).toBe('lap/top');
    expect(routes.dashboardDaemon('/d/laptop/ferrets/f1/chat')).toBeNull();
    expect(routes.dashboardDaemon('/settings')).toBeNull();
    expect(routes.dashboardPath('lap/top')).toBe('/d/lap%2Ftop/ferrets');
  });
});

describe('ferrets.list-scope, provided by Projects', () => {
  test('names the group a folder files under: the longest registered project that covers it, keyed by its path', async () => {
    const { scope, store } = setup();
    await store.hydrate();
    const { groupOf } = scope.snapshot();
    expect(groupOf('/work/app')).toEqual({ key: '/work/app', name: 'App' });
    expect(groupOf('/work/app/src')).toEqual({ key: '/work/app', name: 'App' });
    expect(groupOf('/work/app/tree/x')).toEqual({ key: '/work/app/tree', name: 'Tree' });
    expect(groupOf('/work/other')).toBeNull();
  });

  test('keeps one snapshot until the focus or the registry changes', async () => {
    const { scope, store, controls } = setup();
    const first = scope.snapshot();
    expect(scope.snapshot()).toBe(first);
    await store.hydrate();
    const afterRegistry = scope.snapshot();
    expect(afterRegistry).not.toBe(first);
    expect(scope.snapshot()).toBe(afterRegistry);
    controls.setProjectScope(DAEMON, '/work/app');
    expect(scope.snapshot().scope).toBe('/work/app');
    expect(scope.snapshot()).not.toBe(afterRegistry);
  });

  test('says the registry is unknown until a read settles, and keeps it unknown when the read fails', async () => {
    const { scope, store } = setup();
    expect(scope.snapshot().known).toBe(false);
    await store.hydrate();
    expect(scope.snapshot().known).toBe(true);

    const failing = new ProjectsStore({
      projects: async () => {
        throw new Error('offline');
      },
    });
    const failed = createListScope({
      daemonId: DAEMON,
      store: failing,
      controls: fakeControls(),
      routes,
      navigation: fakeNavigation().navigation,
    });
    await failing.hydrate().catch(() => undefined);
    expect(failed.snapshot().known).toBe(false);
  });

  test('focusing a folder writes the store first, then one history entry, and tells the list', () => {
    const { scope, controls, nav } = setup();
    let told = 0;
    scope.subscribe(() => (told += 1));
    const release = scope.watch();
    scope.enter('/work/app/');
    expect(controls.projectScope(DAEMON)).toBe('/work/app');
    expect(nav.entries).toEqual([{ kind: 'push', url: '/d/laptop/ferrets?project=%2Fwork%2Fapp' }]);
    expect(told).toBeGreaterThan(0);
    scope.exit();
    expect(controls.projectScope(DAEMON)).toBeNull();
    expect(nav.entries.at(-1)).toEqual({ kind: 'push', url: '/d/laptop/ferrets' });
    release();
  });

  test('recovering drops the focus and catches the address up without a history entry of its own', () => {
    const { scope, controls, nav } = setup();
    controls.setProjectScope(DAEMON, '/work/deleted');
    scope.recover();
    expect(controls.projectScope(DAEMON)).toBeNull();
    expect(nav.entries).toEqual([{ kind: 'replace', url: '/d/laptop/ferrets' }]);
  });

  test('a watching list reads the registry once, takes the focus an address carries, and follows Back and Forward', async () => {
    const { scope, controls, nav, reads } = setup();
    nav.go('/d/laptop/ferrets?project=%2Fwork%2Fapp%2F');
    const release = scope.watch();
    const second = scope.watch();
    await settle();
    expect(reads()).toBe(1);
    expect(controls.projectScope(DAEMON)).toBe('/work/app');
    nav.go('/d/laptop/ferrets?project=');
    expect(controls.projectScope(DAEMON)).toBeNull();
    release();
    release();
    expect(nav.listening()).toBe(1);
    second();
    expect(nav.listening()).toBe(0);
    expect(controls.listening()).toBe(0);
  });

  test('tells a watching list when the focus or the registry changes, and stops when released', async () => {
    const { scope, store, controls } = setup();
    let told = 0;
    const unsubscribe = scope.subscribe(() => (told += 1));
    const release = scope.watch();
    await settle();
    const afterRead = told;
    expect(afterRead).toBeGreaterThan(0);
    controls.changed();
    expect(told).toBe(afterRead + 1);
    release();
    controls.changed();
    await store.refresh();
    expect(told).toBe(afterRead + 1);
    unsubscribe();
  });

  test('a registry that cannot be read leaves the list grouped by folder, not broken', async () => {
    const store = new ProjectsStore({ projects: () => Promise.reject(new Error('Projects is off')) });
    const scope = createListScope({
      daemonId: DAEMON,
      store,
      controls: fakeControls(),
      routes,
      navigation: fakeNavigation().navigation,
    });
    const release = scope.watch();
    await settle();
    expect(scope.snapshot().groupOf('/work/app')).toBeNull();
    release();
  });
});
