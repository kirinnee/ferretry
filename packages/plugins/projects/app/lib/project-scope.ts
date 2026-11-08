/**
 * FOLDER MODE — the deterministic scope machine.
 *
 * "Focus a folder" is one value: `projectScope`, a group KEY (a normalised project path, or a raw folder for fallback
 * groups — never a display name, which can collide). It lives in the device's persisted controls beside the ferret
 * list's own filters, and RENDERING READS THE STORE VALUE ONLY. The URL and history never feed a render directly; they
 * only *write the store*, one way, which is what makes this machine loop-proof.
 *
 * THE DETERMINISM CONTRACT (kept):
 *   - every in-app scope change writes the store FIRST, then pushes ONE history entry carrying the scope in BOTH
 *     channels — the URL (`?project=…`) and `history.state`, INCLUDING an explicit `null` on clear;
 *   - `popstate` (and boot) follow a fixed precedence: own history state → URL tri-state → persisted store value;
 *   - so set → clear → Back → Forward is deterministic: Forward lands on the clear entry whose stored scope is `null`,
 *     where a URL-only rule would leave the stale earlier scope.
 *
 * THE SCOPE IS PER DAEMON. The history state carries its daemon: an entry written on daemon A must not be honoured
 * while the reader is looking at daemon B — a filesystem path means different things on two machines.
 *
 * WHAT THE SHELL SUPPLIES. Which pathname is a daemon's ferret list, and where it lives, is the Ferrets screen's fact,
 * not Projects': `ScopeRoutes` is that seam (the shell's route table behind two functions). The persisted controls are
 * the shell's too (`ScopeControls`). `window` arrives as a port (`ScopeNavigation`), so the machine is provable
 * without a document.
 */
import { normalizeProjectPath } from './folders.ts';

/** The one query parameter that carries a folder scope. */
export const PROJECT_SCOPE_PARAM = 'project';

export interface ScopeLocationSnapshot {
  readonly pathname: string;
  readonly search: string;
  readonly state: unknown;
}

/**
 * The browser facts this machine reads and writes. `announce` exists because a programmatic `pushState` fires no
 * `popstate`: the synthetic event is how the app's own listeners learn about an in-app navigation.
 */
export interface ScopeNavigation {
  snapshot(): ScopeLocationSnapshot;
  push(state: unknown, url: string): void;
  replace(state: unknown, url: string): void;
  announce(): void;
  listen(onPop: () => void): () => void;
}

/** The device's persisted folder-mode value, per daemon. */
export interface ScopeControls {
  projectScope(daemonId: string): string | null;
  setProjectScope(daemonId: string, scope: string | null): void;
}

/** The ferret list's address, per daemon. */
export interface ScopeRoutes {
  /** The daemon whose ferret list this pathname is, or `null` for any other route. */
  dashboardDaemon(pathname: string): string | null;
  dashboardPath(daemonId: string): string;
}

/** The slice of the browser's window this machine touches; the app shell's tsconfig has the DOM, this one does not. */
interface BrowserWindow {
  readonly location: { readonly pathname: string; readonly search: string };
  readonly history: {
    readonly state: unknown;
    pushState(state: unknown, title: string, url: string): void;
    replaceState(state: unknown, title: string, url: string): void;
  };
  dispatchEvent(event: unknown): boolean;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

let browserNavigation: ScopeNavigation | undefined;

/**
 * The real window, as a lazily built singleton. The identity has to be stable: it is an effect dependency, and a fresh
 * object per render would tear the listener down and rebuild it on every parent update.
 * @pending projects: app/lib/project-scope.ts is reached only through app/hooks/use-project-scope.ts: the Sessions page when rebuild/port-ferrets-b lands (today: packages/pwa/src/components/sessions-page.tsx:36)
 */
export const browserScopeNavigation = (): ScopeNavigation => {
  const browser = globalThis as unknown as {
    readonly window: BrowserWindow;
    readonly PopStateEvent: new (type: string) => unknown;
  };
  browserNavigation ??= {
    snapshot: () => ({
      pathname: browser.window.location.pathname,
      search: browser.window.location.search,
      // `window.history.state`, NOT an event's `state`: the synthetic PopStateEvent from an in-app push carries
      // `state: null`, while this is correct in both the synthetic and the real back/forward case.
      state: browser.window.history.state,
    }),
    push: (state, url) => browser.window.history.pushState(state, '', url),
    replace: (state, url) => browser.window.history.replaceState(state, '', url),
    announce: () => void browser.window.dispatchEvent(new browser.PopStateEvent('popstate')),
    listen: onPop => {
      browser.window.addEventListener('popstate', onPop);
      return () => browser.window.removeEventListener('popstate', onPop);
    },
  };
  return browserNavigation;
};

/**
 * URL tri-state on a daemon's ferret list: a real path (deep link), `null` (`?project=` present but empty — an
 * unambiguous deep-link clear), or `'absent'` (no param — the URL says nothing, so the persisted value applies).
 */
export const parseRouteScope = (search: string): string | null | 'absent' => {
  const params = new URLSearchParams(search);
  if (!params.has(PROJECT_SCOPE_PARAM)) return 'absent';
  const raw = params.get(PROJECT_SCOPE_PARAM) ?? '';
  return raw === '' ? null : raw;
};

/** What an in-app scope change writes into its own history entry. */
export interface ProjectScopeHistoryState {
  readonly projectScope: string | null;
  /** Which daemon the scope belongs to; a path alone is not an identity. */
  readonly projectScopeDaemonId: string;
}

export const projectScopeState = (daemonId: string, scope: string | null): ProjectScopeHistoryState => ({
  projectScope: scope,
  projectScopeDaemonId: daemonId,
});

/** The canonical address for a daemon's ferret list at a given scope. */
export const projectScopePath = (routes: ScopeRoutes, daemonId: string, scope: string | null): string =>
  scope === null
    ? routes.dashboardPath(daemonId)
    : `${routes.dashboardPath(daemonId)}?${PROJECT_SCOPE_PARAM}=${encodeURIComponent(scope)}`;

export type ScopeDecision =
  | { readonly apply: true; readonly daemonId: string; readonly scope: string | null }
  | { readonly apply: false };

/**
 * The precedence table, as a pure decision over the two navigation channels. `{ apply: false }` means "leave the
 * persisted store value alone" — the off-list, other-daemon and `'absent'` cases.
 */
export const resolveScopePrecedence = (routes: ScopeRoutes, location: ScopeLocationSnapshot): ScopeDecision => {
  // Scope is only parsed on a daemon's ferret list; every other route ignores it.
  const daemonId = routes.dashboardDaemon(location.pathname);
  if (daemonId === null) return { apply: false };
  const state = location.state;
  if (state !== null && typeof state === 'object' && 'projectScope' in state) {
    const record = state as { projectScope?: unknown; projectScopeDaemonId?: unknown };
    // Own-entry state wins, INCLUDING an explicit null (the clear entry) — but only for the daemon that wrote it.
    if (record.projectScopeDaemonId === daemonId) {
      const value = record.projectScope;
      return { apply: true, daemonId, scope: typeof value === 'string' && value !== '' ? value : null };
    }
  }
  const routeScope = parseRouteScope(location.search);
  if (routeScope === 'absent') return { apply: false };
  return { apply: true, daemonId, scope: routeScope };
};

/** Boot and every popstate: read the two channels, write the store, stop. */
export const applyScopeFromLocation = (
  controls: ScopeControls,
  routes: ScopeRoutes,
  navigation: ScopeNavigation,
): boolean => {
  const decision = resolveScopePrecedence(routes, navigation.snapshot());
  if (!decision.apply) return false;
  controls.setProjectScope(decision.daemonId, decision.scope === null ? null : normalizeProjectPath(decision.scope));
  return true;
};

const listDaemon = (routes: ScopeRoutes, navigation: ScopeNavigation): string | null =>
  routes.dashboardDaemon(navigation.snapshot().pathname);

/**
 * Focus a folder. Store FIRST, then ONE history entry carrying the scope in both channels, then the synthetic popstate
 * the app's listeners expect.
 *
 * A no-op when already scoped here on this daemon's list (no junk history entry); from another page it still pushes,
 * folding navigation and scoping into one entry. `path` is any group key; it is normalised so the stored scope is
 * canonical regardless of trailing-slash variance in the source.
 */
export const enterProjectScope = (
  controls: ScopeControls,
  routes: ScopeRoutes,
  daemonId: string,
  path: string,
  navigation: ScopeNavigation = browserScopeNavigation(),
): boolean => {
  const scope = normalizeProjectPath(path);
  const here = listDaemon(routes, navigation) === daemonId;
  if (here && controls.projectScope(daemonId) === scope) return false;
  controls.setProjectScope(daemonId, scope);
  navigation.push(projectScopeState(daemonId, scope), projectScopePath(routes, daemonId, scope));
  navigation.announce();
  return true;
};

/**
 * Leave folder mode. Store cleared FIRST, then the clean-URL clear entry whose stored scope is `null` — which is what
 * makes Forward-after-clear deterministic (it restores null, not the stale earlier scope).
 */
export const exitProjectScope = (
  controls: ScopeControls,
  routes: ScopeRoutes,
  daemonId: string,
  navigation: ScopeNavigation = browserScopeNavigation(),
): boolean => {
  const here = listDaemon(routes, navigation) === daemonId;
  if (here && controls.projectScope(daemonId) === null) return false;
  controls.setProjectScope(daemonId, null);
  navigation.push(projectScopeState(daemonId, null), projectScopePath(routes, daemonId, null));
  navigation.announce();
  return true;
};

/**
 * Catches the address up after missing-folder recovery. `replaceState`, not `push`: recovering from a folder that no
 * longer exists is bookkeeping, and a reader pressing Back should not land on the address that named it.
 */
export const recoverScopeAddress = (
  routes: ScopeRoutes,
  daemonId: string,
  navigation: ScopeNavigation = browserScopeNavigation(),
): boolean => {
  if (listDaemon(routes, navigation) !== daemonId) return false;
  navigation.replace(projectScopeState(daemonId, null), projectScopePath(routes, daemonId, null));
  return true;
};
