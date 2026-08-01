/**
 * ONE BROWSER SURFACE, TWO EXPLICIT ENGINES — the decisions, without the
 * render. Ported from `ui/src/components/UnifiedBrowserSurface.tsx`.
 *
 * `preview` is the process-free iframe reader; `remote` is the session's
 * persistent Chrome on the daemon. The address bar is deliberately
 * engine-agnostic: it operates on whichever history the reader selected, and
 * switching engines never discards the other one's position.
 *
 * Preview history can only ever cover app-driven opens — cross-origin
 * iframe-internal navigation is opaque to its parent — which is why the
 * surface states that limitation rather than pretending to a full history.
 *
 * MULTI-DAEMON. The original remembered the chosen engine in a module map
 * keyed by `sessionId`. Two paired daemons can each own a session with that
 * id, and the remote engine is a Chrome process on ONE daemon: carrying that
 * choice across a connection switch would point the surface at a browser the
 * other daemon does not have. The memory is keyed by `(daemonId, sessionId)`.
 */

import { daemonSessionKey, type DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { browserDestination, isLoopbackHostname, type BrowserDestination } from './in-app-browser-model.ts';

export type BrowserEngine = 'preview' | 'remote';

interface BrowserSessionMemory {
  readonly engine: BrowserEngine;
}

const browserSessions = new Map<string, BrowserSessionMemory>();

/** Session-scoped even on a phone, where closing the sheet unmounts its body. */
export const browserEngineForSession = (scope: DaemonSessionScope): BrowserEngine =>
  browserSessions.get(daemonSessionKey(scope))?.engine ?? 'preview';

/** The surface's single write path for the remembered engine. */
export const rememberBrowserEngine = (scope: DaemonSessionScope, engine: BrowserEngine): void => {
  browserSessions.set(daemonSessionKey(scope), { engine });
};

export const resetBrowserSurfaceSessions = (): void => {
  browserSessions.clear();
};

export type BrowserAddressResolution =
  | { readonly kind: 'url' | 'search'; readonly destination: BrowserDestination }
  | { readonly kind: 'error'; readonly message: string };

const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const HOST_WITH_PORT = /^(?:localhost|[^\s/:]+\.[^\s/:]+|\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]):\d+(?:[/?#]|$)/i;
/** `https:`, `https:/`, `https://` — a scheme the human has not finished typing. */
const SCHEME_ONLY = /^(https?):\/{0,2}$/i;

const authorityOf = (value: string): string => value.split(/[/?#]/, 1)[0] ?? '';

const hostnameOf = (authority: string): string =>
  authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.replace(/:\d+$/, '');

const looksLikeBareHost = (value: string): boolean => {
  if (/\s/.test(value)) return false;
  const hostname = hostnameOf(authorityOf(value));
  return (
    isLoopbackHostname(hostname) ||
    hostname.includes('.') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    /^\[[0-9a-f:]+\]$/i.test(hostname)
  );
};

/**
 * Address-bar policy: relative paths stay on the current site, bare hosts get
 * a scheme, and everything else becomes an explicit DuckDuckGo search — never
 * a silent one. A loopback host gets `http://`, because a dev server almost
 * never speaks TLS.
 */
export const resolveBrowserAddress = (input: string, baseHref?: string): BrowserAddressResolution => {
  const value = input.trim();
  if (!value) return { kind: 'error', message: 'Enter a URL or search terms.' };

  // A half-typed scheme is an unfinished thought, not a mistake. Say what is
  // missing instead of scolding, and never turn it into a search.
  const schemeOnly = SCHEME_ONLY.exec(value);
  if (schemeOnly) return { kind: 'error', message: `Keep typing—add a site after ${schemeOnly[1]?.toLowerCase()}://` };

  const relative = /^(?:\/|\.\.?\/|[?#])/.test(value);
  const hostWithPort = HOST_WITH_PORT.test(value);
  if (EXPLICIT_SCHEME.test(value) && !hostWithPort && !/^https?:/i.test(value))
    return { kind: 'error', message: 'Only HTTP and HTTPS addresses can be opened.' };

  let candidate: string | undefined;
  if (/^https?:/i.test(value)) candidate = value;
  else if (relative && baseHref) {
    try {
      candidate = new URL(value, baseHref).href;
    } catch {
      return { kind: 'error', message: 'That relative address is not valid.' };
    }
  } else if (hostWithPort || looksLikeBareHost(value)) {
    const rawHostname = hostnameOf(authorityOf(value));
    candidate = `${isLoopbackHostname(rawHostname) ? 'http' : 'https'}://${value}`;
  }

  if (candidate) {
    const destination = browserDestination(candidate, baseHref);
    return destination
      ? { kind: 'url', destination }
      : { kind: 'error', message: 'Enter a complete HTTP or HTTPS address.' };
  }

  const search = new URL('https://duckduckgo.com/');
  search.searchParams.set('q', value);
  const searched = browserDestination(search.href, baseHref);
  // `browserDestination` cannot refuse a URL this function just built, but the
  // surface must not be handed a null it would render as a blank frame.
  return searched
    ? { kind: 'search', destination: searched }
    : { kind: 'error', message: 'Enter a URL or search terms.' };
};

export interface PreviewHistory {
  readonly entries: readonly BrowserDestination[];
  readonly index: number;
  /**
   * Bumped when the SAME address is opened again. The iframe only reloads when
   * something about its React key changes, and re-tapping a link the reader is
   * already on is a reload request, not a no-op.
   */
  readonly revision: number;
}

export const createPreviewHistory = (destination?: BrowserDestination | null): PreviewHistory =>
  destination ? { entries: [destination], index: 0, revision: 0 } : { entries: [], index: -1, revision: 0 };

export const pushPreviewHistory = (history: PreviewHistory, destination: BrowserDestination): PreviewHistory => {
  if (history.entries[history.index]?.href === destination.href) return { ...history, revision: history.revision + 1 };
  return {
    entries: [...history.entries.slice(0, history.index + 1), destination],
    index: history.index + 1,
    revision: 0,
  };
};

export const movePreviewHistory = (history: PreviewHistory, offset: -1 | 1): PreviewHistory => {
  if (history.entries.length === 0) return history;
  const index = Math.max(0, Math.min(history.entries.length - 1, history.index + offset));
  return index === history.index ? history : { ...history, index, revision: 0 };
};

/** The entry the preview engine is currently showing, if it has one. */
export const currentPreviewEntry = (history: PreviewHistory): BrowserDestination | null =>
  history.entries[history.index] ?? null;
