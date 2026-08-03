import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { parseRoute, type Route, routePath } from './pages/routes.ts';

export interface RouterController {
  readonly route: Route;
  readonly navigate: (to: string) => void;
}

export interface RouterProviderProps {
  readonly children: ReactNode;
  /** Browser seam for deterministic tests. The production root uses `window`. */
  readonly browser?: Window;
}

const RouterContext = createContext<RouterController | null>(null);

/**
 * Owns the public PWA's browser-history subscription.
 *
 * Route parsing stays pure in `pages/routes.ts`; this provider is the sole
 * place that mutates history. In particular, it carries no daemon address or
 * ambient selected daemon. A daemon only enters the route through its durable
 * runtime-paired id.
 */
export function RouterProvider({ children, browser = window }: RouterProviderProps) {
  const [route, setRoute] = useState<Route>(() => parseRoute(browser.location.pathname));

  useEffect(() => {
    const readLocation = (): void => setRoute(parseRoute(browser.location.pathname));
    browser.addEventListener('popstate', readLocation);
    return () => browser.removeEventListener('popstate', readLocation);
  }, [browser]);

  useEffect(() => {
    if (route.kind !== 'legacy-tasks-redirect') return;
    const canonicalPath = routePath(route);
    browser.history.replaceState({}, '', canonicalPath);
    setRoute(route.to);
  }, [browser, route]);

  const navigate = useCallback(
    (to: string): void => {
      browser.history.pushState({}, '', to);
      setRoute(parseRoute(browser.location.pathname));
    },
    [browser],
  );

  const value = useMemo<RouterController>(() => ({ route, navigate }), [navigate, route]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

/** Reads the nearest app-root router. Rendering outside the root is a wiring error. */
export function useRouter(): RouterController {
  const router = useContext(RouterContext);
  if (router === null) throw new Error('useRouter must be rendered inside RouterProvider');
  return router;
}
