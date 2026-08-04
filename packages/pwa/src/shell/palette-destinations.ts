/**
 * Every destination, searchable — the catalog behind the command palette's
 * "Go to" group. Ported from kteam `ui/src/lib/palette-destinations.ts`.
 *
 * The top bar and this module must never disagree about where you can go, so the
 * bar's own `APP_BAR_DESTINATIONS` is the INPUT here rather than a second list
 * copied next to it. This module stays free of any component import, which is
 * what keeps it testable without a DOM.
 *
 * Three rules this file exists to keep:
 *
 *   ONE DAEMON'S    kteam offered bare `/`, `/new`, `/settings`, `/warden`,
 *   DESTINATIONS    `/analytics` and `/learning` because there was exactly one
 *                   daemon. Here every href is built from the daemon whose page
 *                   the palette is on, so a palette opened on one daemon cannot
 *                   navigate into another daemon's surfaces. That is why the
 *                   entries are a function of `DaemonId` rather than constants:
 *                   a module-level href would be a cross-daemon leak waiting to
 *                   happen.
 *   ROUTE GUARD     A row is only offered when `parseRoute` actually resolves
 *                   its path back to itself. A palette that lists a destination
 *                   the router would silently turn into something else is a
 *                   palette that lies; `destinationExists` is the check, and it
 *                   runs over every entry rather than being trusted per author.
 *   NO DOUBLES      Another group may already own a row that navigates
 *                   somewhere. Whatever it is already offering is passed in as
 *                   `taken` and suppressed here, so a search for "settings"
 *                   yields one row and not two that go to the same place.
 */

import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonNewSessionPath, daemonSessionsPath, parseRoute, routePath } from '../lib/pages/routes.ts';

/**
 * The shape the palette needs from a top-bar destination. Structural on purpose:
 * `APP_BAR_DESTINATIONS` (which also carries an icon component) satisfies it
 * without this module knowing anything about React.
 */
export interface AppBarDestinationLike {
  readonly id: string;
  readonly label: string;
  /**
   * The bar's own tooltip copy, reused verbatim as the palette description so
   * the two surfaces cannot describe the same page differently.
   */
  readonly title: string;
  /** The destination's path for one daemon — never a bare constant. */
  readonly path: (daemon: DaemonId) => string;
}

export interface DestinationPaletteEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly href: string;
}

/**
 * Routes the shell owns that the top bar deliberately does not carry: the
 * sessions dashboard is what the breadcrumb goes back to, and "New session"
 * lives at the foot of the fleet sidebar — which a phone reader has to open a
 * drawer to reach. Both are real routes, and both are things people type into a
 * palette first.
 */
export const SHELL_DESTINATIONS = [
  {
    id: 'sessions',
    label: 'Sessions',
    title: 'The fleet dashboard — every session, grouped by project',
    path: daemonSessionsPath,
  },
  {
    id: 'new-session',
    label: 'New session',
    title: 'Start a teammate in a working directory',
    path: daemonNewSessionPath,
  },
] as const satisfies readonly AppBarDestinationLike[];

/**
 * Search terms that are NOT in the label or the description — the words a reader
 * reaches for when they do not remember what the page is called ("spend" for
 * analytics, "spawn" for a new session). Missing ids simply match on their own
 * text, so a new top-bar destination is searchable the moment it is added, with
 * or without an entry here.
 */
const DESTINATION_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  sessions: ['sessions', 'fleet', 'dashboard', 'home', 'teammates', 'list'],
  'new-session': ['new', 'start', 'spawn', 'launch', 'create', 'teammate', 'agent'],
  projects: ['projects', 'project', 'workspace', 'folder', 'repository', 'repo'],
  analytics: ['analytics', 'usage', 'cost', 'spend', 'tokens', 'graph', 'chart', 'query', 'daily'],
  warden: ['warden', 'supervision', 'verdicts', 'accounts', 'failover', 'quota'],
  learning: ['learning', 'proposals', 'rules', 'lessons', 'scan'],
  settings: ['settings', 'preferences', 'appearance', 'theme', 'density', 'options', 'configure'],
};

/**
 * Does the router resolve this href to the page it advertises? A compatibility
 * redirect and anything unknown answer no — the router turns both into the
 * dashboard, and offering them would render a redirect as a destination. A hash
 * or a query is the page's own business and is ignored here.
 */
export const destinationExists = (href: string): boolean => {
  const pathname = (href.split('#')[0] ?? '').split('?')[0] ?? '';
  if (!pathname.startsWith('/')) return false;
  const route = parseRoute(pathname);
  if (route.kind === 'legacy-tasks-redirect') return false;
  return routePath(route) === pathname;
};

/**
 * The dashboard first (it is where Back goes), then the bar's own order, then
 * the new-session action.
 */
const ordered = (destinations: readonly AppBarDestinationLike[]): AppBarDestinationLike[] => {
  const [sessions, newSession] = SHELL_DESTINATIONS;
  return [sessions, ...destinations, newSession];
};

/**
 * The destinations of ONE daemon that match `query`, in navigation order. An
 * empty query returns all of them: on a phone the palette is the navigation
 * surface, so opening it cold has to show where you can go rather than an empty
 * frame that only answers typing.
 *
 * `taken` is the set of hrefs another palette group is already offering.
 */
export const destinationPaletteEntries = (
  query: string,
  destinations: readonly AppBarDestinationLike[],
  daemon: DaemonId,
  options: { readonly taken?: readonly string[] } = {},
): DestinationPaletteEntry[] => {
  const needle = query.trim().toLocaleLowerCase();
  const taken = new Set(options.taken ?? []);
  const entries: DestinationPaletteEntry[] = [];
  for (const destination of ordered(destinations)) {
    const href = destination.path(daemon);
    if (!destinationExists(href)) continue;
    if (taken.has(href)) continue;
    const keywords = DESTINATION_KEYWORDS[destination.id] ?? [];
    const haystack = [destination.label, destination.title, ...keywords].join(' ').toLocaleLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    entries.push({
      id: `destination-${destination.id}`,
      label: destination.label,
      description: destination.title,
      href,
    });
  }
  return entries;
};
