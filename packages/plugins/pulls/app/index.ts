import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import { provideToShell } from '@ferretry/app';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import type { CiClient } from './features/ci-run/ci-api.ts';
import type { ListClient } from './features/list/api.ts';
import type { PullsClient } from './lib/client.ts';
import { pullsCommands } from './command-bar.ts';
import { lazyComponent } from './lazy.ts';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable, which is also why the
 * type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadScreens = (): Promise<Record<string, unknown>> => import(`./features/pr-page/${'screen'}.tsx`);
const loadCiRun = (): Promise<Record<string, unknown>> => import(`./features/ci-run/${'screen'}.tsx`);
const loadList = (): Promise<Record<string, unknown>> => import(`./features/list/${'screen'}.tsx`);

type ScreenFactory = (client: PullsClient) => AppComponent<ScreenProps>;

const screen = (factory: 'createPullScreen', client: PullsClient) =>
  lazyComponent<ScreenProps>(async () => ((await loadScreens())[factory] as ScreenFactory)(client));

const ciRunScreen = (client: CiClient) =>
  lazyComponent<ScreenProps>(async () =>
    ((await loadCiRun()).createCiRunScreen as (client: CiClient) => AppComponent<ScreenProps>)(client),
  );

const listScreen = (client: ListClient) =>
  lazyComponent<ScreenProps>(async () =>
    ((await loadList()).createPullsScreen as (client: ListClient) => AppComponent<ScreenProps>)(client),
  );

/** Projects' hook (`PROJECTS_INSIGHTS_HOOK`), given by name: the name and the shape are the whole agreement. */
const INSIGHTS_HOOK = 'projects.insights';

interface SectionProps {
  readonly project: string;
  readonly daemon: string;
}

/** The section Projects draws on a project's page: this project's PRs, over this machine's client. */
const projectSection = (client: ListClient) => {
  const Section = lazyComponent<SectionProps>(async () => {
    const { ProjectPullsInShell } = (await loadList()) as {
      ProjectPullsInShell: AppComponent<SectionProps & { client: ListClient }>;
    };
    return props => createElement(ProjectPullsInShell as never, { ...props, client });
  });
  return { title: 'PRs & CI', panel: (props: SectionProps) => createElement(Section as never, props) };
};

/**
 * PRs & CI (app half): the `pulls` screen (E3: every project's open PRs and its watch switch), the `pull` screen (E4:
 * one PR's page), the `ci-run` screen (E9), and the PRs section on a project's own page (E3, through Projects' hook).
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      screens: {
        pulls: listScreen(client),
        pull: screen('createPullScreen', client),
        'ci-run': ciRunScreen(client),
      },
    }),
  }),
  { commands: pullsCommands, hooks: { [INSIGHTS_HOOK]: ({ client }) => projectSection(client) } },
);
