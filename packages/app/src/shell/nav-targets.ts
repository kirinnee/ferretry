import { daemonHomeHref, DEVICE_SETTINGS_HREF, HOME_HREF, needsSubject, type Route } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import type { NavEntry } from '../layout/engine.ts';
import { useShell } from './context.tsx';
import { navIconName } from './icons.tsx';

/**
 * WHERE EACH NAV ENTRY GOES, once: the nav bar draws these as tabs and the chat's one menu lists the same places, so a
 * destination never reads two ways. An entry with no address is one the person cannot open from here (a screen that needs
 * a subject, or one that belongs to a machine when none is on screen).
 */

export interface NavTarget {
  readonly key: string;
  readonly label: string;
  /** Where it goes, or `undefined` when it cannot be opened from here. */
  readonly to: string | undefined;
  /** Whether it is the place on screen. */
  readonly current: boolean;
  /** Its icon name (`icons.tsx`), when it declares one. */
  readonly icon: string | undefined;
  readonly entry: NavEntry;
}

/** A ferret's chat (`ferrets/:ferret/chat`) is a page of the Ferrets place even though Conversation draws it: both start at `ferrets`. */
const sameSection = (path: string, entryPath: string): boolean => {
  const first = path.split('/')[0];
  return first !== undefined && first !== '' && first === entryPath.split('/')[0];
};

export const routeDaemon = (route: Route): string | undefined =>
  'daemon' in route && typeof route.daemon === 'string' ? route.daemon : undefined;

/** The route is a ferret's own page: the chat. */
export const isChatRoute = (route: Route): boolean => route.kind === 'screen' && route.params.ferret !== undefined;

export function useNavTargets(daemon: string | undefined): readonly NavTarget[] {
  const { plan, routes, offeredOn } = useShell();
  const { route } = useRouter();
  const href = (entry: NavEntry): string | undefined => {
    if (entry.kind === 'shell') {
      if (entry.item === 'settings')
        return daemon === undefined ? DEVICE_SETTINGS_HREF : `${daemonHomeHref(daemon)}/settings`;
      return HOME_HREF;
    }
    const { screen } = entry;
    if (needsSubject(screen.path)) return undefined; // a screen that needs a subject is not a nav destination
    if (screen.path.startsWith('/')) return routes.href(screen, {});
    return daemon === undefined ? undefined : routes.href(screen, {}, daemon);
  };
  // The entry whose page is on screen: a plugin's entry for any screen of that plugin (the ferret page is Ferrets'), Settings for either settings page, Daemons for Home and a machine's home.
  const onScreen = (entry: NavEntry): boolean =>
    entry.kind === 'screen'
      ? route.kind === 'screen' &&
        (route.screen.plugin === entry.screen.plugin || sameSection(route.screen.path, entry.screen.path))
      : entry.item === 'settings'
        ? route.kind === 'device-settings' || route.kind === 'daemon-settings'
        : route.kind === 'home' || route.kind === 'daemon-home';
  // A machine's own places leave out what THAT machine has turned off (the plan lists what any paired machine has on); a device-wide place (a `/` path) is not any one machine's.
  const offered = (entry: NavEntry): boolean =>
    entry.kind !== 'screen' || entry.screen.path.startsWith('/') || offeredOn(daemon, entry.screen.plugin);
  return plan.nav.entries.filter(offered).map(entry => ({
    key: entry.kind === 'screen' ? `${entry.screen.plugin}.${entry.screen.id}` : entry.item,
    label: entry.kind === 'screen' ? entry.screen.label : entry.item === 'settings' ? 'Settings' : 'Daemons',
    to: href(entry),
    current: onScreen(entry),
    entry,
    icon: navIconName(entry),
  }));
}
