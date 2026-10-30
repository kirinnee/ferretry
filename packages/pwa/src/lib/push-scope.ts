/**
 * ONE PUSH WORKER PER MACHINE (docs/cross-daemon.md §4).
 *
 * A browser holds ONE push subscription per service-worker registration, and a subscription is bound
 * to the VAPID key of the daemon that made it: the push service refuses a push signed by any other
 * key. With one registration for the whole app, the first machine enrolled became the only one that
 * could deliver — the others' pushes were refused — and if that machine was broken into, it was the
 * only voice for every machine's alerts: it could fake "a new device was paired with B" and nothing
 * real from B would arrive. Turning notifications off for one machine also dropped the shared
 * subscription for all of them.
 *
 * So each machine gets its OWN registration, at the scope `/push/<daemonId>/`, of the SAME signed
 * worker file (`sw.verified.js`, the one the signed release list names — docs/pwa-release-signing.md).
 * Its subscription carries that machine's key and nobody else's, and the worker learns which machine
 * it serves from its own registration scope, which this browser chose — never from a push. It then:
 *
 * - prefixes every title with the reader's own label for that machine (carried in the worker script's
 *   query, so a rename re-registers rather than trusting anything a daemon said);
 * - keeps every tag inside that machine's namespace, so one machine cannot replace another's
 *   notification by reusing its tag;
 * - opens only that machine's own pages (`/d/<daemonId>`), whatever URL the push named.
 *
 * Pure: the page and the worker both call these, and neither reads a global here.
 */

import type { PushNotificationPayload } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import { notificationBrand } from './notify.ts';
import { daemonSessionPath, daemonSessionsPath } from './pages/routes.ts';

/** The path every per-machine push registration lives under. Never a page the app serves. */
export const PUSH_SCOPE_ROOT = '/push/';

/** The query parameter the worker reads its machine's label from. */
const LABEL_PARAMETER = 'machine';

/** The registration scope for one machine's push worker, as a path on this origin. */
export const pushScopePath = (daemon: DaemonId): string => `${PUSH_SCOPE_ROOT}${encodeURIComponent(daemon)}/`;

/** The worker script for one machine's registration: the signed worker, with the reader's label. */
export const pushWorkerUrl = (workerUrl: string, label: string): string =>
  `${workerUrl}?${LABEL_PARAMETER}=${encodeURIComponent(label)}`;

/** The machine one push registration serves, as this browser registered it. */
export interface PushMachine {
  readonly daemonId: string;
  /** The reader's label for it; the daemon id when the script named none. */
  readonly label: string;
}

/**
 * Which machine a registration serves, from its scope URL and its script URL — or `null` for the
 * app's own registration (scope `/`) and anything else that is not a per-machine push scope.
 */
export const pushMachineOf = (scope: string, scriptUrl: string): PushMachine | null => {
  const path = URL.parse(scope)?.pathname ?? '';
  if (!path.startsWith(PUSH_SCOPE_ROOT)) return null;
  const segment = path.slice(PUSH_SCOPE_ROOT.length).replace(/\/$/u, '');
  if (segment === '' || segment.includes('/')) return null;
  let daemonId: string;
  try {
    daemonId = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const label = URL.parse(scriptUrl)?.searchParams.get(LABEL_PARAMETER)?.trim() ?? '';
  return { daemonId, label: label === '' ? daemonId : label };
};

/** Whether a registration scope URL is a per-machine push scope. */
export const isPushScope = (scope: string): boolean => pushMachineOf(scope, scope) !== null;

/** The pages one machine may open: its own sessions page and everything under it. */
const machinePath = (machine: PushMachine): string => daemonSessionsPath(machine.daemonId as DaemonId);

const withinMachine = (pathname: string, machine: PushMachine): boolean => {
  const root = machinePath(machine);
  return pathname === root || pathname.startsWith(`${root}/`);
};

/**
 * A push as THIS machine's worker shows it: titled with the reader's label for the machine, tagged
 * inside its namespace, and pointing only at its own pages. The daemon's own words stay in the body.
 */
export const machineNotification = (
  payload: PushNotificationPayload,
  machine: PushMachine,
  origin: string,
): PushNotificationPayload => ({
  ...payload,
  title: `${machine.label} · ${payload.title}`,
  tag: `fy-push:${encodeURIComponent(machine.daemonId)}:${payload.tag}`,
  url: notificationUrl(payload.url, origin, machine, 'sessionId' in payload ? payload.sessionId : undefined),
});

/** What a push that reached the app-wide registration says it is: from no machine this browser can name. */
const UNVERIFIED = 'Unverified';

/** What a push nobody composed is shown as, so a subscription is never punished for a silent push. */
export const unreadablePushTitle = (machine: PushMachine | null): string =>
  machine === null ? `${UNVERIFIED} · Ferretry` : `${machine.label} · Ferretry`;

/**
 * A push that reached the APP-WIDE registration: the old shared subscription, before it was dropped
 * (docs/cross-daemon.md §4b). Nothing says which machine sent it, so it is titled "Unverified", kept out
 * of every machine's tag namespace, and opens only the app itself — never one machine's pages.
 */
export const unverifiedNotification = (payload: PushNotificationPayload, origin: string): PushNotificationPayload => ({
  ...payload,
  title: `${UNVERIFIED} · ${payload.title}`,
  tag: `fy-push-unverified:${payload.tag}`,
  url: new URL('/app/', origin).href,
});

/**
 * Where a notification click may go (docs/cross-daemon.md §4a, §4c): only this site, and — for a
 * machine's own worker — only that machine's pages. Anything else opens that machine's own copy of
 * the conversation the push is about (`sessionId`), else its sessions, else — when the notification
 * belongs to no machine — the app itself.
 *
 * A daemon names a conversation RELATIVE TO ITS OWN PAGES — `/session/<id>?attention=A3`
 * (`agendaNotificationPath`), since it never knows which name this browser files it under — so a
 * machine's worker reads `/session/…` as under that machine. The app-wide worker knows no machine, and
 * such a path falls through to the app itself.
 *
 * THE `sessionId` FALLBACK IS FOR DAEMONS THAT NAME NO PAGE. A daemon older than #768 sent every push —
 * an ask included — with `url: '/'`, and `fy attention notify` still did: the tap opened the machine's
 * session list and left the reader to find the conversation. The payload's own `sessionId` says which
 * one it is about, so the tap opens it there.
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
  if (machine === null && target.pathname.startsWith(SESSION_RELATIVE)) return fallback.href;
  if (machine !== null && !withinMachine(target.pathname, machine)) return fallback.href;
  return target.href;
};

/** Where a tap goes when the push named no page this worker may open. */
const fallbackPath = (machine: PushMachine | null, sessionId: string | undefined): string => {
  if (machine === null) return '/app/';
  if (sessionId === undefined || sessionId.trim() === '') return machinePath(machine);
  return daemonSessionPath(machine.daemonId as DaemonId, sessionId);
};

/** The page prefix a daemon names its own conversations by, relative to its machine's pages. */
const SESSION_RELATIVE = '/session/';

const machineRelative = (raw: string, machine: PushMachine | null): string =>
  machine !== null && raw.startsWith(SESSION_RELATIVE) ? `${machinePath(machine)}${raw}` : raw;

/** The fixed, per-machine tag every filtered push collapses into — see `filteredPushNotification`. */
export const FILTERED_PUSH_TAG_PREFIX = 'fy-quiet:';

/**
 * THE LEAST-BAD COMPLIANT ANSWER to a push the reader's own filter says to hide
 * (`shouldShowNotification` in `notification-filter.ts`, read back from the mirror
 * `notification-filter-mirror.ts` keeps for exactly this).
 *
 * A push that is received but shows NOTHING is a pattern browsers can revoke a subscription over —
 * see the worker's own doc comment — so showing nothing is not available, whatever the reader asked
 * for. This is the quietest answer that is still something:
 *
 * - NEVER THE SUPPRESSED CONTENT. A reader who muted `failed` does not want to learn the failure
 *   reason through the back door of "well, SOMETHING had to be shown." The title and body here are
 *   always this fixed sentence, whatever the real payload said.
 * - `silent: true` — no sound, no vibration — because the payload earned no interruption.
 * - ONE FIXED TAG PER MACHINE (`renotify: false`), so ten filtered pushes in a row collapse into one
 *   persistent line rather than ten, in the SAME namespace a machine's ordinary pushes use
 *   (`fy-quiet:<daemonId>`, never clashing with `fy-push:<daemonId>:<tag>`).
 * - Opens that machine's own pages on a tap, same as any other push — `notificationUrl` with no
 *   `raw` URL always falls through to the fallback, so this reuses it rather than re-deriving it.
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
