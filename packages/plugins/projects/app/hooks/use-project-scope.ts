/**
 * Mounts the folder-mode scope machine (`../lib/project-scope.ts`): boot plus popstate precedence, and the address half
 * of missing-folder recovery. Returns nothing — rendering reads the store.
 */
import { useEffect } from 'react';
import {
  applyScopeFromLocation,
  browserScopeNavigation,
  recoverScopeAddress,
  type ScopeControls,
  type ScopeNavigation,
  type ScopeRoutes,
} from '../lib/project-scope.ts';

export interface ProjectScopeOptions {
  readonly controls: ScopeControls;
  readonly routes: ScopeRoutes;
  /** The daemon whose ferret list is mounted; recovery only rewrites its address. */
  readonly daemonId: string;
  /**
   * The ferret list's verdict that the stored scope names no folder this daemon knows. This hook does not re-decide it
   * — it only catches the URL up with the store write that already happened.
   */
  readonly scopeRecovered?: boolean;
  readonly navigation?: ScopeNavigation;
}

export const useProjectScope = ({
  controls,
  routes,
  daemonId,
  scopeRecovered = false,
  navigation = browserScopeNavigation(),
}: ProjectScopeOptions): void => {
  // Boot once, then on every popstate — real back/forward AND the synthetic ones enter/exit announce.
  useEffect(() => {
    applyScopeFromLocation(controls, routes, navigation);
    return navigation.listen(() => applyScopeFromLocation(controls, routes, navigation));
  }, [controls, routes, navigation]);

  useEffect(() => {
    if (!scopeRecovered) return;
    recoverScopeAddress(routes, daemonId, navigation);
  }, [daemonId, navigation, routes, scopeRecovered]);
};
