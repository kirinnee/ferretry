import { describe, expect, test } from 'bun:test';
import {
  applyScopeFromLocation,
  browserScopeNavigation,
  enterProjectScope,
  exitProjectScope,
  parseRouteScope,
  PROJECT_SCOPE_PARAM,
  projectScopePath,
  projectScopeState,
  recoverScopeAddress,
  resolveScopePrecedence,
  type ScopeControls,
  type ScopeLocationSnapshot,
  type ScopeNavigation,
  type ScopeRoutes,
} from '../../../app/lib/project-scope.ts';

const laptop = 'daemon/laptop';
const workstation = 'daemon/workstation';

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} is missing`);
  return value;
};

/** The shell's route table behind the two functions the machine needs: a daemon's ferret list lives at `/d/<id>/ferrets`. */
const routes: ScopeRoutes = {
  dashboardDaemon: pathname => {
    const match = /^\/d\/([^/]+)\/ferrets$/u.exec(pathname);
    return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
  },
  dashboardPath: daemonId => `/d/${encodeURIComponent(daemonId)}/ferrets`,
};

/** The device's persisted controls, per daemon, in memory. */
const controlsStore = (): ScopeControls & { snapshot(): ReadonlyMap<string, string | null> } => {
  const values = new Map<string, string | null>();
  return {
    projectScope: daemonId => values.get(daemonId) ?? null,
    setProjectScope: (daemonId, scope) => {
      values.set(daemonId, scope);
    },
    snapshot: () => values,
  };
};

interface FakeNavigation extends ScopeNavigation {
  readonly entries: { state: unknown; url: string; kind: 'push' | 'replace' }[];
  readonly announcements: number[];
  go(url: string, state?: unknown): void;
}

const fakeNavigation = (initial = '/d/daemon%2Flaptop/ferrets', initialState: unknown = null): FakeNavigation => {
  let current = new URL(initial, 'https://app.example.test');
  let state = initialState;
  const entries: { state: unknown; url: string; kind: 'push' | 'replace' }[] = [];
  const announcements: number[] = [];
  const listeners = new Set<() => void>();
  return {
    entries,
    announcements,
    go: (url, next = null) => {
      current = new URL(url, 'https://app.example.test');
      state = next;
    },
    snapshot: () => ({ pathname: current.pathname, search: current.search, state }),
    push: (nextState, url) => {
      entries.push({ state: nextState, url, kind: 'push' });
      current = new URL(url, 'https://app.example.test');
      state = nextState;
    },
    replace: (nextState, url) => {
      entries.push({ state: nextState, url, kind: 'replace' });
      current = new URL(url, 'https://app.example.test');
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
  test('is a tri-state: a path, an explicit clear, or silence', () => {
    expect(parseRouteScope('?project=%2Frepo')).toBe('/repo');
    expect(parseRouteScope(`?${PROJECT_SCOPE_PARAM}=`)).toBeNull();
    expect(parseRouteScope('?other=1')).toBe('absent');
    expect(parseRouteScope('')).toBe('absent');
  });
});

describe('projectScopePath', () => {
  test('addresses the daemon ferret list, with or without a scope', () => {
    expect(projectScopePath(routes, laptop, null)).toBe('/d/daemon%2Flaptop/ferrets');
    expect(projectScopePath(routes, laptop, '/home/k/ferretry')).toBe(
      '/d/daemon%2Flaptop/ferrets?project=%2Fhome%2Fk%2Fferretry',
    );
  });
});

describe('resolveScopePrecedence', () => {
  test('ignores every route that is not a daemon ferret list', () => {
    expect(resolveScopePrecedence(routes, at('/', '?project=%2Frepo'))).toEqual({ apply: false });
    expect(resolveScopePrecedence(routes, at('/d/daemon%2Flaptop/settings', '?project=%2Frepo'))).toEqual({
      apply: false,
    });
    expect(resolveScopePrecedence(routes, at('/d/daemon%2Flaptop/ferrets/f-1', '?project=%2Frepo'))).toEqual({
      apply: false,
    });
  });

  test('leaves the persisted value alone when the URL says nothing', () => {
    expect(resolveScopePrecedence(routes, at('/d/daemon%2Flaptop/ferrets'))).toEqual({ apply: false });
  });

  test('reads a deep link and an explicit deep-link clear from the URL', () => {
    expect(resolveScopePrecedence(routes, at('/d/daemon%2Flaptop/ferrets', '?project=%2Frepo'))).toEqual({
      apply: true,
      daemonId: laptop,
      scope: '/repo',
    });
    expect(resolveScopePrecedence(routes, at('/d/daemon%2Flaptop/ferrets', '?project='))).toEqual({
      apply: true,
      daemonId: laptop,
      scope: null,
    });
  });

  test('lets the own history entry win, including its explicit null', () => {
    expect(
      resolveScopePrecedence(
        routes,
        at('/d/daemon%2Flaptop/ferrets', '?project=%2Fstale', projectScopeState(laptop, '/repo')),
      ),
    ).toEqual({ apply: true, daemonId: laptop, scope: '/repo' });
    expect(
      resolveScopePrecedence(
        routes,
        at('/d/daemon%2Flaptop/ferrets', '?project=%2Fstale', projectScopeState(laptop, null)),
      ),
    ).toEqual({ apply: true, daemonId: laptop, scope: null });
  });

  test('treats a blank or non-string stored scope as no scope', () => {
    expect(
      resolveScopePrecedence(
        routes,
        at('/d/daemon%2Flaptop/ferrets', '', { projectScope: '', projectScopeDaemonId: laptop }),
      ),
    ).toEqual({ apply: true, daemonId: laptop, scope: null });
    expect(
      resolveScopePrecedence(
        routes,
        at('/d/daemon%2Flaptop/ferrets', '', { projectScope: 7, projectScopeDaemonId: laptop }),
      ),
    ).toEqual({ apply: true, daemonId: laptop, scope: null });
  });

  test('refuses a history entry written by another daemon and falls back to the URL', () => {
    expect(
      resolveScopePrecedence(
        routes,
        at('/d/daemon%2Flaptop/ferrets', '?project=%2Frepo', projectScopeState(workstation, '/other')),
      ),
    ).toEqual({ apply: true, daemonId: laptop, scope: '/repo' });
    // With no URL channel either, the persisted value stands untouched.
    expect(
      resolveScopePrecedence(routes, at('/d/daemon%2Flaptop/ferrets', '', projectScopeState(workstation, '/other'))),
    ).toEqual({
      apply: false,
    });
  });

  test('ignores a history entry that is not a scope record at all', () => {
    expect(
      resolveScopePrecedence(routes, at('/d/daemon%2Flaptop/ferrets', '?project=%2Frepo', { pageKey: 'ferrets' })),
    ).toEqual({
      apply: true,
      daemonId: laptop,
      scope: '/repo',
    });
  });
});

describe('applyScopeFromLocation', () => {
  test('normalises the scope it writes and names the URL’s daemon', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation('/d/daemon%2Flaptop/ferrets?project=%2Fhome%2Fk%2Fferretry%2F');

    expect(applyScopeFromLocation(controls, routes, navigation)).toBe(true);
    expect(controls.projectScope(laptop)).toBe('/home/k/ferretry');
    expect(controls.projectScope(workstation)).toBeNull();
  });

  test('writes nothing when the location has no verdict', () => {
    const controls = controlsStore();
    controls.setProjectScope(laptop, '/repo');
    expect(applyScopeFromLocation(controls, routes, fakeNavigation('/d/daemon%2Flaptop/ferrets'))).toBe(false);
    expect(controls.projectScope(laptop)).toBe('/repo');
  });
});

describe('enterProjectScope / exitProjectScope', () => {
  test('normalises the scope, writes the store, and pushes one entry in both channels', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();

    expect(enterProjectScope(controls, routes, laptop, '/home/k/ferretry/', navigation)).toBe(true);
    expect(controls.projectScope(laptop)).toBe('/home/k/ferretry');
    expect(navigation.entries).toEqual([
      {
        kind: 'push',
        url: '/d/daemon%2Flaptop/ferrets?project=%2Fhome%2Fk%2Fferretry',
        state: { projectScope: '/home/k/ferretry', projectScopeDaemonId: laptop },
      },
    ]);
    expect(navigation.announcements).toHaveLength(1);
  });

  test('does not push a junk entry when already scoped here', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();

    enterProjectScope(controls, routes, laptop, '/repo', navigation);
    expect(enterProjectScope(controls, routes, laptop, '/repo/', navigation)).toBe(false);
    expect(navigation.entries).toHaveLength(1);
  });

  test('still pushes from a ferret page, folding navigation and scoping into one entry', () => {
    const controls = controlsStore();
    controls.setProjectScope(laptop, '/repo');
    const navigation = fakeNavigation('/d/daemon%2Flaptop/ferrets/f-1');

    expect(enterProjectScope(controls, routes, laptop, '/repo', navigation)).toBe(true);
    expect(navigation.entries[0]?.url).toBe('/d/daemon%2Flaptop/ferrets?project=%2Frepo');
  });

  test('scopes a daemon whose dashboard is not the one on screen', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation('/d/daemon%2Flaptop/ferrets');

    expect(enterProjectScope(controls, routes, workstation, '/repo', navigation)).toBe(true);
    expect(controls.projectScope(workstation)).toBe('/repo');
    expect(controls.projectScope(laptop)).toBeNull();
    expect(navigation.entries[0]?.url).toBe('/d/daemon%2Fworkstation/ferrets?project=%2Frepo');
  });

  test('clears with an entry whose stored scope is an explicit null', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();

    enterProjectScope(controls, routes, laptop, '/repo', navigation);
    expect(exitProjectScope(controls, routes, laptop, navigation)).toBe(true);
    expect(controls.projectScope(laptop)).toBeNull();
    expect(navigation.entries[1]).toEqual({
      kind: 'push',
      url: '/d/daemon%2Flaptop/ferrets',
      state: { projectScope: null, projectScopeDaemonId: laptop },
    });
  });

  test('is a no-op when there is nothing to clear here', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();
    expect(exitProjectScope(controls, routes, laptop, navigation)).toBe(false);
    expect(navigation.entries).toHaveLength(0);
  });

  test('clears from another route even when the store already says null', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation('/d/daemon%2Flaptop/ferrets/f-1');
    expect(exitProjectScope(controls, routes, laptop, navigation)).toBe(true);
    expect(navigation.entries[0]?.url).toBe('/d/daemon%2Flaptop/ferrets');
  });

  test('set → clear → Back → Forward restores null rather than the stale scope', () => {
    const controls = controlsStore();
    const navigation = fakeNavigation();
    const visit = (index: number): void => {
      const entry = must(navigation.entries[index], `history entry ${index}`);
      navigation.go(entry.url, entry.state);
      applyScopeFromLocation(controls, routes, navigation);
    };

    enterProjectScope(controls, routes, laptop, '/repo', navigation);
    exitProjectScope(controls, routes, laptop, navigation);

    // Back onto the scoped entry.
    visit(0);
    expect(controls.projectScope(laptop)).toBe('/repo');

    // Forward onto the clear entry: its URL carries no param, so only the
    // state channel can answer — and it answers null.
    visit(1);
    expect(controls.projectScope(laptop)).toBeNull();
  });
});

describe('recoverScopeAddress', () => {
  test('replaces the address once the ferret list has recovered a missing folder', () => {
    const navigation = fakeNavigation('/d/daemon%2Flaptop/ferrets?project=%2Fgone', projectScopeState(laptop, '/gone'));

    expect(recoverScopeAddress(routes, laptop, navigation)).toBe(true);
    expect(navigation.entries).toEqual([
      {
        kind: 'replace',
        url: '/d/daemon%2Flaptop/ferrets',
        state: { projectScope: null, projectScopeDaemonId: laptop },
      },
    ]);
  });

  test('does not rewrite another daemon’s address on recovery', () => {
    const navigation = fakeNavigation('/d/daemon%2Fworkstation/ferrets?project=%2Frepo');

    expect(recoverScopeAddress(routes, laptop, navigation)).toBe(false);
    expect(navigation.entries).toEqual([]);
  });
});

describe('browserScopeNavigation', () => {
  /** A window that writes down what the machine does to it; the app shell's own DOM is not this package's. */
  const installWindow = () => {
    const log: string[] = [];
    const listeners = new Set<() => void>();
    const fakeWindow = {
      location: { pathname: '/d/daemon%2Flaptop/ferrets', search: '?project=%2Frepo' },
      history: {
        state: { projectScope: '/repo', projectScopeDaemonId: laptop },
        pushState: (state: unknown, title: string, url: string) =>
          log.push(`push ${JSON.stringify(state)} ${title} ${url}`),
        replaceState: (state: unknown, title: string, url: string) =>
          log.push(`replace ${JSON.stringify(state)} ${title} ${url}`),
      },
      dispatchEvent: (event: unknown) => {
        log.push(`dispatch ${(event as { type: string }).type}`);
        for (const listener of listeners) listener();
        return true;
      },
      addEventListener: (type: string, listener: () => void) => {
        log.push(`listen ${type}`);
        listeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        log.push(`unlisten ${type}`);
        listeners.delete(listener);
      },
    };
    class FakePopStateEvent {
      constructor(readonly type: string) {}
    }
    const host = globalThis as unknown as Record<string, unknown>;
    const had = { window: 'window' in host, PopStateEvent: 'PopStateEvent' in host };
    const saved = { window: host.window, PopStateEvent: host.PopStateEvent };
    host.window = fakeWindow;
    host.PopStateEvent = FakePopStateEvent;
    const restore = () => {
      for (const name of ['window', 'PopStateEvent'] as const) {
        if (had[name]) host[name] = saved[name];
        else delete host[name];
      }
    };
    return { log, restore };
  };

  test('is one instance for the life of the page, so an effect keyed on it is not rebuilt', () => {
    expect(browserScopeNavigation()).toBe(browserScopeNavigation());
  });

  test('reads the window’s own history state and writes through its history, then announces', () => {
    const { log, restore } = installWindow();
    try {
      const navigation = browserScopeNavigation();
      expect(navigation.snapshot()).toEqual({
        pathname: '/d/daemon%2Flaptop/ferrets',
        search: '?project=%2Frepo',
        state: { projectScope: '/repo', projectScopeDaemonId: laptop },
      });
      navigation.push(projectScopeState(laptop, null), '/d/daemon%2Flaptop/ferrets');
      navigation.replace(projectScopeState(laptop, '/repo'), '/d/daemon%2Flaptop/ferrets?project=%2Frepo');
      navigation.announce();
      expect(log).toEqual([
        'push {"projectScope":null,"projectScopeDaemonId":"daemon/laptop"}  /d/daemon%2Flaptop/ferrets',
        'replace {"projectScope":"/repo","projectScopeDaemonId":"daemon/laptop"}  /d/daemon%2Flaptop/ferrets?project=%2Frepo',
        'dispatch popstate',
      ]);
    } finally {
      restore();
    }
  });

  test('a listener hears the announcement until it is removed', () => {
    const { log, restore } = installWindow();
    try {
      const navigation = browserScopeNavigation();
      let heard = 0;
      const stop = navigation.listen(() => {
        heard += 1;
      });
      navigation.announce();
      stop();
      navigation.announce();
      expect(heard).toBe(1);
      expect(log).toEqual(['listen popstate', 'dispatch popstate', 'unlisten popstate', 'dispatch popstate']);
    } finally {
      restore();
    }
  });
});
