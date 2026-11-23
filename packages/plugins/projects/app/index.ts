import { FERRETS_LIST_SCOPE_HOOK, type FerretsListScope } from '@ferretry/core-ferrets/contract';
import type { AppComponent, PanelProps, ScreenProps } from '@ferretry/kernel/manifest';
import { daemonHomeHref, daemonOfClient, deviceControls, provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { projectsCommands } from './command-bar.ts';
import type { ProjectsClient } from './lib/client.ts';
import { lazyComponent } from './lazy.ts';
import { createListScope, ferretListRoutes } from './lib/list-scope.ts';
import { browserScopeNavigation } from './lib/project-scope.ts';
import { workProjectNamesList } from './lib/work-project-names.ts';
import { projectsStoreFor } from './views/context.ts';

/** Conversation's hook (`CONVERSATION_WORK_PROJECT_NAMES_HOOK`), given by name: the name and the shape are the whole agreement. */
const WORK_PROJECT_NAMES_HOOK = 'conversation.work-project-names';

const listScopes = new WeakMap<object, FerretsListScope>();

/** One machine's list scope, made once per client over this device's controls and the browser's own history. */
const listScopeOf = (client: ProjectsClient): FerretsListScope => {
  const known = listScopes.get(client);
  if (known !== undefined) return known;
  const controls = deviceControls();
  const made = createListScope({
    daemonId: daemonOfClient(client) ?? 'this-daemon',
    store: projectsStoreFor(client),
    controls: {
      projectScope: id => controls.controls(id).projectScope,
      setProjectScope: (id, scope) => void controls.setControls(id, { projectScope: scope }),
      subscribe: controls.subscribe,
    },
    routes: ferretListRoutes(daemonHomeHref),
    navigation: browserScopeNavigation(),
  });
  listScopes.set(client, made);
  return made;
};

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable, which is also why the
 * type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadScreens = (): Promise<Record<string, unknown>> => import(`./views/${'screens'}.tsx`);

type ScreenFactory = (client: ProjectsClient) => AppComponent<ScreenProps>;

const screen = (factory: 'createProjectsScreen' | 'createProjectScreen', client: ProjectsClient) =>
  lazyComponent<ScreenProps>(async () => ((await loadScreens())[factory] as ScreenFactory)(client));

/** The registered-projects picker for New ferret: its module loads when that page first draws the slot. */
const loadPanels = (): Promise<Record<string, unknown>> => import(`./views/${'new-ferret-projects'}.tsx`);

const newFerretProjectsPanel = (client: ProjectsClient): AppComponent<PanelProps> =>
  lazyComponent<PanelProps>(async () =>
    ((await loadPanels()).createNewFerretProjectsPanel as (client: ProjectsClient) => AppComponent<PanelProps>)(client),
  );

/** The setup flow's last page ("Add your projects"): its module loads when the flow first draws it. */
const foldersStepPanel = (client: ProjectsClient): AppComponent<PanelProps> =>
  lazyComponent<PanelProps>(async () =>
    (
      ((await import(`./views/${'folders-step'}.tsx`)) as Record<string, unknown>).createFoldersStep as (
        client: ProjectsClient,
      ) => AppComponent<PanelProps>
    )(client),
  );

/**
 * Projects' app half: the `projects` screen (the registry, the add form, the discoveries) and the `project` screen (one
 * project's provenance, board switch, ferrets and files). The lane editor draws Board's data and is Board's.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      screens: {
        projects: screen('createProjectsScreen', client),
        project: screen('createProjectScreen', client),
      },
      panels: { 'new-ferret-projects': newFerretProjectsPanel(client), 'onboarding-step': foldersStepPanel(client) },
    }),
  }),
  {
    commands: projectsCommands,
    // Conversation's work search names a card's project: the one list of project names, read once per daemon.
    hooks: {
      [WORK_PROJECT_NAMES_HOOK]: ({ client }) => workProjectNamesList(client),
      // Ferrets' list groups by registered project and can focus one folder (`ferrets.list-scope`): the registry and the
      // folder-mode machine are this half's, so this half answers it, once per client.
      [FERRETS_LIST_SCOPE_HOOK]: ({ client }) => listScopeOf(client),
    },
  },
);
