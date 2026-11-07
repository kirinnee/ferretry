import type { ProjectsClient } from '../lib/client.ts';
import { fetchProjects } from '../lib/projects-api.ts';
import { ProjectsStore } from '../lib/projects-store.ts';

const stores = new WeakMap<object, ProjectsStore>();

/**
 * The registry store for one client. The shell hands a half one client per daemon and credential, so keying by the
 * client keeps the hub and the detail screen on one slice and a re-pair (a new client) on a fresh one.
 */
export const projectsStoreFor = (client: ProjectsClient): ProjectsStore => {
  let store = stores.get(client);
  if (store === undefined) {
    store = new ProjectsStore({ projects: () => fetchProjects(client) });
    stores.set(client, store);
  }
  return store;
};
