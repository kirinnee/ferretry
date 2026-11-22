import { LaunchRoots, NEW_FERRET_PROJECT_SLOT } from '@ferretry/core-ferrets/contract';
import { appAction, definePlugin, panel, route, screen, verb } from '@ferretry/kernel/manifest';
import {
  filesystemConfigure,
  filesystemUse,
  PROJECT_ACCOUNTS_AUDIT,
  PROJECT_FOLDER_CREATED_AUDIT,
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

  // The one taker of `launch.roots`: which folders are known projects decides whether a governed device's start is an
  // ordinary act or terminal access. It grants nothing itself.
  hooks: { takes: [{ hook: LaunchRoots, key: 'projects' }] },

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
      // NEW in r9 (B6): the folder explorer behind the project picker. Names anywhere the skip list allows, never a private
      // folder (`daemon/features/folders/fence.ts`); a person's act, never a ferret's. The home is `filesystem.use`; a place
      // outside it is `filesystem.configure` (passkey step-up for a remote device), asked by the handler.
      route('GET /v1/projects/folders', {
        minimum: 'operator',
        caller: 'person',
        capability: filesystemUse,
        noStore: true,
        audit: { skip: 'a read of folder names; outside the home folder it also needs filesystem.configure' },
        guard: { none: 'folder names, kinds and times only; no file content, no pane, page or vault text' },
      }),
      route('POST /v1/projects/folders', {
        minimum: 'operator',
        caller: 'person',
        capability: filesystemConfigure,
        noStore: true,
        audit: { record: PROJECT_FOLDER_CREATED_AUDIT },
        guard: { none: 'answers the new folder path; no pane, page or vault text' },
      }),
      // NEW in r9 (B5): which git accounts a project uses, and the repositories found inside its folder. A person's act.
      route('PUT /v1/projects/:id/accounts', {
        minimum: 'operator',
        caller: 'person',
        capability: filesystemConfigure,
        noStore: true,
        audit: { record: PROJECT_ACCOUNTS_AUDIT },
        guard: { none: 'answers the project record: account ids and repository names; no pane, page or vault text' },
      }),
      route('GET /v1/projects/:id/repos', {
        minimum: 'operator',
        caller: 'person',
        capability: filesystemUse,
        noStore: true,
        audit: { skip: 'a read of repository folder names and remote addresses inside a registered project' },
        guard: {
          none: 'folder names and remote addresses (never with a password); no file content, no pane, page or vault text',
        },
      }),
    ],
    cli: [
      verb('project add', {
        summary: 'register a folder as a project; a folder already registered prints the one it is',
        args: [{ name: 'path', help: 'the folder, such as `.`' }],
        options: [
          { flag: '--name <name>', help: "the project's name; default: the folder's name" },
          { flag: '--json', help: 'print the project as JSON, with whether it was created' },
        ],
      }),
      verb('project list', {
        summary: 'every registered project: name, id and folder',
        args: [],
        options: [{ flag: '--json', help: 'print the registry as JSON' }],
      }),
      verb('project remove', {
        summary: 'forget a registered project; the folder itself is left alone',
        args: [{ name: 'project', help: 'the project’s name, id or folder' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
    ],
    app: [appAction('project.remove', { on: 'project', label: 'Remove', calls: 'DELETE /v1/projects/:id' })],
  },

  ui: {
    screens: [
      screen('projects', { path: 'projects', nav: { label: 'Projects', icon: 'folder', order: 35 } }),
      screen('project', { path: 'projects/:id' }),
    ],
    // The registered-projects picker Ferrets' New ferret page offers as a slot above its Folder box: Projects contributes,
    // Ferrets imports nothing of it.
    panels: [panel(NEW_FERRET_PROJECT_SLOT, { id: 'new-ferret-projects', order: 10 })],
  },

  data: {
    state: [PROJECTS_STATE],
    readModels: ['projects'],
    publishes: [ProjectRegistered, ProjectRemoved],
  },

  // Registering touches only the folder the owner named, once (`imports` root, §7.7); `git` clones and initialises.
  permissions: { roots: ['imports'], spawn: ['git', 'mkdir', 'rmdir'] },
});
