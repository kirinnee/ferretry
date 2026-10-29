import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { parseRoute, type Route, routePath } from './pages/routes.ts';

export interface NavigateOptions {
  /** Replace the current history entry instead of adding one — for a redirect the reader did not ask for. */
  readonly replace?: boolean;
}

export interface RouterController {
  readonly route: Route;
  readonly navigate: (to: string, options?: NavigateOptions) => void;
  /**
   * WHICH HISTORY ENTRY IS ON SCREEN: stable across Back, Forward and a reload of that entry, and new on
   * every push. It is what a scroll position is remembered under, so returning to an entry restores it
   * while opening the same page afresh starts at the top — the browser's own contract for a document.
   */
  readonly entryKey: string;
  /**
   * An in-app "← back to `to`". When the entry before this one IS `to`, it is a real history step —
   * the same transition the browser's Back makes, so the page returns exactly as it was left and the
   * trail does not grow a loop. Otherwise (a deep link, a reload, a notification) it pushes `to`.
   */
  readonly back: (to: string) => void;
}

/** The persistence a reloaded tab reads its trail back from; `null` keeps the trail in memory only. */
export type RouterTrailStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface RouterProviderProps {
  readonly children: ReactNode;
  /** Browser seam for deterministic tests. The production root uses `window`. */
  readonly browser?: Window;
  /** Mints a history entry's identity. Defaults to `crypto.randomUUID`. */
  readonly newEntryKey?: () => string;
  /** Where the trail survives a reload. Defaults to this tab's `sessionStorage`, when the browser allows it. */
  readonly trailStorage?: RouterTrailStorage | null;
}

/** One history entry this router has seen: its identity and the pathname it showed. */
interface TrailEntry {
  readonly key: string;
  readonly path: string;
}

/** The fields this router adds to `history.state`. Anything else a page put there is kept beside them. */
interface EntryState {
  readonly fyEntry: string;
  readonly fyIndex: number;
}

export const ROUTER_TRAIL_KEY = 'fy-router-trail:v1';

const RouterContext = createContext<RouterController | null>(null);

const entryState = (state: unknown): EntryState | null => {
  if (typeof state !== 'object' || state === null) return null;
  const { fyEntry, fyIndex } = state as Partial<EntryState>;
  return typeof fyEntry === 'string' && typeof fyIndex === 'number' && Number.isInteger(fyIndex) && fyIndex >= 0
    ? { fyEntry, fyIndex }
    : null;
};

/** The pathname a destination names, ignoring its query and fragment — what a page is, not where in it. */
export const destinationPath = (to: string): string => new URL(to, 'http://router.invalid').pathname;

/** A trail read back from storage, or empty: a value that is not one is a fresh tab, not an error. */
export const readTrail = (storage: RouterTrailStorage | null): readonly (TrailEntry | null)[] => {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(ROUTER_TRAIL_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(entry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as TrailEntry).key === 'string' &&
      typeof (entry as TrailEntry).path === 'string'
        ? { key: (entry as TrailEntry).key, path: (entry as TrailEntry).path }
        : null,
    );
  } catch {
    return [];
  }
};

/** This tab's session storage, or `null` where the browser refuses it (a private window, a sandbox). */
export const browserTrailStorage = (browser: Pick<Window, 'sessionStorage'>): RouterTrailStorage | null => {
  try {
    return browser.sessionStorage;
  } catch {
    return null;
  }
};

const defaultEntryKey = (): string => crypto.randomUUID();

/**
 * Owns the public PWA's browser-history subscription.
 *
 * Route parsing stays pure in `pages/routes.ts`; this provider is the sole
 * place that mutates history. In particular, it carries no daemon address or
 * ambient selected daemon. A daemon only enters the route through its durable
 * runtime-paired id.
 *
 * EVERY ENTRY CARRIES AN IDENTITY (`fyEntry`) AND ITS PLACE (`fyIndex`) in `history.state`, and the
 * router keeps the trail of pathnames beside them in `sessionStorage`. That is what lets an in-app
 * "← Sessions" step BACK — the same in-document transition the browser's own Back makes — instead of
 * pushing a second copy of a page the reader already has behind them, and what a remembered scroll
 * position is filed under. An entry somebody else pushed (a hash a page wrote itself) is adopted the
 * first time it is shown, keeping whatever state it already carried.
 */
export function RouterProvider({
  children,
  browser = window,
  newEntryKey = defaultEntryKey,
  trailStorage = browserTrailStorage(browser),
}: RouterProviderProps) {
  const [route, setRoute] = useState<Route>(() => parseRoute(browser.location.pathname));
  const trail = useRef<(TrailEntry | null)[] | null>(null);
  const [entry, setEntry] = useState<EntryState>(() => {
    const restored = readTrail(trailStorage).slice();
    trail.current = restored;
    return adopt(browser, restored, trailStorage, newEntryKey, 0);
  });

  useEffect(() => {
    const readLocation = (): void => {
      setEntry(current => adopt(browser, trail.current ?? [], trailStorage, newEntryKey, current.fyIndex + 1));
      setRoute(parseRoute(browser.location.pathname));
    };
    browser.addEventListener('popstate', readLocation);
    return () => browser.removeEventListener('popstate', readLocation);
  }, [browser, newEntryKey, trailStorage]);

  const write = useCallback(
    (to: string, replace: boolean, at: EntryState): EntryState => {
      const fyIndex = replace ? at.fyIndex : at.fyIndex + 1;
      // A replace is the SAME entry showing something else, so it keeps its identity — and with it whatever
      // was remembered under it; only a push is a new place in the trail.
      const next: EntryState = { fyEntry: replace ? at.fyEntry : newEntryKey(), fyIndex };
      const kept = replace ? ownState(browser.history.state) : {};
      if (replace) browser.history.replaceState({ ...kept, ...next }, '', to);
      else browser.history.pushState(next, '', to);
      const list = (trail.current ?? []).slice(0, replace ? fyIndex : at.fyIndex + 1);
      list[fyIndex] = { key: next.fyEntry, path: browser.location.pathname };
      trail.current = list;
      saveTrail(trailStorage, list);
      return next;
    },
    [browser, newEntryKey, trailStorage],
  );

  const entryRef = useRef(entry);
  entryRef.current = entry;

  useEffect(() => {
    if (route.kind !== 'legacy-tasks-redirect' && route.kind !== 'legacy-attention-redirect') return;
    const canonicalPath = `${routePath(route)}${browser.location.search}`;
    setEntry(write(canonicalPath, true, entryRef.current));
    setRoute(route.to);
  }, [browser, route, write]);

  const navigate = useCallback(
    (to: string, options: NavigateOptions = {}): void => {
      const next = write(to, options.replace === true, entryRef.current);
      entryRef.current = next;
      setEntry(next);
      setRoute(parseRoute(browser.location.pathname));
    },
    [browser, write],
  );

  const back = useCallback(
    (to: string): void => {
      const previous = trail.current?.[entryRef.current.fyIndex - 1];
      if (previous !== undefined && previous !== null && previous.path === destinationPath(to)) browser.history.back();
      else navigate(to);
    },
    [browser, navigate],
  );

  const value = useMemo<RouterController>(
    () => ({ route, navigate, back, entryKey: entry.fyEntry }),
    [back, entry.fyEntry, navigate, route],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

/** Everything in `history.state` that is not this router's: a page's own fields survive a replace. */
const ownState = (state: unknown): Record<string, unknown> =>
  typeof state === 'object' && state !== null ? { ...(state as Record<string, unknown>) } : {};

const saveTrail = (storage: RouterTrailStorage | null, list: readonly (TrailEntry | null)[]): void => {
  try {
    storage?.setItem(ROUTER_TRAIL_KEY, JSON.stringify(list));
  } catch {
    // A full or refused store only costs the trail across a reload; navigation itself is unaffected.
  }
};

/**
 * The entry on screen, as this router knows it — adopting it first when it carries no identity yet:
 * the document's first entry, or one a page pushed itself. `fallbackIndex` places an adopted entry
 * after the one the router last showed. The trail records what the entry shows.
 */
function adopt(
  browser: Window,
  list: (TrailEntry | null)[],
  storage: RouterTrailStorage | null,
  newEntryKey: () => string,
  fallbackIndex: number,
): EntryState {
  const known = entryState(browser.history.state);
  const state = known ?? { fyEntry: newEntryKey(), fyIndex: list.length === 0 ? 0 : fallbackIndex };
  if (known === null) browser.history.replaceState({ ...ownState(browser.history.state), ...state }, '');
  const path = browser.location.pathname;
  const recorded = list[state.fyIndex];
  if (recorded?.key !== state.fyEntry || recorded.path !== path) {
    list[state.fyIndex] = { key: state.fyEntry, path };
    saveTrail(storage, list);
  }
  return state;
}

/** Reads the nearest app-root router. Rendering outside the root is a wiring error. */
export function useRouter(): RouterController {
  const router = useContext(RouterContext);
  if (router === null) throw new Error('useRouter must be rendered inside RouterProvider');
  return router;
}

/**
 * The nearest router, or null where none is mounted. For a surface that offers in-app links and is ALSO
 * rendered on its own — by a harness or a test — where a missing router means "follow the href".
 */
export function useOptionalRouter(): RouterController | null {
  return useContext(RouterContext);
}
