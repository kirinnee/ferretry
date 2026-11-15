import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { projectsCommands } from './command-bar.ts';
import type { ProjectsClient } from './lib/client.ts';
import { lazyComponent } from './lazy.ts';
import { workProjectNamesList } from './lib/work-project-names.ts';

/** Conversation's hook (`CONVERSATION_WORK_PROJECT_NAMES_HOOK`), given by name: the name and the shape are the whole agreement. */
const WORK_PROJECT_NAMES_HOOK = 'conversation.work-project-names';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable, which is also why the
 * type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadScreens = (): Promise<Record<string, unknown>> => import(`./views/${'screens'}.tsx`);

type ScreenFactory = (client: ProjectsClient) => AppComponent<ScreenProps>;

const screen = (factory: 'createProjectsScreen' | 'createProjectScreen', client: ProjectsClient) =>
  lazyComponent<ScreenProps>(async () => ((await loadScreens())[factory] as ScreenFactory)(client));

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
    }),
  }),
  {
    commands: projectsCommands,
    // Conversation's work search names a card's project: the one list of project names, read once per daemon.
    hooks: { [WORK_PROJECT_NAMES_HOOK]: ({ client }) => workProjectNamesList(client) },
  },
);
