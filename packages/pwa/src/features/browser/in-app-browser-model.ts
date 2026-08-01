/**
 * What a link is, before anything decides how to show it. Ported from
 * `ui/src/components/InAppBrowser.tsx`.
 *
 * Two questions, both answered here so the surface never has to guess:
 *
 *  1. Is this href something the in-app reader may open at all? Only HTTP(S) —
 *     the reader never widens past those two schemes.
 *  2. Does it name the machine the agent runs on, or the phone in the reader's
 *     hand? The app is reached through an HTTPS tunnel, so on that phone
 *     `localhost` names the PHONE, not the daemon's host. That case is
 *     identified up front rather than shown as a blank frame that could never
 *     have loaded. A loopback proxy would be a daemon feature with an explicit
 *     port allowlist and admin auth; this client does not invent one.
 */

/** How much of the page a browser destination is trusted with. */
export type BrowserScope = 'same-origin' | 'cross-origin' | 'device-loopback';

export interface BrowserDestination {
  readonly href: string;
  readonly hostname: string;
  readonly scope: BrowserScope;
}

/** Hosts that name the current device rather than the machine behind a tunnel. */
export const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
};

/** Resolves and classifies a link without ever widening beyond HTTP(S). */
export const browserDestination = (href: string | undefined, baseHref?: string): BrowserDestination | null => {
  if (!href?.trim()) return null;
  let target: URL;
  try {
    target = baseHref ? new URL(href, baseHref) : new URL(href);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;

  let base: URL | null = null;
  if (baseHref) {
    try {
      base = new URL(baseHref);
    } catch {
      // An absolute HTTP(S) target is still safe to offer when the caller's
      // optional base is malformed; it simply cannot be same-origin.
    }
  }

  const scope: BrowserScope =
    base?.origin === target.origin
      ? 'same-origin'
      : isLoopbackHostname(target.hostname) && !isLoopbackHostname(base?.hostname ?? '')
        ? 'device-loopback'
        : 'cross-origin';
  return { href: target.href, hostname: target.hostname, scope };
};

/** The parts of a click that decide whether the reader asked for a new tab. */
export interface BrowserActivation {
  readonly defaultPrevented: boolean;
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Modified and non-primary clicks keep ordinary browser/new-tab semantics. */
export const shouldOpenInApp = (
  event: BrowserActivation,
  destination: BrowserDestination | null,
  download: string | boolean | undefined,
): boolean =>
  Boolean(
    destination &&
    download === undefined &&
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey,
  );
