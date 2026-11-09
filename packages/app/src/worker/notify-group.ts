/**
 * HOW THE WORKER SHOWS ONE PUSH: namespaced by machine, grouped under its tag, loud only when asked. Ported from today's PWA
 * (`lib/notify.ts`, `lib/push-scope.ts`'s quiet line), reading ONLY the kernel's show envelope (`readPushMessage`:
 * `title`, `body`, `url`, `tag`, `kind`, `count`, `urgency`) — the worker runs no plugin code and trusts nothing a page
 * could have stored. Pure but for the registration it is handed.
 *
 * - **Replace, silently.** A show carries a daemon `tag`; the worker files it under THIS machine's namespace
 *   (`fy-push:<daemonId>:<tag>`), so a later show with the same tag REPLACES the line (`renotify: false`, so it does not
 *   sound again) and a clear can take exactly that machine's line down. An untagged show (an older daemon, or a tag that
 *   would not fit) gets no tag and never replaces anything.
 * - **Group, with the count.** The latest words stay; "+N more" says how many. A repeat under one tag merges with the
 *   count already showing, so the number never goes backwards.
 * - **Approvals are never grouped.** A phone approval (`pa-…`) shows the digits a lock screen is there to show, so it is
 *   not merged and not hidden under "+N more"; a changed body replaces the line and sounds again.
 * - **Loud when asked.** `urgency: 'high'` (and every approval) stays on screen until the reader acts and sounds again.
 * - **A quiet line when the reader's own filter hides it** — never the hidden words, one fixed tag per machine.
 */

import type { PushShow } from '@ferretry/kernel/contract/push-envelope';
import {
  machineHomeUrl,
  notificationBrand,
  notificationUrl,
  type PushMachine,
  UNVERIFIED_LABEL,
} from './notifications.ts';

/** What a push that shows its machine's own words is titled with: the reader's label for the machine. */
const labelOf = (machine: PushMachine | null): string => (machine === null ? UNVERIFIED_LABEL : machine.label);

/** The fixed, per-machine tag every filtered push collapses into. */
export const FILTERED_PUSH_TAG_PREFIX = 'fy-quiet:';

/** A daemon's tag, as THIS registration shows it: inside its machine's namespace, or the app-wide one's. */
export const shownTag = (tag: string, machine: PushMachine | null): string =>
  machine === null ? `fy-push-unverified:${tag}` : `fy-push:${encodeURIComponent(machine.daemonId)}:${tag}`;

/**
 * An approve-on-phone push's tag: `pa-<id>`, as the machine's worker namespaces it (`fy-push:<machine>:pa-<id>`). The
 * daemon sends no `urgency` for it, so the tag is what says it is one.
 */
const PHONE_APPROVAL_TAG = /(?:^|:)pa-pa_[0-9a-f]{24}$/u;
export const isPhoneApprovalTag = (tag: string): boolean => PHONE_APPROVAL_TAG.test(tag);

/** What a HIGH push asks the platform for beyond an ordinary one. Each platform honours what it supports. */
export interface UrgentNotificationOptions {
  readonly requireInteraction?: true;
  readonly renotify?: true;
  readonly silent?: false;
  readonly vibrate?: readonly number[];
}

/**
 * What a push asks the platform for beyond an ordinary one: a HIGH push, and every approve-on-phone push, stay on screen
 * until the reader acts and sound again under a tag already showing (a number that was re-read is a new push).
 */
export const urgentNotificationOptions = (shown: {
  readonly urgency?: 'high';
  readonly tag?: string;
}): UrgentNotificationOptions => {
  if (shown.urgency !== 'high' && !(shown.tag !== undefined && isPhoneApprovalTag(shown.tag))) return {};
  // `renotify: true` with no tag is a TypeError in the Notifications spec, and an untagged show is legitimate (a tag that
  // would not fit is sent untagged): the show would be rejected and the reader would see the generic line instead of
  // the words. An untagged line has nothing to sound "again" over, so it stays loud without `renotify`.
  return {
    requireInteraction: true,
    ...(shown.tag === undefined ? {} : { renotify: true }),
    silent: false,
    vibrate: [200, 100, 200],
  };
};

export const groupedNotificationBody = (latest: string, count: number): string =>
  count > 1 ? `${latest}\n+${count - 1} more` : latest;

/** The most "+N more" a merge ever claims, so a lock screen never promises a number it cannot back. */
const MAX_GROUP_COUNT = 100;

/**
 * The one kind of push whose repeats never merge into "+N more": the paired-device notice. As in v4, where every push
 * but `device-paired` carried a `sessionId` and so merged (Access's `agenda`, `failed`, `completed` and `question`).
 */
const UNMERGED_KIND = 'device-paired';

/** One push, ready to show on one machine's registration. */
export interface ShownPush {
  readonly title: string;
  /** The daemon's own words for the latest line. */
  readonly body: string;
  /** The namespaced tag this line is filed under, or `undefined` for an untagged show. */
  readonly tag?: string;
  /** The daemon's tag, un-namespaced: what a tap tells the page (`notificationOpened`). */
  readonly daemonTag?: string;
  readonly kind?: string;
  readonly count: number;
  readonly urgency?: 'high';
  /** The page a tap opens: the shell's route parse accepted it under this machine, else the app. */
  readonly url: string;
}

/**
 * One show on this registration: the daemon's words under the reader's label for the machine, its tag in the machine's
 * namespace, and the page it named only if the shell's route parse accepts it under this machine.
 */
export const machineShow = (show: PushShow, machine: PushMachine | null, origin: string): ShownPush => ({
  title: `${labelOf(machine)} · ${show.title}`,
  body: show.body,
  ...(show.tag === undefined ? {} : { tag: shownTag(show.tag, machine), daemonTag: show.tag }),
  ...(show.kind === undefined ? {} : { kind: show.kind }),
  count: show.count ?? 1,
  ...(show.urgency === undefined ? {} : { urgency: show.urgency }),
  url: notificationUrl(show.url, origin, machine),
});

/** The slice of an existing notification's `data` a merge reads. */
interface NotificationDataLike {
  readonly count?: unknown;
  readonly latestBody?: unknown;
}

export type NotificationPresentation =
  | { readonly action: 'skip' }
  | {
      readonly action: 'show';
      readonly body: string;
      readonly count: number;
      readonly data: {
        readonly url: string;
        readonly count: number;
        readonly latestBody: string;
        readonly tag?: string;
      };
    };

const activeCount = (existing: readonly NotificationDataLike[]): number =>
  existing.reduce(
    (highest, item) =>
      typeof item.count === 'number' && Number.isSafeInteger(item.count) && item.count > highest ? item.count : highest,
    0,
  );

/**
 * Merges one incoming push with whatever is already showing under the same tag. A genuinely newer line replaces the
 * entry silently and carries the latest words plus a "+N more" tail. The count merge applies to every kind but the
 * paired-device notice ({@link UNMERGED_KIND}), as v4's did for every push that carried a `sessionId`; a push with no
 * kind shows its own count, and an approval is never merged. v4 also skipped an exact `eventKey`
 * twin; the kernel's envelope has no event key, so a push service's re-delivery of a session push bumps the count
 * (declared in `ports-pending.json`).
 */
export const planNotificationPresentation = (
  shown: ShownPush,
  existing: readonly NotificationDataLike[],
): NotificationPresentation => {
  const data = (count: number) => ({
    url: shown.url,
    count,
    latestBody: shown.body,
    ...(shown.daemonTag === undefined ? {} : { tag: shown.daemonTag }),
  });
  if (shown.tag !== undefined && isPhoneApprovalTag(shown.tag)) {
    // Only the same words are a twin; a re-read number is a new push and sounds again.
    if (existing.some(item => item.latestBody === shown.body)) return { action: 'skip' };
    return { action: 'show', body: shown.body, count: 1, data: data(1) };
  }
  const merges = shown.kind !== undefined && shown.kind !== UNMERGED_KIND;
  const active = merges ? activeCount(existing) : 0;
  const count = active > 0 ? Math.max(shown.count, Math.min(MAX_GROUP_COUNT, active + 1)) : shown.count;
  return { action: 'show', body: groupedNotificationBody(shown.body, count), count, data: data(count) };
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
 * Shows one push through a registration, collapsing what is already under its tag. The existing-notification read closes
 * almost every race; if two reads happen before either writes, the identical tag still collapses to one entry and
 * `renotify: false` makes the replacement silent.
 */
export const showGroupedNotification = async (
  registration: NotificationRegistrationLike,
  shown: ShownPush,
): Promise<'shown' | 'duplicate'> => {
  const existing = shown.tag === undefined ? [] : await registration.getNotifications({ tag: shown.tag });
  const plan = planNotificationPresentation(shown, existing.map(readData));
  if (plan.action === 'skip') return 'duplicate';
  await registration.showNotification(shown.title, {
    ...notificationBrand(),
    body: plan.body,
    ...(shown.tag === undefined ? {} : { tag: shown.tag }),
    renotify: false,
    data: plan.data,
    ...urgentNotificationOptions(shown),
  } as NotificationOptions);
  return 'shown';
};

/**
 * What a push the reader's own filter hides is shown as: a push that shows NOTHING can cost the subscription (Apple's
 * and Mozilla's revoke it), so this is the quietest answer that is still something — NEVER the hidden words (a reader
 * who muted `failed` does not want the reason through the back door), silent, ONE FIXED TAG PER MACHINE so ten filtered
 * pushes collapse into one line, and a tap that opens that machine's home.
 */
export const filteredPushNotification = (
  machine: PushMachine | null,
  origin: string,
): { readonly title: string; readonly options: NotificationOptions & { readonly renotify: boolean } } => ({
  title: `${labelOf(machine)} · Notifications muted`,
  options: {
    ...notificationBrand(),
    body: 'This device’s notification settings hid an update. Open the app to see what happened.',
    tag: `${FILTERED_PUSH_TAG_PREFIX}${machine === null ? 'app' : encodeURIComponent(machine.daemonId)}`,
    silent: true,
    renotify: false,
    data: { url: machineHomeUrl(machine, origin) },
  },
});
