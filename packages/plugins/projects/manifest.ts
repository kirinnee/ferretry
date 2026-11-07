import { appAction, definePlugin, route, screen, verb } from '@ferretry/kernel/manifest';
import {
  filesystemConfigure,
  PROJECT_REGISTERED_AUDIT,
  PROJECT_REMOVED_AUDIT,
  ProjectRegistered,
  ProjectRemoved,
  ProjectsFileSchema,
  ProjectsPort,
} from './contract/index.ts';
import { defineState } from '@ferretry/kernel/contract';

/** `state/projects/projects.json`: the registry, `format: 1` first (§9.2). Damaged = the subsystem fails closed. */
const PROJECTS_STATE = defineState({
  name: 'projects',
  path: 'projects.json',
  store: 'json',
  format: 1,
  schema: ProjectsFileSchema,
});

/**
 * Projects (§2.3): the repositories Ferretry knows by name. A list of folders, kept by a small code plugin. It grants
 * nothing: which folder a ferret may open is checked by the core (`WorkFolders`).
 */
export default definePlugin({
  id: 'projects',
  title: 'Projects',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
  words: [{ word: 'project', means: 'a repository Ferretry knows by name', insteadOf: ['repo'] }],

  provides: { projects: ProjectsPort },

  actions: {
    routes: [
      // Today's `catalogs` mount (`GET|POST /v1/projects`), descriptors copied. Paths are private daemon state: operator.
      route('GET /v1/projects', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of the project list' },
        guard: { none: 'folder names and paths only; no pane, page or vault text' },
      }),
      route('POST /v1/projects', {
        minimum: 'operator',
        caller: 'any',
        capability: filesystemConfigure,
        noStore: true,
        audit: { record: PROJECT_REGISTERED_AUDIT },
        guard: { none: 'answers the registered record; no pane, page or vault text' },
      }),
      // NEW in 5.0 (`fy project remove`, §2.3): a person's act, never a ferret's.
      route('DELETE /v1/projects/:id', {
        minimum: 'operator',
        caller: 'person',
        capability: filesystemConfigure,
        noStore: true,
        audit: { record: PROJECT_REMOVED_AUDIT },
        guard: { none: 'answers the removed record; no pane, page or vault text' },
      }),
    ],
    cli: [
      verb('project add', {
        summary: 'register a folder as a project; a folder already registered prints the one it is',
      }),
      verb('project list', { summary: 'every registered project: name, id and folder' }),
      verb('project remove', { summary: 'forget a registered project; the folder itself is left alone' }),
    ],
    app: [appAction('project.remove', { on: 'project', label: 'Remove', calls: 'DELETE /v1/projects/:id' })],
  },

  ui: {
    screens: [
      screen('projects', { path: 'projects', nav: { label: 'Projects', icon: 'folder', order: 35 } }),
      screen('project', { path: 'projects/:id' }),
    ],
  },

  data: {
    state: [PROJECTS_STATE],
    readModels: ['projects'],
    publishes: [ProjectRegistered, ProjectRemoved],
  },

  // Registering touches only the folder the owner named, once (`imports` root, §7.7); `git` clones and initialises.
  permissions: { roots: ['imports'], spawn: ['git', 'mkdir'] },
});
