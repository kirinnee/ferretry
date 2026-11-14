import type { ScreenRef } from '../layout/engine.ts';

/**
 * THE SHELL'S ROUTES, pure. The shell owns only the frame's own pages; every other route is a plugin's screen, from
 * its manifest's `ScreenDecl.path`:
 *
 * - a RELATIVE path (`board/:card`) is a per-daemon screen, served at `/d/<daemon>/board/<card>` (a trailing `:card?`
 *   makes that segment optional: `board/:project?` is served at both `/d/<daemon>/board` and `.../board/<project>`). A daemon enters a
 *   route only through its durable paired id, never through an address or an ambient "selected daemon";
 * - an ABSOLUTE path (`/join`) is a daemon-less screen (a share link's landing page, first-run setup).
 *
 * The shell's own: `/` (home: the daemon list), `/settings` (this device's settings, §5.2), `/d/<daemon>` (that
 * daemon's first nav screen), `/d/<daemon>/settings[/<plugin>[/<tab>]]` (a plugin's settings tabs, per daemon; a
 * plugin that declares several names each by its tab id, and `settings/<plugin>` is its first).
 */

export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'device-settings' }
  | { readonly kind: 'daemon-home'; readonly daemon: string }
  | { readonly kind: 'daemon-settings'; readonly daemon: string; readonly tab?: string; readonly tabId?: string }
  | {
      readonly kind: 'screen';
      readonly daemon?: string;
      readonly screen: ScreenRef;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'not-found'; readonly path: string };

interface Compiled {
  readonly screen: ScreenRef;
  readonly absolute: boolean;
  readonly parts: readonly string[];
  /** Literal segments count more than parameters: `board/new` wins over `board/:card`. */
  readonly score: number;
}

const segments = (path: string): string[] => path.split('/').filter(part => part.length > 0);

/** The segments the router reads an address by: the empty ones dropped, and the installed app's prefix with them. */
function routeSegments(pathname: string): string[] {
  const parts = segments(pathname);
  // The installed app's document is served at `/app/` (`public/_redirects`, a `200` rewrite to the directory `/app/` — the one target Pages serves without a redirect); that prefix is the app's home.
  if (parts[0] === 'app') parts.shift();
  return parts;
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** A parameter segment: `:name`, or `:name?` when the address may stop before it (only ever trailing). */
const isParam = (part: string): boolean => part.startsWith(':');
const isOptional = (part: string): boolean => isParam(part) && part.endsWith('?');
const paramName = (part: string): string => part.slice(1, isOptional(part) ? -1 : undefined);

function matchParts(pattern: readonly string[], actual: readonly string[]): Record<string, string> | undefined {
  if (actual.length > pattern.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const want = pattern[i] as string;
    if (i >= actual.length) {
      if (isOptional(want)) continue;
      return undefined;
    }
    const got = decode(actual[i] as string);
    if (got === undefined) return undefined;
    if (isParam(want)) params[paramName(want)] = got;
    else if (want !== got) return undefined;
  }
  return params;
}

/** Shell segments a plugin screen may not take (they would shadow the shell's own pages). */
const RESERVED_ROOTS = new Set(['app', 'd', 'settings', 'assets', 'icons']);
const RESERVED_DAEMON_ROOTS = new Set(['settings']);

export interface RouteTable {
  parse(pathname: string): Route;
  /** The URL of a screen, for a link. */
  href(screen: ScreenRef, params: Readonly<Record<string, string>>, daemon?: string): string;
}

export function routeTable(screens: Iterable<ScreenRef>): RouteTable {
  const compiled: Compiled[] = [];
  const seen = new Set<ScreenRef>();
  for (const screen of screens) {
    if (seen.has(screen)) continue;
    seen.add(screen);
    const absolute = screen.path.startsWith('/');
    const parts = segments(screen.path);
    const root = parts[0];
    if (root !== undefined && (absolute ? RESERVED_ROOTS : RESERVED_DAEMON_ROOTS).has(root)) continue;
    if (!absolute && parts.length === 0) continue;
    compiled.push({ screen, absolute, parts, score: parts.filter(p => !isParam(p)).length });
  }
  compiled.sort((a, b) => b.score - a.score || b.parts.length - a.parts.length);

  const find = (absolute: boolean, actual: readonly string[]) => {
    for (const entry of compiled) {
      if (entry.absolute !== absolute) continue;
      const params = matchParts(entry.parts, actual);
      if (params !== undefined) return { screen: entry.screen, params };
    }
    return undefined;
  };

  return {
    parse(pathname) {
      const parts = routeSegments(pathname);
      if (parts.length === 0) return { kind: 'home' };
      if (parts.length === 1 && parts[0] === 'settings') return { kind: 'device-settings' };
      if (parts[0] === 'd') {
        const daemon = parts[1] === undefined ? undefined : decode(parts[1]);
        if (daemon === undefined || daemon.length === 0) return { kind: 'not-found', path: pathname };
        const rest = parts.slice(2);
        if (rest.length === 0) return { kind: 'daemon-home', daemon };
        if (rest[0] === 'settings' && rest.length <= 3) {
          const tab = rest[1] === undefined ? undefined : decode(rest[1]);
          const tabId = rest[2] === undefined ? undefined : decode(rest[2]);
          if ((rest[1] !== undefined && tab === undefined) || (rest[2] !== undefined && tabId === undefined))
            return { kind: 'not-found', path: pathname };
          return {
            kind: 'daemon-settings',
            daemon,
            ...(tab === undefined ? {} : { tab }),
            ...(tabId === undefined ? {} : { tabId }),
          };
        }
        const found = find(false, rest);
        return found === undefined ? { kind: 'not-found', path: pathname } : { kind: 'screen', daemon, ...found };
      }
      const found = find(true, parts);
      return found === undefined ? { kind: 'not-found', path: pathname } : { kind: 'screen', ...found };
    },
    href(screen, params, daemon) {
      const filled = segments(screen.path).flatMap(part => {
        if (!isParam(part)) return [part];
        const value = params[paramName(part)];
        if (value === undefined) {
          if (isOptional(part)) return [];
          throw new TypeError(`screen ${screen.plugin}.${screen.id} needs "${paramName(part)}"`);
        }
        return [encodeURIComponent(value)];
      });
      if (screen.path.startsWith('/')) return `/${filled.join('/')}`;
      if (daemon === undefined) throw new TypeError(`screen ${screen.plugin}.${screen.id} is per daemon`);
      return `/d/${encodeURIComponent(daemon)}/${filled.join('/')}`;
    },
  };
}

/**
 * WHERE AN ADDRESS STANDS TO ONE DAEMON-LESS SCREEN, read by the router's own parse, so a plugin that must act on its
 * screen's address before anything is drawn (a share link's code leaves the address bar before any chunk loads) can
 * never disagree with the router about which addresses are that screen's:
 * - `at`: the router draws `screen` here. `/join`, `/join/`, `/app/join`, `/app/join/` and `/j%6Fin` are all `/join`;
 * - `beneath`: the screen's own address with more segments after it (`/join/x`), which the router draws as not-found;
 * - `elsewhere`: any other address. A per-daemon screen is always elsewhere here: its address names a daemon.
 */
export type AddressPlace = 'at' | 'beneath' | 'elsewhere';

export function addressPlace(screen: ScreenRef, pathname: string): AddressPlace {
  if (!screen.path.startsWith('/')) return 'elsewhere';
  const drawn = routeTable([screen]).parse(pathname);
  if (drawn.kind === 'screen' && drawn.screen === screen) return 'at';
  const pattern = segments(screen.path);
  const parts = routeSegments(pathname);
  const root = pattern[0];
  if (root === undefined || RESERVED_ROOTS.has(root) || parts.length <= pattern.length) return 'elsewhere';
  return matchParts(pattern, parts.slice(0, pattern.length)) === undefined ? 'elsewhere' : 'beneath';
}

export const daemonHomeHref = (daemon: string): string => `/d/${encodeURIComponent(daemon)}`;
/** A settings tab's address: `settings/<plugin>` is that plugin's first tab, `settings/<plugin>/<tab>` names one. */
export const daemonSettingsHref = (daemon: string, plugin?: string, tab?: string): string =>
  `/d/${encodeURIComponent(daemon)}/settings${plugin === undefined ? '' : `/${encodeURIComponent(plugin)}${tab === undefined ? '' : `/${encodeURIComponent(tab)}`}`}`;
export const DEVICE_SETTINGS_HREF = '/settings';
/** Access's pairing page, told which machine refused this browser (a machine id is not a secret; no code rides it). */
export const pairAgainHref = (daemon: string): string => `/pair?refused=${encodeURIComponent(daemon)}`;
/** The app's home (the daemon list). `/` is the public landing page; the app lives under `/app/`. */
export const HOME_HREF = '/app/';
