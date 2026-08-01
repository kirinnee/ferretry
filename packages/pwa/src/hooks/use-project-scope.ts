/**
 * FOLDER MODE — the deterministic scope machine.
 *
 * Ported from kteam `ui/src/hooks/useProjectScope.ts`. "Focus a folder" is one
 * value: `projectScope`, a group KEY (a normalised project path, or a raw cwd
 * for fallback groups — never a display name, which can collide). It lives in
 * the persisted controls beside `query`/`mode`, and RENDERING READS THE STORE
 * VALUE ONLY. The URL and history never feed a render directly; they only
 * *write the store*, one way, which is what makes this machine loop-proof.
 *
 * THE DETERMINISM CONTRACT (audit-mandated in the original, kept here):
 *   - every in-app scope change writes the store FIRST, then pushes ONE history
 *     entry carrying the scope in BOTH channels — the URL (`?project=…`) and
 *     `history.state`, INCLUDING an explicit `null` on clear;
 *   - `popstate` (and boot) follow a fixed precedence: own history state →
 *     URL tri-state → persisted store value;
 *   - so set → clear → Back → Forward is deterministic: Forward lands on the
 *     clear entry whose stored scope is `null`, where a URL-only rule would
 *     leave the stale earlier scope.
 *
 * WHAT CHANGED FOR FERRETRY.
 *
 *   - THE DASHBOARD IS PER DAEMON. kteam's dashboard was `/`; here it is
 *     `/d/<daemonId>`, so the precedence answers WHICH daemon a scope belongs
 *     to as well as what it is, and the store write names that daemon.
 *   - THE HISTORY STATE CARRIES ITS DAEMON. An entry written on daemon A must
 *     not be honoured while the reader is looking at daemon B — a filesystem
 *     path means different things on two machines, and both daemons routinely
 *     have a `/repo`. The state channel is ignored unless its daemon matches
 *     the route's; the URL channel is already daemon-qualified by the path.
 *   - NO WIDENING CAST. kteam had to assert `projectScope` onto its controls
 *     patch because the field had not landed in the store yet. `controls.ts`
 *     owns it here, per daemon, so both accessors are ordinary typed reads.
 *   - MISSING-FOLDER RECOVERY IS ALREADY PORTED. `fleet-grouping.fleetView`
 *     decides resolvability and `hooks/use-fleet-view.ts` clears the store once
 *     per episode. Only the URL half was missing, so this hook takes that
 *     verdict as `scopeRecovered` and replaces the address (no history growth)
 *     rather than re-deciding it.
 *   - `window` ARRIVES AS A PORT. Every effect here goes through
 *     `ScopeNavigation`, so the machine is provable without a document and a
 *     host that owns its own router can supply one.
 */

import { useEffect } from 'react';
import type { DaemonControlsStore } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { normalizeProjectPath } from '../lib/fleet-grouping.ts';
import { daemonSessionsPath, parseRoute } from '../lib/pages/routes.ts';

/** The one query parameter that carries a folder scope. */
export const PROJECT_SCOPE_PARAM = 'project';

export interface ScopeLocationSnapshot {
  readonly pathname: string;
  readonly search: string;
  readonly state: unknown;
}

/**
 * The browser facts this machine reads and writes. `announce` exists because a
 * programmatic `pushState` fires no `popstate`: the synthetic event is how the
 * app's own listeners (this hook, and any router a host adds) learn about an
 * in-app navigation.
 */
export interface ScopeNavigation {
  snapshot(): ScopeLocationSnapshot;
  push(state: unknown, url: string): void;
  replace(state: unknown, url: string): void;
  announce(): void;
  listen(onPop: () => void): () => void;
}

let browserNavigation: ScopeNavigation | undefined;

/**
 * The real window, as a lazily built singleton. The identity has to be stable:
 * it is an effect dependency, and a fresh object per render would tear the
 * listener down and rebuild it on every parent update.
 */
export const browserScopeNavigation = (): ScopeNavigation => {
  browserNavigation ??= {
    snapshot: () => ({
      pathname: window.location.pathname,
      search: window.location.search,
      // `window.history.state`, NOT an event's `state`: the synthetic
      // PopStateEvent from an in-app push carries `state: null`, while this is
      // correct in both the synthetic and the real back/forward case.
      state: window.history.state,
    }),
    push: (state, url) => window.history.pushState(state, '', url),
    replace: (state, url) => window.history.replaceState(state, '', url),
    announce: () => window.dispatchEvent(new PopStateEvent('popstate')),
    listen: onPop => {
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    },
  };
  return browserNavigation;
};

/**
 * URL tri-state on a daemon's dashboard: a real path (deep link), `null`
 * (`?project=` present but empty — an unambiguous deep-link clear), or
 * `'absent'` (no param — the URL says nothing, so the persisted value applies).
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
  readonly projectScopeDaemonId: DaemonId;
}

export const projectScopeState = (daemonId: DaemonId, scope: string | null): ProjectScopeHistoryState => ({
  projectScope: scope,
  projectScopeDaemonId: daemonId,
});

/** The canonical address for a daemon's dashboard at a given scope. */
export const projectScopePath = (daemonId: DaemonId, scope: string | null): string =>
  scope === null
    ? daemonSessionsPath(daemonId)
    : `${daemonSessionsPath(daemonId)}?${PROJECT_SCOPE_PARAM}=${encodeURIComponent(scope)}`;

export type ScopeDecision =
  | { readonly apply: true; readonly daemonId: DaemonId; readonly scope: string | null }
  | { readonly apply: false };

/**
 * The precedence table, as a pure decision over the two navigation channels.
 * `{ apply: false }` means "leave the persisted store value alone" — the
 * off-dashboard, other-daemon and `'absent'` cases.
 */
export const resolveScopePrecedence = (location: ScopeLocationSnapshot): ScopeDecision => {
  // Scope is only parsed on a daemon dashboard; every other route ignores it.
  const route = parseRoute(location.pathname);
  if (route.kind !== 'sessions') return { apply: false };
  const state = location.state;
  if (state !== null && typeof state === 'object' && 'projectScope' in state) {
    const record = state as { projectScope?: unknown; projectScopeDaemonId?: unknown };
    // Own-entry state wins, INCLUDING an explicit null (the clear entry) — but
    // only for the daemon that wrote it.
    if (record.projectScopeDaemonId === route.daemonId) {
      const value = record.projectScope;
      return {
        apply: true,
        daemonId: route.daemonId,
        scope: typeof value === 'string' && value !== '' ? value : null,
      };
    }
  }
  const routeScope = parseRouteScope(location.search);
  if (routeScope === 'absent') return { apply: false };
  return { apply: true, daemonId: route.daemonId, scope: routeScope };
};

/** Boot and every popstate: read the two channels, write the store, stop. */
export const applyScopeFromLocation = (controls: DaemonControlsStore, navigation: ScopeNavigation): boolean => {
  const decision = resolveScopePrecedence(navigation.snapshot());
  if (!decision.apply) return false;
  controls.setControls(decision.daemonId, {
    projectScope: decision.scope === null ? null : normalizeProjectPath(decision.scope),
  });
  return true;
};

const dashboardDaemon = (navigation: ScopeNavigation): DaemonId | null => {
  const route = parseRoute(navigation.snapshot().pathname);
  return route.kind === 'sessions' ? route.daemonId : null;
};

/**
 * Focus a folder. Store FIRST, then ONE history entry carrying the scope in
 * both channels, then the synthetic popstate the app's listeners expect.
 *
 * A no-op when already scoped here on this daemon's dashboard (no junk history
 * entry); from a session page it still pushes, folding navigation and scoping
 * into one entry. `path` is any group key; it is normalised so the stored scope
 * is canonical regardless of trailing-slash variance in the source.
 */
export const enterProjectScope = (
  controls: DaemonControlsStore,
  daemonId: DaemonId,
  path: string,
  navigation: ScopeNavigation = browserScopeNavigation(),
): boolean => {
  const scope = normalizeProjectPath(path);
  const here = dashboardDaemon(navigation) === daemonId;
  if (here && controls.controls(daemonId).projectScope === scope) return false;
  controls.setControls(daemonId, { projectScope: scope });
  navigation.push(projectScopeState(daemonId, scope), projectScopePath(daemonId, scope));
  navigation.announce();
  return true;
};

/**
 * Leave folder mode. Store cleared FIRST, then the clean-URL clear entry whose
 * stored scope is `null` — which is what makes Forward-after-clear
 * deterministic (it restores null, not the stale earlier scope).
 */
export const exitProjectScope = (
  controls: DaemonControlsStore,
  daemonId: DaemonId,
  navigation: ScopeNavigation = browserScopeNavigation(),
): boolean => {
  const here = dashboardDaemon(navigation) === daemonId;
  if (here && controls.controls(daemonId).projectScope === null) return false;
  controls.setControls(daemonId, { projectScope: null });
  navigation.push(projectScopeState(daemonId, null), projectScopePath(daemonId, null));
  navigation.announce();
  return true;
};

export interface ProjectScopeOptions {
  readonly controls: DaemonControlsStore;
  /** The daemon whose dashboard is mounted; recovery only rewrites its address. */
  readonly daemonId: DaemonId;
  /**
   * `useFleetView`'s verdict that the stored scope names no folder this daemon
   * knows. This hook does not re-decide it — it only catches the URL up with
   * the store write that already happened.
   */
  readonly scopeRecovered?: boolean;
  readonly navigation?: ScopeNavigation;
}

/**
 * Mount the scope machine: boot plus popstate precedence, and the address half
 * of missing-folder recovery. Returns nothing — rendering reads the store.
 */
export const useProjectScope = ({
  controls,
  daemonId,
  scopeRecovered = false,
  navigation = browserScopeNavigation(),
}: ProjectScopeOptions): void => {
  // Boot once, then on every popstate — real back/forward AND the synthetic
  // ones enter/exit announce.
  useEffect(() => {
    applyScopeFromLocation(controls, navigation);
    return navigation.listen(() => applyScopeFromLocation(controls, navigation));
  }, [controls, navigation]);

  // `replaceState`, not `push`: recovering from a folder that no longer exists
  // is bookkeeping, and a reader pressing Back should not land on the address
  // that named it.
  useEffect(() => {
    if (!scopeRecovered) return;
    if (dashboardDaemon(navigation) !== daemonId) return;
    navigation.replace(projectScopeState(daemonId, null), projectScopePath(daemonId, null));
  }, [daemonId, navigation, scopeRecovered]);
};
