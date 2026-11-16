/**
 * WHAT A TAP ON AN EXTERNAL LINK DOES — one total, pure decision for every external link the app draws (chat Markdown,
 * a PR chip, a file's Open, a media block's Open, the map's attribution, an agent's html fragment). Ported from today's
 * `features/browser/link-behaviour-model.ts`.
 *
 * Settings › This device › "Open links in" chooses between three homes (`OpenLinksIn`):
 *
 *   browser  outside Ferretry. A desktop or browser tab leaves the click to the browser: the anchor is `target="_blank"`,
 *            so it opens a new tab. The installed app on an iPhone or iPad cannot do that — a `_blank` link there opens an
 *            in-app Safari sheet, not Safari — so the tap navigates to `x-safari-https://…`, which hands the address to
 *            the real Safari app.
 *   panel    Ferretry's in-app preview (`in-app-browser.tsx`).
 *   computer this computer's own default browser, handed over by the daemon on this computer so the operating system
 *            (and any router in front of the browser, such as Finicky) chooses the browser and profile. A daemon that is
 *            not on this computer refuses (`POST /v1/system/open-url` is for a caller on the host), and the link then
 *            opens in a new tab and says why.
 *
 * WHAT NEVER CHANGES, whatever is chosen: a modified click (Cmd, Ctrl, Shift, Alt), a non-primary button, a click another
 * handler already took, and a `download` link are the browser's own — the reader asked for a new tab or a file, and a
 * setting must not take that from them. A long press or a context menu never produces a click at all. Only HTTP(S)
 * leaves the default path: a `blob:` file, a `mailto:` or anything else is the browser's to open.
 */

import type { OpenLinksIn } from '@ferretry/app';
import {
  type BrowserActivation,
  type BrowserDestination,
  browserDestination,
  shouldOpenInApp,
} from '../features/browser/in-app-browser-model.ts';

/** What a click does. */
export type LinkAction =
  /** Leave the click to the browser: the anchor's own `target="_blank"` opens a new tab. */
  | { readonly kind: 'native' }
  /** Open Ferretry's in-app preview at this destination. */
  | { readonly kind: 'panel'; readonly destination: BrowserDestination }
  /** Hand the address to the real Safari app; open `fallback` in a new tab if nothing happened. */
  | { readonly kind: 'safari'; readonly href: string; readonly fallback: string }
  /** Ask the daemon on this computer to open `href`; open it in a new tab if that fails. */
  | { readonly kind: 'computer'; readonly href: string };

export interface LinkDecisionInput {
  readonly setting: OpenLinksIn;
  readonly activation: BrowserActivation;
  readonly href: string | undefined;
  /** What a relative `href` resolves against: the document's base URI. */
  readonly baseHref?: string;
  readonly download?: string | boolean;
  /** The installed app on iOS or iPadOS, where `_blank` cannot reach Safari. */
  readonly iosStandalone: boolean;
}

const NATIVE: LinkAction = Object.freeze({ kind: 'native' });

export const decideLinkAction = (input: LinkDecisionInput): LinkAction => {
  const destination = browserDestination(input.href, input.baseHref);
  if (destination === null || !shouldOpenInApp(input.activation, destination, input.download)) return NATIVE;
  if (input.setting === 'panel') return { kind: 'panel', destination };
  if (input.setting === 'computer') return { kind: 'computer', href: destination.href };
  if (!input.iosStandalone) return NATIVE;
  // `x-safari-https://example.com/a`: the scheme iOS hands to Safari. A destination is always HTTP(S).
  return { kind: 'safari', href: `x-safari-${destination.href}`, fallback: destination.href };
};

/** The slice of a browser the iOS check reads; injected so a test never mutates a global. */
export interface StandaloneEnvironment {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  /** iOS's own flag; absent everywhere else. */
  readonly navigatorStandalone?: boolean;
  /** `(display-mode: standalone)` matches. */
  readonly standaloneDisplay: boolean;
}

/**
 * The installed app on an iPhone or iPad. iPadOS announces itself as a Mac, and only its touch screen gives it away;
 * `navigator.standalone` is iOS's own answer, and the display mode covers a WebKit that stops setting it.
 */
export const isIosStandalone = (environment: StandaloneEnvironment): boolean => {
  const { userAgent, maxTouchPoints } = environment;
  const ios = /\b(iPhone|iPad|iPod)\b/u.test(userAgent) || (/\bMacintosh\b/u.test(userAgent) && maxTouchPoints > 1);
  return ios && (environment.navigatorStandalone === true || environment.standaloneDisplay);
};
