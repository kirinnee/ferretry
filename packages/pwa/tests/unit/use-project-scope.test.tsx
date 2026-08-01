import { describe, expect, it } from 'bun:test';
import { useSyncExternalStore } from 'react';

import {
  applyScopeFromLocation,
  browserScopeNavigation,
  enterProjectScope,
  exitProjectScope,
  parseRouteScope,
  PROJECT_SCOPE_PARAM,
  projectScopePath,
  projectScopeState,
  resolveScopePrecedence,
  type ScopeLocationSnapshot,
  type ScopeNavigation,
  useProjectScope,
} from '../../src/hooks/use-project-scope.ts';
import { type ControlsStorage, DaemonControlsStore } from '../../src/lib/controls.ts';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../support/dom.ts';

const laptop = daemonId('daemon/laptop');
const workstation = daemonId('daemon/workstation');

const memoryStorage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

const controlsStore = (): DaemonControlsStore => new DaemonControlsStore(memoryStorage());

interface FakeNavigation extends ScopeNavigation {
  readonly entries: { state: unknown; url: string; kind: 'push' | 'replace' }[];
  readonly announcements: number[];
  go(url: string, state?: unknown): void;
}

const fakeNavigation = (initial = '/d/daemon%2Flaptop', initialState: unknown = null): FakeNavigation => {
  let current = new URL(initial, 'https://pwa.example.test');
  let state = initialState;
  const entries: { state: unknown; url: string; kind: 'push' | 'replace' }[] = [];
  const announcements: number[] = [];
  const listeners = new Set<() => void>();
  return {
    entries,
    announcements,
    go: (url, next = null) => {
      current = new URL(url, 'https://pwa.example.test');
      state = next;
    },
    snapshot: () => ({ pathname: current.pathname, search: current.search, state }),
    push: (nextState, url) => {
      entries.push({ state: nextState, url, kind: 'push' });
      current = new URL(url, 'https://pwa.example.test');
      state = nextState;
    },
    replace: (nextState, url) => {
      entries.push({ state: nextState, url, kind: 'replace' });
      current = new URL(url, 'https://pwa.example.test');
      state = nextState;
    },
    announce: () => {
      announcements.push(entries.length);
      for (const listener of listeners) listener();
    },
    listen: onPop => {
      listeners.add(onPop);
      return () => listeners.delete(onPop);
    },
  };
};

const at = (pathname: string, search = '', state: unknown = null): ScopeLocationSnapshot => ({
  pathname,
  search,
  state,
});

describe('parseRouteScope', () => {
  it('is a tri-state: a path, an explicit clear, or silence', () => {
    expect(parseRouteScope('?project=%2Frepo')).toBe('/repo');
    expect(parseRouteScope(`?${PROJECT_SCOPE_PARAM}=`)).toBeNull();
    expect(parseRouteScope('?other=1')).toBe('absent');
    expect(parseRouteScope('')).toBe('absent');
  });
});

describe('projectScopePath', () => {
  it('addresses the daemon dashboard, with or without a scope', () => {
    expect(projectScopePath(laptop, null)).toBe('/d/daemon%2Flaptop');
    expect(projectScopePath(laptop, '/home/k/ferretry')).toBe('/d/daemon%2Flaptop?project=%2Fhome%2Fk%2Fferretry');
  });
});

describe('resolveScopePrecedence', () => {
  it('ignores every route that is not a daemon dashboard', () => {
    expect(resolveScopePrecedence(at('/', '?project=%2Frepo'))).toEqual({ apply: false });
    expect(resolveScopePrecedence(at('/d/daemon%2Flaptop/settings', '?project=%2Frepo'))).toEqual({ apply: false });
    expect(resolveScopePrecedence(at('/d/daemon%2Flaptop/session/sess-1', '?project=%2Frepo'))).toEqual({
      apply: false,
    });
  });

  it('leaves the persisted value alone when the URL says nothing', () => {
    expect(resolveScopePrecedence(at('/d/daemon%2Flaptop'))).toEqual({ apply: false });
  });

  it('reads a deep link and an explicit deep-link clear from the URL', () => {
    expect(resolveScopePrecedence(at('/d/daemon%2Flaptop', '?project=%2Frepo'))).toEqual({
      apply: true,
      daemonId: laptop,
      scope: '/repo',
    });
    expect(resolveScopePrecedence(at('/d/daemon%2Flaptop', '?project='))).toEqual({
      apply: true,
      daemonId: laptop,
      scope: null,
    });
  });

  it('lets the own history entry win, including its explicit null', () => {
    expect(
      resolveScopePrecedence(at('/d/daemon%2Flaptop', '?project=%2Fstale', projectScopeState(laptop, '/repo'))),
    ).toEqual({ apply: true, daemonId: laptop, scope: '/repo' });
    expect(
      resolveScopePrecedence(at('/d/daemon%2Flaptop', '?project=%2Fstale', projectScopeState(laptop, null))),
    ).toEqual({ apply: true, daemonId: laptop, scope: null });
  });

  it('treats a blank or non-string stored scope as no scope', () => {
    expect(
      resolveScopePrecedence(at('/d/daemon%2Flaptop', '', { projectScope: '', projectScopeDaemonId: laptop })),
    ).toEqual({ apply: true, daemonId: laptop, scope: null });
    expect(
      resolveScopePrecedence(at('/d/daemon%2Flaptop', '', { projectScope: 7, projectScopeDaemonId: laptop })),
    ).toEqual({ apply: true, daemonId: laptop, scope: null });
  });

  it('refuses a history entry written by another daemon and falls back to the URL', () => {
    expect(
      resolveScopePrecedence(at('/d/daemon%2Flaptop', '?project=%2Frepo', projectScopeState(workstation, '/other'))),
    ).toEqual({ apply: true, daemonId: laptop, scope: '/repo' });
    // With no URL channel either, the persisted value stands untouched.
    expect(resolveScopePrecedence(at('/d/daemon%2Flaptop', '', projectScopeState(workstation, '/other')))).toEqual({
      apply: false,
    });
  });

  it('ignores a history entry that is not a scope record at all', () => {
    expect(resolveScopePrecedence(at('/d/daemon%2Flaptop', '?project=%2Frepo', { pageKey: 'sessions' }))).toEqual({
      apply: true,
      daemonId: laptop,
      scope: '/repo',
    });
  });
});

describe('applyScopeFromLocation', () => {
  it('normalises the scope it writes and names the URL’s daemon', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation('/d/daemon%2Flaptop?project=%2Fhome%2Fk%2Fferretry%2F');

    expect(applyScopeFromLocation(controls, navigation)).toBe(true);
    expect(controls.controls(laptop).projectScope).toBe('/home/k/ferretry');
    expect(controls.controls(workstation).projectScope).toBeNull();
  });

  it('writes nothing when the location has no verdict', () => {
    const controls = controlsStore();
    controls.setControls(laptop, { projectScope: '/repo' });
    expect(applyScopeFromLocation(controls, fakeNavigation('/d/daemon%2Flaptop'))).toBe(false);
    expect(controls.controls(laptop).projectScope).toBe('/repo');
  });
});

describe('enterProjectScope / exitProjectScope', () => {
  it('normalises the scope, writes the store, and pushes one entry in both channels', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();

    expect(enterProjectScope(controls, laptop, '/home/k/ferretry/', navigation)).toBe(true);
    expect(controls.controls(laptop).projectScope).toBe('/home/k/ferretry');
    expect(navigation.entries).toEqual([
      {
        kind: 'push',
        url: '/d/daemon%2Flaptop?project=%2Fhome%2Fk%2Fferretry',
        state: { projectScope: '/home/k/ferretry', projectScopeDaemonId: laptop },
      },
    ]);
    expect(navigation.announcements).toHaveLength(1);
  });

  it('does not push a junk entry when already scoped here', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();

    enterProjectScope(controls, laptop, '/repo', navigation);
    expect(enterProjectScope(controls, laptop, '/repo/', navigation)).toBe(false);
    expect(navigation.entries).toHaveLength(1);
  });

  it('still pushes from a session page, folding navigation and scoping into one entry', () => {
    const controls = controlsStore();
    controls.setControls(laptop, { projectScope: '/repo' });
    const navigation = fakeNavigation('/d/daemon%2Flaptop/session/sess-1');

    expect(enterProjectScope(controls, laptop, '/repo', navigation)).toBe(true);
    expect(navigation.entries[0]?.url).toBe('/d/daemon%2Flaptop?project=%2Frepo');
  });

  it('scopes a daemon whose dashboard is not the one on screen', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation('/d/daemon%2Flaptop');

    expect(enterProjectScope(controls, workstation, '/repo', navigation)).toBe(true);
    expect(controls.controls(workstation).projectScope).toBe('/repo');
    expect(controls.controls(laptop).projectScope).toBeNull();
    expect(navigation.entries[0]?.url).toBe('/d/daemon%2Fworkstation?project=%2Frepo');
  });

  it('clears with an entry whose stored scope is an explicit null', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();

    enterProjectScope(controls, laptop, '/repo', navigation);
    expect(exitProjectScope(controls, laptop, navigation)).toBe(true);
    expect(controls.controls(laptop).projectScope).toBeNull();
    expect(navigation.entries[1]).toEqual({
      kind: 'push',
      url: '/d/daemon%2Flaptop',
      state: { projectScope: null, projectScopeDaemonId: laptop },
    });
  });

  it('is a no-op when there is nothing to clear here', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();
    expect(exitProjectScope(controls, laptop, navigation)).toBe(false);
    expect(navigation.entries).toHaveLength(0);
  });

  it('clears from another route even when the store already says null', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation('/d/daemon%2Flaptop/session/sess-1');
    expect(exitProjectScope(controls, laptop, navigation)).toBe(true);
    expect(navigation.entries[0]?.url).toBe('/d/daemon%2Flaptop');
  });

  it('set → clear → Back → Forward restores null rather than the stale scope', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();
    const visit = (index: number): void => {
      const entry = must(navigation.entries[index], `history entry ${index}`);
      navigation.go(entry.url, entry.state);
      applyScopeFromLocation(controls, navigation);
    };

    enterProjectScope(controls, laptop, '/repo', navigation);
    exitProjectScope(controls, laptop, navigation);

    // Back onto the scoped entry.
    visit(0);
    expect(controls.controls(laptop).projectScope).toBe('/repo');

    // Forward onto the clear entry: its URL carries no param, so only the
    // state channel can answer — and it answers null.
    visit(1);
    expect(controls.controls(laptop).projectScope).toBeNull();
  });
});

function ScopeHost({
  controls,
  navigation,
  scopeRecovered,
}: {
  readonly controls: DaemonControlsStore;
  readonly navigation: ScopeNavigation;
  readonly scopeRecovered?: boolean;
}) {
  useProjectScope({ controls, daemonId: laptop, navigation, scopeRecovered });
  useSyncExternalStore(
    controls.subscribe,
    () => controls.snapshot(),
    () => controls.snapshot(),
  );
  return <output>{controls.controls(laptop).projectScope ?? 'none'}</output>;
}

describe('useProjectScope', () => {
  it('applies the address on mount and on every popstate, then stops listening', async () => {
    const controls = controlsStore();
    const navigation = fakeNavigation('/d/daemon%2Flaptop?project=%2Frepo');
    const { container, unmount } = await mount(<ScopeHost controls={controls} navigation={navigation} />);

    expect(container.textContent).toBe('/repo');

    await interact(() => {
      navigation.go('/d/daemon%2Flaptop?project=%2Fother');
      navigation.announce();
    });
    expect(controls.controls(laptop).projectScope).toBe('/other');

    await unmount();
    navigation.go('/d/daemon%2Flaptop?project=%2Fthird');
    navigation.announce();
    expect(controls.controls(laptop).projectScope).toBe('/other');
  });

  it('replaces the address once the fleet view has recovered a missing folder', async () => {
    const controls = controlsStore();
    const navigation = fakeNavigation('/d/daemon%2Flaptop?project=%2Fgone');
    const { render, unmount } = await mount(<ScopeHost controls={controls} navigation={navigation} />);
    expect(navigation.entries).toHaveLength(0);

    await render(<ScopeHost controls={controls} navigation={navigation} scopeRecovered />);
    expect(navigation.entries).toEqual([
      { kind: 'replace', url: '/d/daemon%2Flaptop', state: { projectScope: null, projectScopeDaemonId: laptop } },
    ]);
    await unmount();
  });

  it('does not rewrite another daemon’s address on recovery', async () => {
    const controls = controlsStore();
    const navigation = fakeNavigation('/d/daemon%2Fworkstation?project=%2Fgone');
    const { unmount } = await mount(<ScopeHost controls={controls} navigation={navigation} scopeRecovered />);
    expect(navigation.entries).toHaveLength(0);
    await unmount();
  });
});

describe('browserScopeNavigation', () => {
  it('is one stable instance over the real window, and round-trips a push', () => {
    const navigation = browserScopeNavigation();
    expect(browserScopeNavigation()).toBe(navigation);

    const before = window.location.pathname + window.location.search;
    let popped = 0;
    const stop = navigation.listen(() => {
      popped += 1;
    });

    navigation.push(projectScopeState(laptop, '/repo'), projectScopePath(laptop, '/repo'));
    expect(navigation.snapshot()).toMatchObject({
      pathname: '/d/daemon%2Flaptop',
      search: '?project=%2Frepo',
      state: { projectScope: '/repo', projectScopeDaemonId: laptop },
    });

    navigation.announce();
    expect(popped).toBe(1);

    navigation.replace(null, before);
    stop();
    navigation.announce();
    expect(popped).toBe(1);
  });
});
