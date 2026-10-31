/**
 * OS NOTIFICATION DELIVERY — the transport half of the notification subsystem.
 *
 * `notification-ledger.ts` already owns every DECISION: which transition
 * deserves a notification, how it is de-duplicated, and what its payload says.
 * This module owns only what happens afterwards — turning one planned
 * `NotificationSpec` into an OS notification without buzzing twice for the same
 * fact.
 *
 * WHY GROUPING LIVES HERE. The same fact can arrive twice: once over the live
 * event stream while the app is open, and once as a Web Push message the daemon
 * sent for a closed app. Both carry the SAME `eventKey` and the same tag, so the
 * delivery layer can recognise the twin and replace rather than re-alert. kteam
 * kept these functions in its service-worker project (`ui/sw/notify.ts`) and
 * imported them into the page hook; Ferretry has no worker project yet, so they
 * live in the domain tier where both a page and a future worker can import them.
 *
 * NO BROWSER GLOBALS. Every capability this module needs — permission, the
 * registration that can group by tag, the page-level constructor, and the
 * navigation a page-level click performs — arrives as `NotificationSurface`.
 * The composition root builds one from the real browser; a test supplies plain
 * objects. That is also what keeps this file free of a deployed-origin
 * assumption: it never reads `location`, never builds a URL, and only ever
 * follows the daemon-qualified SPA path the ledger already put in the spec.
 */

import type { PushNotificationKind } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import type { NotificationSpec } from './notification-ledger.ts';

export const NOTIFICATION_PAYLOAD_VERSION = 1;

/**
 * The Ferretry mark every notification carries, from the app's own committed icons: the full-colour
 * icon beside the text, and the badge — the mono mark on transparent, which Android paints into the
 * status bar from its alpha alone (`scripts/local/gen-pwa-icons.sh`). Same-origin paths, so a push
 * never names an image service. Platforms without one of them (iOS has no badge) simply ignore it.
 */
export const NOTIFICATION_ICON = '/icons/icon-any-192.png';
export const NOTIFICATION_BADGE = '/icons/badge-96.png';

/** The mark, as notification options. */
export const notificationBrand = (): { readonly icon: string; readonly badge: string } => ({
  icon: NOTIFICATION_ICON,
  badge: NOTIFICATION_BADGE,
});

/**
 * The OS-bound payload. It is deliberately a flat, transport-neutral record
 * rather than the `NotificationSpec` itself: a Web Push message crosses the
 * network as JSON and cannot carry the spec's `DaemonSessionScope` object, so
 * the daemon it belongs to travels as a plain `daemonId` beside the already
 * daemon-qualified `tag` and `url`.
 */
export interface NotificationPayload {
  readonly version: number;
  readonly title: string;
  /** The latest line only; the collapsed count is added at presentation time. */
  readonly body: string;
  readonly tag: string;
  readonly url: string;
  readonly count: number;
  readonly eventKey: string;
  /** Absent only on a payload with no daemon scope, which the ledger never emits. */
  readonly daemonId?: DaemonId;
  /** Absent on a fleet summary. */
  readonly sessionId?: string;
  readonly kind?: PushNotificationKind;
  /** A high-priority push from a daemon (a one-time code waiting): see {@link urgentNotificationOptions}. */
  readonly urgency?: 'high';
}

/**
 * What a HIGH push asks the platform for, beyond an ordinary one: stay on screen until the reader acts
 * (`requireInteraction`), sound and buzz again even though a notification with this tag may be showing (`renotify`,
 * `silent: false`, `vibrate`). Each platform honours what it supports and ignores the rest: Chrome on Android and
 * desktop keep it and sound it; iOS and iPadOS web apps show it but expose no interruption level, so a Focus mode can
 * still hold it (docs/notifications.md, "High priority"). An ordinary push asks for nothing new.
 */
export interface UrgentNotificationOptions {
  readonly requireInteraction?: true;
  readonly renotify?: true;
  readonly silent?: false;
  readonly vibrate?: readonly number[];
}

export const urgentNotificationOptions = (payload: Pick<NotificationPayload, 'urgency'>): UrgentNotificationOptions =>
  payload.urgency === 'high'
    ? { requireInteraction: true, renotify: true, silent: false, vibrate: [200, 100, 200] }
    : {};

/** Projects a planned spec into the payload the OS and the wire both accept. */
export const notificationPayload = (spec: NotificationSpec): NotificationPayload => ({
  version: NOTIFICATION_PAYLOAD_VERSION,
  title: spec.title,
  body: spec.body,
  tag: spec.tag,
  url: spec.url,
  count: spec.count,
  eventKey: spec.eventKey,
  ...(spec.scope === undefined ? {} : { daemonId: spec.scope.daemonId }),
  ...(spec.sessionId === undefined ? {} : { sessionId: spec.sessionId }),
  ...(spec.kind === undefined ? {} : { kind: spec.kind }),
});

export const groupedNotificationBody = (latest: string, count: number): string =>
  count > 1 ? `${latest}\n+${count - 1} more` : latest;

/** The slice of an existing OS notification's `data` the merge decision reads. */
export interface NotificationDataLike {
  readonly eventKey?: unknown;
  readonly count?: unknown;
}

export interface NotificationPresentationData {
  readonly url: string;
  readonly eventKey: string;
  readonly count: number;
  readonly latestBody: string;
  readonly daemonId?: DaemonId;
  readonly sessionId?: string;
}

export type NotificationPresentation =
  | { readonly action: 'skip' }
  | {
      readonly action: 'show';
      readonly body: string;
      readonly count: number;
      readonly data: NotificationPresentationData;
    };

const MAX_GROUP_COUNT = 100;

const activeCount = (existing: readonly NotificationDataLike[]): number =>
  existing.reduce(
    (highest, item) =>
      typeof item.count === 'number' && Number.isSafeInteger(item.count) && item.count > highest ? item.count : highest,
    0,
  );

/**
 * Merges one incoming payload with whatever is already on screen under the same
 * tag. An exact `eventKey` match is the transport twin and is skipped outright;
 * a genuinely newer line replaces the entry silently and carries the latest text
 * plus a "+N more" tail.
 *
 * The count merge applies to SESSION notifications only. A fleet summary already
 * counts sessions rather than lines, so raising its count from a previous
 * summary would double-count the same fleet.
 */
export const planNotificationPresentation = (
  payload: NotificationPayload,
  existing: readonly NotificationDataLike[],
): NotificationPresentation => {
  if (existing.some(item => item.eventKey === payload.eventKey)) return { action: 'skip' };
  const active = payload.sessionId === undefined ? 0 : activeCount(existing);
  const count = active > 0 ? Math.max(payload.count, Math.min(MAX_GROUP_COUNT, active + 1)) : payload.count;
  return {
    action: 'show',
    body: groupedNotificationBody(payload.body, count),
    count,
    data: {
      url: payload.url,
      eventKey: payload.eventKey,
      count,
      latestBody: payload.body,
      ...(payload.daemonId === undefined ? {} : { daemonId: payload.daemonId }),
      ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    },
  };
};

/** The registration surface the grouped show needs, and nothing more. */
export interface NotificationRegistrationLike {
  getNotifications(options?: { tag?: string }): PromiseLike<readonly { readonly data?: unknown }[]>;
  showNotification(title: string, options?: NotificationOptions): PromiseLike<void>;
}

const readData = (notification: { readonly data?: unknown }): NotificationDataLike =>
  typeof notification.data === 'object' && notification.data !== null
    ? (notification.data as NotificationDataLike)
    : {};

/**
 * Shows one payload through a registration, collapsing the transport twins.
 *
 * The existing-notification read closes almost every race; if both transports
 * read before either writes, the identical tag still collapses to one OS entry
 * and `renotify: false` makes the replacement silent.
 */
export const showGroupedNotification = async (
  registration: NotificationRegistrationLike,
  payload: NotificationPayload,
): Promise<'shown' | 'duplicate'> => {
  const notifications = await registration.getNotifications({ tag: payload.tag });
  const plan = planNotificationPresentation(payload, notifications.map(readData));
  if (plan.action === 'skip') return 'duplicate';
  const options: NotificationOptions & { renotify: boolean } = {
    ...notificationBrand(),
    body: plan.body,
    tag: payload.tag,
    renotify: false,
    data: plan.data,
    ...urgentNotificationOptions(payload),
  };
  await registration.showNotification(payload.title, options);
  return 'shown';
};

/** `Notification.permission`, plus the honest answer where the API is absent. */
export type NotificationPermissionState = 'unsupported' | 'default' | 'denied' | 'granted';

/** The page-level notification the fallback creates, and nothing more. */
export interface PageNotificationLike {
  onclick: ((this: unknown, event: unknown) => unknown) | null;
  close(): void;
}

export interface PageNotificationOptions {
  readonly icon: string;
  readonly badge: string;
  readonly body: string;
  readonly tag: string;
  readonly renotify: boolean;
}

/**
 * Every browser capability the delivery layer needs, injected.
 *
 * A public PWA cannot assume any of them: permission may be unsupported, a
 * service worker may be absent in a plain browser tab, and the page-level
 * constructor throws in some engines while a worker controls the page.
 */
export interface NotificationSurface {
  readonly permission: () => NotificationPermissionState;
  /** Must be reached from a reader gesture; this module never calls it. */
  readonly requestPermission: () => Promise<NotificationPermissionState>;
  /** The registration able to group by tag, or `null` without one. */
  readonly registration: () => Promise<NotificationRegistrationLike | null>;
  /** The no-worker development fallback; `null` where the constructor is absent. */
  readonly showOnPage: ((title: string, options: PageNotificationOptions) => PageNotificationLike) | null;
  /** Where a page-level click sends the reader — an in-app path, never a URL. */
  readonly navigate: (path: string) => void;
}

export type NotificationOutcome = 'shown' | 'duplicate' | 'suppressed' | 'unavailable';

/**
 * Delivers one payload, preferring the registration.
 *
 * `suppressed` and `unavailable` are different facts and are reported as such:
 * the reader has not granted permission, versus the browser cannot show this at
 * all. Collapsing them would make a settings readout lie in one direction or
 * the other.
 */
export const showNotification = async (
  surface: NotificationSurface,
  payload: NotificationPayload,
): Promise<NotificationOutcome> => {
  if (surface.permission() !== 'granted') return 'suppressed';
  const registration = await surface.registration().catch(() => null);
  if (registration !== null) return await showGroupedNotification(registration, payload);
  const { showOnPage } = surface;
  if (showOnPage === null) return 'unavailable';
  try {
    const notification = showOnPage(payload.title, {
      ...notificationBrand(),
      body: groupedNotificationBody(payload.body, payload.count),
      tag: payload.tag,
      renotify: false,
    });
    // A pageless click cannot reach this handler, which is exactly why the
    // registration path above is the real one; a page-level notification has to
    // route its own click.
    notification.onclick = () => {
      surface.navigate(payload.url);
      notification.close();
    };
    return 'shown';
  } catch {
    // Some engines refuse the constructor outright while a worker controls the
    // page. Nothing is left to fall back to, and the fleet UI still shows the
    // status change the notification would have announced.
    return 'unavailable';
  }
};
