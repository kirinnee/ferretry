import type { ScreenRef } from '../layout/engine.ts';

/**
 * THE SHELL'S ROUTES, pure. The shell owns only the frame's own pages; every other route is a plugin's screen, from
 * its manifest's `ScreenDecl.path`:
 *
 * - a RELATIVE path (`board/:card`) is a per-daemon screen, served at `/d/<daemon>/board/<card>`. A daemon enters a
 *   route only through its durable paired id, never through an address or an ambient "selected daemon";
 * - an ABSOLUTE path (`/join`) is a daemon-less screen (a share link's landing page, first-run setup).
 *
 * The shell's own: `/` (home: the daemon list), `/settings` (this device's settings, §5.2), `/d/<daemon>` (that
 * daemon's first nav screen), `/d/<daemon>/settings[/<plugin>]` (one tab per plugin, per daemon).
 */

export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'device-settings' }
  | { readonly kind: 'daemon-home'; readonly daemon: string }
  | { readonly kind: 'daemon-settings'; readonly daemon: string; readonly tab?: string }
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

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function matchParts(pattern: readonly string[], actual: readonly string[]): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const want = pattern[i] as string;
    const got = decode(actual[i] as string);
    if (got === undefined) return undefined;
    if (want.startsWith(':')) params[want.slice(1)] = got;
    else if (want !== got) return undefined;
  }
  return params;
}

/** Shell segments a plugin screen may not take (they would shadow the shell's own pages). */
const RESERVED_ROOTS = new Set(['d', 'settings', 'assets', 'icons']);
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
    compiled.push({ screen, absolute, parts, score: parts.filter(p => !p.startsWith(':')).length });
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
      const parts = segments(pathname);
      if (parts.length === 0) return { kind: 'home' };
      if (parts.length === 1 && parts[0] === 'settings') return { kind: 'device-settings' };
      if (parts[0] === 'd') {
        const daemon = parts[1] === undefined ? undefined : decode(parts[1]);
        if (daemon === undefined || daemon.length === 0) return { kind: 'not-found', path: pathname };
        const rest = parts.slice(2);
        if (rest.length === 0) return { kind: 'daemon-home', daemon };
        if (rest[0] === 'settings' && rest.length <= 2) {
          const tab = rest[1] === undefined ? undefined : decode(rest[1]);
          return tab === undefined ? { kind: 'daemon-settings', daemon } : { kind: 'daemon-settings', daemon, tab };
        }
        const found = find(false, rest);
        return found === undefined ? { kind: 'not-found', path: pathname } : { kind: 'screen', daemon, ...found };
      }
      const found = find(true, parts);
      return found === undefined ? { kind: 'not-found', path: pathname } : { kind: 'screen', ...found };
    },
    href(screen, params, daemon) {
      const filled = segments(screen.path).map(part => {
        if (!part.startsWith(':')) return part;
        const value = params[part.slice(1)];
        if (value === undefined) throw new TypeError(`screen ${screen.plugin}.${screen.id} needs "${part.slice(1)}"`);
        return encodeURIComponent(value);
      });
      if (screen.path.startsWith('/')) return `/${filled.join('/')}`;
      if (daemon === undefined) throw new TypeError(`screen ${screen.plugin}.${screen.id} is per daemon`);
      return `/d/${encodeURIComponent(daemon)}/${filled.join('/')}`;
    },
  };
}

export const daemonHomeHref = (daemon: string): string => `/d/${encodeURIComponent(daemon)}`;
export const daemonSettingsHref = (daemon: string, tab?: string): string =>
  `/d/${encodeURIComponent(daemon)}/settings${tab === undefined ? '' : `/${encodeURIComponent(tab)}`}`;
export const DEVICE_SETTINGS_HREF = '/settings';
