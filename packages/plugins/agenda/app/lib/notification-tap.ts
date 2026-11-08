/**
 * WHERE A TAP ON AN AGENDA PUSH LANDS, and how a machine's push worker shows one — copied from today's PWA
 * (`lib/push-scope.ts`). The service worker is the shell's and runs no plugin code, so these are the Agenda's RULES
 * for its own pushes, kept here (pure, tested) until the push payload and its tap target are declarative data in the
 * Agenda's contract that the worker reads: GAP(agenda-push-tap) in NEEDS-APP-SHELL.txt.
 *
 * ONE PUSH WORKER PER MACHINE: a machine's worker titles a push with the reader's label for that machine, tags it in
 * that machine's namespace and lets a tap open only that machine's pages (`/d/<daemonId>`); a push that reached the
 * app-wide registration says it is unverified and opens only the app. A daemon names a ferret's page RELATIVE TO ITS
 * OWN PAGES (`/ferrets/<id>/chat?ask=A3`, `agendaNotificationPath`), so a machine's worker reads it as under that
 * machine; a tap on one opens the ferret's chat AT the ask (the chat reads `?ask=`), checked by the shell's route table.
 */

import { isMachineAgendaId, sessionNotificationPath } from '@ferretry/core-asks/contract';
import { agendaPagePath } from './agenda-links.ts';
import { notificationBrand, type NotificationPayload } from './notify.ts';
import { daemonHomeHref, HOME_HREF, notificationTapTarget } from '../shell.ts';

/** The machine one push registration serves, as this browser registered it. */
export interface PushMachine {
  readonly daemonId: string;
  /** The reader's label for it; the daemon id when none was given. */
  readonly label: string;
}

/** The pages one machine may open: its own home and everything under it. */
const machinePath = (machine: PushMachine): string => daemonHomeHref(machine.daemonId);

const withinMachine = (pathname: string, machine: PushMachine): boolean => {
  const root = machinePath(machine);
  return pathname === root || pathname.startsWith(`${root}/`);
};

/** The page prefix a daemon names its own ferrets by (`/ferrets/<id>/chat`), relative to its machine's pages. */
const FERRET_RELATIVE = '/ferrets/';

const machineRelative = (raw: string, machine: PushMachine | null): string =>
  machine !== null && raw.startsWith(FERRET_RELATIVE) ? `${machinePath(machine)}${raw}` : raw;

/** A ferret's chat under its machine. */
const ferretPath = (machine: PushMachine, sessionId: string): string =>
  `${machinePath(machine)}${sessionNotificationPath(sessionId)}`;

/** Where a tap goes when the push named no page this worker may open. */
const fallbackPath = (machine: PushMachine | null, sessionId: string | undefined): string => {
  if (machine === null) return HOME_HREF;
  if (sessionId === undefined || sessionId.trim() === '') return machinePath(machine);
  if (isMachineAgendaId(sessionId)) return agendaPagePath(machine.daemonId);
  return ferretPath(machine, sessionId);
};

/**
 * Where a notification tap may go: only this site, and — for a machine's own worker — only that machine's pages.
 * Anything else opens that machine's page of the ferret the push is about (`sessionId`), else its home, else — when
 * the push belongs to no machine — the app itself. A push that names no page (`url: '/'`) still opens its ferret.
 */
export const notificationUrl = (
  raw: unknown,
  origin: string,
  machine: PushMachine | null,
  sessionId?: string,
): string => {
  const fallback = new URL(fallbackPath(machine, sessionId), origin);
  const target = typeof raw === 'string' ? URL.parse(machineRelative(raw, machine), origin) : null;
  if (target === null || target.origin !== origin) return fallback.href;
  if (machine === null && target.pathname.startsWith(FERRET_RELATIVE)) return fallback.href;
  if (machine !== null && !withinMachine(target.pathname, machine)) return fallback.href;
  return target.href;
};

/**
 * Where a TAP lands, given the page `notificationUrl` allowed. An Agenda push already names the ferret's chat AT its ask
 * (`/d/<id>/ferrets/<ferret>/chat?ask=A3`), so the tap opens exactly that — if the shell's route table draws it. An
 * address the table does not know opens its machine's home, and a foreign or unreadable one the app's; it never throws.
 */
export const notificationTapUrl = notificationTapTarget;

/** A push as THIS machine's worker shows it: titled for the machine, tagged in its namespace, its own pages only. */
export const machineNotification = (
  payload: NotificationPayload,
  machine: PushMachine,
  origin: string,
): NotificationPayload => ({
  ...payload,
  title: `${machine.label} · ${payload.title}`,
  tag: `fy-push:${encodeURIComponent(machine.daemonId)}:${payload.tag}`,
  url: notificationUrl(payload.url, origin, machine, payload.sessionId),
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
    data: { url: notificationUrl(undefined, origin, machine) },
  },
});
