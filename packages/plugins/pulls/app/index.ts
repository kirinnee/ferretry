import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import type { PullsClient } from './lib/client.ts';
import { lazyComponent } from './lazy.ts';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable, which is also why the
 * type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadScreens = (): Promise<Record<string, unknown>> => import(`./features/pr-page/${'screen'}.tsx`);

type ScreenFactory = (client: PullsClient) => AppComponent<ScreenProps>;

const screen = (factory: 'createPullScreen', client: PullsClient) =>
  lazyComponent<ScreenProps>(async () => ((await loadScreens())[factory] as ScreenFactory)(client));

/** PRs & CI (app half): E4 draws the `pull` screen (one PR's page). E3 adds the list beside it. */
export default implementApp(manifest, {
  build: ({ client }) => ({
    screens: {
      pull: screen('createPullScreen', client),
    },
  }),
});
