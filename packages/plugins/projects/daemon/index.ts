import type { FerretId } from '@ferretry/core-ferrets/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ProjectRegistered, ProjectRemoved } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { kernelFolders } from './adapters/folders.ts';
import { kernelStore } from './adapters/store.ts';
import { type FileIndexDeps, filesRoutes } from './features/files/index.ts';
import type { FerretChange } from './features/files/refresh.ts';
import { foldersRoutes } from './features/folders/index.ts';
import { reposRoutes } from './features/repos/index.ts';
import type { ScanDeps } from './features/repos/scan.ts';
import type { ProjectFolders } from './lib/ports.ts';
import { ProjectRegistry } from './lib/registry.ts';
import { listRoute, registerRoute, removeRoute } from './lib/routes.ts';

/**
 * Projects' daemon half: the registry of folders Ferretry knows by name (`state/projects/projects.json`), the three
 * routes over it, and the `ProjectsPort` Board and the project pickers read. It grants nothing: the folder a ferret may
 * open is checked by the core (`WorkFolders`).
 *
 * `folders`, `repoScan` and `fileIndex` are what a test replaces (a map of folders instead of a machine).
 */
export const implementProjects = (folders?: ProjectFolders, repoScan?: ScanDeps, fileIndex?: FileIndexDeps) =>
  implementDaemon(manifest, {
    build: ({ kernel, uses }) => {
      const machine = folders ?? kernelFolders(kernel);
      const registry = new ProjectRegistry({
        store: kernelStore(kernel.state),
        folders: machine,
        clock: kernel.clock,
        newId: () => crypto.randomUUID(),
        registered: id => kernel.events.publish(ProjectRegistered, { id }),
        removed: id => kernel.events.publish(ProjectRemoved, { id }),
        // A repeat registration announces nothing new (idempotent) but the folder was named again: its held index is stale.
        reregistered: id => files.refresh.registered(id),
      });
      const files = filesRoutes(kernel, registry, fileIndex, async ferret => {
        const summary = await uses.ferrets.current()?.get(ferret as FerretId);
        return summary?.folder;
      });
      return {
        routes: {
          'GET /v1/projects': listRoute(registry),
          'POST /v1/projects': registerRoute(registry),
          'DELETE /v1/projects/:id': removeRoute(registry),
          ...foldersRoutes(kernel, machine),
          ...reposRoutes(kernel, registry, repoScan, id => files.refresh.registered(id)),
          ...files.routes,
        },
        // No watcher (D5): a ferret that stops working in a project, a project registered again or removed refreshes its index.
        subscribers: {
          'ferrets.changed': async change => await files.refresh.ferretChanged(change as FerretChange),
          'projects.registered': payload => files.refresh.registered((payload as { id: string }).id),
          'projects.removed': payload => files.refresh.removed((payload as { id: string }).id),
        },
        // The folders a governed device may start a ferret in as an ordinary act (Ferrets reads this, never the registry).
        hooks: { 'launch.roots:projects': { roots: async () => (await registry.list()).map(project => project.path) } },
        provides: {
          projects: {
            list: () => registry.list(),
            find: id => registry.find(id),
            register: request => registry.register(request),
            remove: id => registry.remove(id),
          },
        },
      };
    },
  });

export default implementProjects();
