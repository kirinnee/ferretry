/**
 * HOW A MACHINE'S PUSH IS SHOWN WHEN A PAGE SHOWS IT (not the worker), copied from today's PWA (`lib/push-scope.ts`). WHERE A TAP
 * MAY GO is not decided here: it is the shell's one rule, `notificationUrl` in `@ferretry/app` (the worker runs it on every
 * push; this file calls it). A daemon names a ferret's page RELATIVE TO ITS OWN PAGES (`/ferrets/<id>/chat?ask=A3`,
 * `agendaNotificationPath`) and that rule places it under the machine; a push that reached the app-wide registration says
 * it is unverified and opens only the app.
 */

import { notificationBrand, type NotificationPayload } from './notify.ts';
import { daemonHomeHref, HOME_HREF, notificationUrl, type PushMachine } from '../shell.ts';

/** A push as THIS machine's worker shows it: titled for the machine, tagged in its namespace, its own pages only. */
export const machineNotification = (
  payload: NotificationPayload,
  machine: PushMachine,
  origin: string,
): NotificationPayload => ({
  ...payload,
  title: `${machine.label} · ${payload.title}`,
  tag: `fy-push:${encodeURIComponent(machine.daemonId)}:${payload.tag}`,
  url: notificationUrl(payload.url, origin, machine),
});

/** What a push that reached the app-wide registration says it is: from no machine this browser can name. */
const UNVERIFIED = 'Unverified';

/** A push that reached the APP-WIDE registration: titled "Unverified", in no machine's namespace, opening the app. */
export const unverifiedNotification = (payload: NotificationPayload, origin: string): NotificationPayload => ({
  ...payload,
  title: `${UNVERIFIED} · ${payload.title}`,
  tag: `fy-push-unverified:${payload.tag}`,
  url: new URL(HOME_HREF, origin).href,
});

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
