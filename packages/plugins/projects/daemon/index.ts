import { implementDaemon } from '@ferretry/kernel/manifest';
import { ProjectRegistered, ProjectRemoved } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { kernelFolders } from './adapters/folders.ts';
import { kernelStore } from './adapters/store.ts';
import type { ProjectFolders } from './lib/ports.ts';
import { ProjectRegistry } from './lib/registry.ts';
import { listRoute, registerRoute, removeRoute } from './lib/routes.ts';

/**
 * Projects' daemon half: the registry of folders Ferretry knows by name (`state/projects/projects.json`), the three
 * routes over it, and the `ProjectsPort` Board and the project pickers read. It grants nothing: the folder a ferret may
 * open is checked by the core (`WorkFolders`).
 *
 * `folders` is the one thing a test replaces (a map of folders instead of a machine).
 */
export const implementProjects = (folders?: ProjectFolders) =>
  implementDaemon(manifest, {
    build: ({ kernel }) => {
      const registry = new ProjectRegistry({
        store: kernelStore(kernel.state),
        folders: folders ?? kernelFolders(kernel),
        clock: kernel.clock,
        newId: () => crypto.randomUUID(),
        registered: id => kernel.events.publish(ProjectRegistered, { id }),
        removed: id => kernel.events.publish(ProjectRemoved, { id }),
      });
      return {
        routes: {
          'GET /v1/projects': listRoute(registry),
          'POST /v1/projects': registerRoute(registry),
          'DELETE /v1/projects/:id': removeRoute(registry),
        },
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
