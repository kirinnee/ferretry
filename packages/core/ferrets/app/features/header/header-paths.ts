/**
 * Where the header's links go: the screens it opens, per daemon. The shell does not hand a half its route table, so the
 * address is built from the shell's own exported builder and the path Ferrets' manifest declares for the screen
 * (`ferrets/:ferret/move`, relative, so served at `/d/<daemon>/ferrets/<id>/move`).
 *
 * GAP(app): `screenHref` (the shell's route-table link builder, being added to `@ferretry/app` with the Conversation
 * port) replaces this once it lands.
 */

import { daemonHomeHref } from '@ferretry/app';

/** The move page of one ferret on one daemon; `convert` opens it on "Move to Codex… / Move to Claude…". */
export const movePath = (daemon: string, ferret: string, convert = false): string =>
  `${daemonHomeHref(daemon)}/ferrets/${encodeURIComponent(ferret)}/move${convert ? '?mode=cli' : ''}`;

/** The daemon a route is under, or `undefined` for a route with none (home, device settings, a daemon-less screen). */
export const daemonOfRoute = (
  route:
    | { readonly kind: 'screen'; readonly daemon?: string }
    | { readonly kind: 'daemon-home' | 'daemon-settings'; readonly daemon: string }
    | { readonly kind: 'home' | 'device-settings' | 'not-found' },
): string | undefined => ('daemon' in route ? route.daemon : undefined);
