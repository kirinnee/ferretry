import {
  addressPlace,
  type DaemonlessScreenProps,
  type DaemonlessViews,
  provideToShell,
  type ScreenRef,
} from '@ferretry/app';
import type { AppComponent, PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { type ArrivalHold, armArrivalHold } from './lib/arrival.ts';
import { JOIN_PATH } from './lib/routes.ts';
import { lazyComponent } from './lazy.ts';

/**
 * The views module (React), loaded on first use. The specifier is a Vite dynamic-import path, which keeps this module
 * free of React so the registry generator can load it before the app shell is in place.
 */
const loadViews = (): Promise<Record<string, unknown>> => import('./views/catalogs-views.tsx');

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
type JoinFactory = (hold: ArrivalHold) => AppComponent<DaemonlessScreenProps>;
type SharedFactory = () => AppComponent<DaemonlessScreenProps>;

/**
 * The join screen as the shell's router knows it, so the hold strips at exactly the addresses the router draws it at.
 * `JOIN_PATH` is the path the manifest declares for it (pinned by `half.test.ts`).
 */
const JOIN_SCREEN: ScreenRef = { plugin: manifest.id, id: 'join', path: JOIN_PATH, label: 'Join' };

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
        // `join` and `shared` are daemon-less: the shell draws them from `shell.daemonless`, never from a machine's half.
        join: daemonlessPlaceholder,
        shared: daemonlessPlaceholder,
      },
      panels: {},
      settings: {},
      renderers: {},
    }),
  }),
  {
    // The factory runs before the first render and before any chunk loads: a share link's code leaves the address bar and
    // the history entry HERE, so it does not wait for the views chunk, which may be slow or never arrive.
    daemonless: () => {
      const hold = armArrivalHold(globalThis, pathname => addressPlace(JOIN_SCREEN, pathname));
      return {
        join: daemonlessScreen(views => (views.createJoinScreen as JoinFactory)(hold)),
        shared: daemonlessScreen(views => (views.createSharedScreen as SharedFactory)()),
      };
    },
  },
);
