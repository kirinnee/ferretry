/**
 * `ferrets.list-scope`, PROVIDED (docs/standards: app hooks, §5.2). Ferrets' list groups its rows by folder and can
 * focus one folder; which folders are registered projects, and the focus itself, are this half's facts (the registry,
 * and the folder-mode machine in `./project-scope.ts`). So this half answers it over its own client on one daemon:
 * `groupOf` names a ferret's folder by the registered project that covers it, `enter` / `exit` move the focus (store
 * first, then one history entry), and `recover` drops a focus whose folder is gone.
 *
 * Nothing runs until a list watches it: the first watch reads the registry and follows boot and popstate (the focus an
 * address or a Back press carries), and the last release stops both.
 */

import type { FerretListScopeSnapshot, FerretsListScope } from '@ferretry/core-ferrets/contract';
import {
  applyScopeFromLocation,
  enterProjectScope,
  exitProjectScope,
  recoverScopeAddress,
  type ScopeControls,
  type ScopeNavigation,
  type ScopeRoutes,
} from './project-scope.ts';
import { coveringProject, normalizeProjectPath } from './folders.ts';
import type { ProjectsStore } from './projects-store.ts';

/** The persisted controls this provider reads: the machine's `ScopeControls` and a way to hear them change. */
export interface ListScopeControls extends ScopeControls {
  readonly subscribe: (listener: () => void) => () => void;
}

export interface ListScopeDependencies {
  readonly daemonId: string;
  readonly store: ProjectsStore;
  readonly controls: ListScopeControls;
  readonly routes: ScopeRoutes;
  readonly navigation: ScopeNavigation;
}

/**
 * Which pathname is a daemon's ferret list, and where it lives (`/d/<daemon>/ferrets`: the Ferrets screen's `ferrets`
 * path under the daemon's home). The shell does not hand a half its route table, so the two facts are written here.
 */
export const ferretListRoutes = (homeHref: (daemon: string) => string): ScopeRoutes => ({
  dashboardDaemon: pathname => {
    const match = /^\/d\/([^/]+)\/ferrets\/?$/u.exec(pathname);
    return match === null ? null : decodeURIComponent(match[1] as string);
  },
  dashboardPath: daemonId => `${homeHref(daemonId)}/ferrets`,
});

export const createListScope = ({
  daemonId,
  store,
  controls,
  routes,
  navigation,
}: ListScopeDependencies): FerretsListScope => {
  const listeners = new Set<() => void>();
  let watching = 0;
  let stop: (() => void) | undefined;
  let held: FerretListScopeSnapshot | undefined;
  let heldProjects: ReturnType<ProjectsStore['projects']> | undefined;

  const read = (): FerretListScopeSnapshot => {
    const scope = controls.projectScope(daemonId);
    const projects = store.projects();
    const known = store.known();
    if (held !== undefined && held.scope === scope && held.known === known && heldProjects === projects) return held;
    heldProjects = projects;
    held = {
      scope,
      known,
      groupOf: folder => {
        const project = coveringProject(folder, projects);
        return project === undefined ? null : { key: normalizeProjectPath(project.path), name: project.name };
      },
    };
    return held;
  };
  const announce = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch: () => {
      watching += 1;
      if (watching === 1) {
        void store.hydrate().catch(() => undefined);
        applyScopeFromLocation(controls, routes, navigation);
        const stops = [
          navigation.listen(() => applyScopeFromLocation(controls, routes, navigation)),
          controls.subscribe(announce),
          store.subscribe(announce),
        ];
        stop = () => {
          for (const release of stops) release();
        };
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        watching -= 1;
        if (watching === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
    snapshot: read,
    enter: key => void enterProjectScope(controls, routes, daemonId, key, navigation),
    exit: () => void exitProjectScope(controls, routes, daemonId, navigation),
    recover: () => {
      controls.setProjectScope(daemonId, null);
      recoverScopeAddress(routes, daemonId, navigation);
    },
  };
};
