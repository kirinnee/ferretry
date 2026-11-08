/**
 * THE QUIET LINE a page shows for a push the reader's own filter hides (not the worker), copied from today's PWA
 * (`lib/push-scope.ts`). WHERE A TAP MAY GO is not decided here: it is the shell's one rule, `notificationUrl` in
 * `@ferretry/app`, which the worker runs on every push. This file keeps no second copy of how a push is titled or tagged.
 */

import { notificationBrand } from './notify.ts';
import { daemonHomeHref, HOME_HREF, type PushMachine } from '../shell.ts';

/** What a push that reached the app-wide registration says it is: from no machine this browser can name. */
const UNVERIFIED = 'Unverified';

/** The fixed, per-machine tag every filtered push collapses into — see `filteredPushNotification`. */
const FILTERED_PUSH_TAG_PREFIX = 'fy-quiet:';

/**
 * What a push the reader's own filter hides is shown as (`shouldShowNotification`): a push that shows NOTHING can
 * cost the subscription, so this is the quietest answer that is still something — never the hidden content, silent,
 * one fixed tag per machine, and a tap that opens that machine's pages.
 */
export const filteredPushNotification = (
  machine: PushMachine | null,
  origin: string,
): { readonly title: string; readonly options: NotificationOptions & { readonly renotify: boolean } } => ({
  title: `${machine === null ? UNVERIFIED : machine.label} · Notifications muted`,
  options: {
    ...notificationBrand(),
    body: 'This device’s notification settings hid an update. Open the app to see what happened.',
    tag: `${FILTERED_PUSH_TAG_PREFIX}${machine === null ? 'app' : encodeURIComponent(machine.daemonId)}`,
    silent: true,
    renotify: false,
    data: { url: new URL(machine === null ? HOME_HREF : daemonHomeHref(machine.daemonId), origin).href },
  },
});
