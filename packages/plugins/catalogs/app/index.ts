import { type DaemonlessPorts, type DaemonlessScreenProps, type DaemonlessViews, provideToShell } from '@ferretry/app';
import type { AppComponent, PanelProps, PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

/**
 * The views module (React), loaded on first use. The specifier is a Vite dynamic-import path, which keeps this module
 * free of React so the registry generator can load it before the app shell is in place.
 */
const loadViews = (): Promise<Record<string, unknown>> => import('./views/catalogs-views.tsx');

const loadAddSkills = (): Promise<Record<string, unknown>> => import('./views/add-skills-views.tsx');

const addSkillsScreen = (client: PluginClient): AppComponent<ScreenProps> =>
  lazyComponent<ScreenProps>(async () =>
    ((await loadAddSkills()).createAddSkillsScreen as (client: PluginClient) => AppComponent<ScreenProps>)(client),
  );

const addSkillsPanel = (client: PluginClient): AppComponent<PanelProps> =>
  lazyComponent<PanelProps>(async () =>
    ((await loadAddSkills()).createAddSkillsPanel as (client: PluginClient) => AppComponent<PanelProps>)(client),
  );

const sharingScreen = (client: PluginClient): AppComponent<ScreenProps> =>
  lazyComponent<ScreenProps>(async () =>
    ((await loadViews()).createSharingScreen as (client: PluginClient) => AppComponent<ScreenProps>)(client),
  );

/**
 * A daemon-less screen: built with nothing but the shell's daemon-less props, so it cannot be given a client. The shell's
 * `View` returns React nodes and this module holds no React, so the lazy component is handed over as one.
 */
const daemonlessScreen = (
  build: (views: Record<string, unknown>) => AppComponent<DaemonlessScreenProps>,
): DaemonlessViews[string] =>
  lazyComponent<DaemonlessScreenProps>(async () => build(await loadViews())) as DaemonlessViews[string];

/** The views module's screen factories, as this module calls them. */
type DaemonlessFactory = () => AppComponent<DaemonlessScreenProps>;

/** `/shared` reads the paired list (and nothing else of the ports) to know whether there is a machine to install on. */
type SharedFactory = (ports: DaemonlessPorts) => AppComponent<DaemonlessScreenProps>;

/** The per-machine slot of a daemon-less screen: never drawn (its route is under no `/d/<machine>/`), so it draws nothing. */
const daemonlessPlaceholder = (): null => null;

/**
 * Catalogs' app half (§2.3): the `sharing` page (Subscriptions, My catalogs, People), and — beside it — the daemon-less
 * `join` page a share link lands on and `shared`, what is shared with this browser. The two daemon-less screens are
 * mounted by the shell from `shell.daemonless`, with no daemon and no client: a recipient's browser usually holds no
 * pairing, so the shell never builds this half for them. Every call to a daemon rides the half's own client by the route
 * keys Catalogs' manifest declares; a publisher this browser is not paired with is reached only through the shell's
 * member transport (`@ferretry/app` `MemberCarriers`), and fails closed while the shell offers none.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      screens: {
        sharing: sharingScreen(client),
        'add-skills': addSkillsScreen(client),
        // `join` and `shared` are daemon-less: the shell draws them from `shell.daemonless`, never from a machine's half.
        join: daemonlessPlaceholder,
        shared: daemonlessPlaceholder,
      },
      panels: { 'add-skills': addSkillsPanel(client) },
      settings: {},
      renderers: {},
    }),
  }),
  {
    // A share link's whole fragment on `/join` is the shell's to take (shell contract S3): it leaves the address bar
    // and the history entry before the first render and before the views chunk is asked for, and is held in memory
    // until the join screen takes it. Beneath `/join` it is stripped and dropped.
    fragments: [{ form: 'path', screen: 'join' }],
    daemonless: ports => ({
      join: daemonlessScreen(views => (views.createJoinScreen as DaemonlessFactory)()),
      shared: daemonlessScreen(views => (views.createSharedScreen as SharedFactory)(ports)),
    }),
  },
);
