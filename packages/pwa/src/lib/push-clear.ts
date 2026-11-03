/**
 * TAKING A HANDLED ITEM'S ALERTS DOWN (docs/notifications.md § When an alert is cleared).
 *
 * The owner's ask: "if an agenda went to sleep, then you should dismiss all notifications sent out related to the
 * agenda! or when on 1 device is alr replied or resolved. then it should dismiss on other phones". A daemon sends a
 * `clear` push naming the tags of the alerts that are no longer true, and nothing else — no title, no body, no item
 * words (`PushClearPayloadSchema`). This module decides what this device does with one, and does it through the
 * registration it is handed, so the worker stays wiring only.
 *
 * ## WHY AN IPHONE SWAPS RATHER THAN CLOSES (owner decision !A324)
 *
 * Apple's push service revokes a site's subscription that receives a push and shows nothing — the same rule
 * `filteredPushNotification` answers for a muted push. So where Apple delivers the push, a clear REPLACES the item's
 * notification with one quiet "Handled on another device" line under the same tag (silent, no item words); where it
 * finds nothing showing, it shows that line once under a fixed per-machine tag, so lines never pile up. Everywhere
 * else a clear closes the matching notifications and shows nothing new.
 *
 * WHICH SERVICE IS APPLE'S is read from this registration's own push subscription — its endpoint is on
 * `*.push.apple.com` — never from the user agent: an iPad's says Mac, and Safari on a Mac has the same rule. A
 * subscription that cannot be read is treated as Apple's: a needless quiet line beats a revoked subscription.
 *
 * ## ONE MACHINE, ITS OWN TAGS
 *
 * A machine's worker turns each named tag into that machine's namespace (`fy-push:<daemonId>:<tag>`, the one
 * `machineNotification` shows under), so a clear can only ever take down what that same machine showed.
 */

import type { PushClearPayload } from '@ferretry/protocol';
import { notificationBrand } from './notify.ts';
import { notificationUrl, type PushMachine } from './push-scope.ts';

/** The fixed, per-machine tag the quiet line goes under when nothing of the item's was showing. */
export const HANDLED_TAG_PREFIX = 'fy-handled:';

/** The quiet line's words: the same whatever was handled, so no item words ever reach a lock screen through it. */
export const HANDLED_TITLE = 'Handled on another device';
export const HANDLED_BODY = 'Nothing to do here.';

/** The host suffix of Apple's push service, which shards by subdomain (`PUSH_SERVICE_HOST_SUFFIXES`). */
const APPLE_PUSH_HOST_SUFFIX = '.push.apple.com';

/**
 * Whether the push service behind this registration is Apple's, from its subscription endpoint. Unreadable, absent or
 * not a URL is Apple's (see the header): the answer that can only cost a quiet line.
 */
export const isApplePushService = (endpoint: string | null | undefined): boolean => {
  if (endpoint === null || endpoint === undefined) return true;
  const host = URL.parse(endpoint)?.hostname.toLowerCase();
  if (host === undefined) return true;
  return host.endsWith(APPLE_PUSH_HOST_SUFFIX) && host.length > APPLE_PUSH_HOST_SUFFIX.length;
};

/** A daemon's tag, as THIS registration showed it: inside its machine's namespace, or the app-wide one's. */
export const shownTag = (tag: string, machine: PushMachine | null): string =>
  machine === null ? `fy-push-unverified:${tag}` : `fy-push:${encodeURIComponent(machine.daemonId)}:${tag}`;

/** The quiet line, under `tag`. */
export const handledNotification = (
  machine: PushMachine | null,
  origin: string,
  tag: string,
): { readonly title: string; readonly options: NotificationOptions & { readonly renotify: boolean } } => ({
  title: `${machine === null ? 'Unverified' : machine.label} · ${HANDLED_TITLE}`,
  options: {
    ...notificationBrand(),
    body: HANDLED_BODY,
    tag,
    silent: true,
    renotify: false,
    data: { url: notificationUrl(undefined, origin, machine) },
  },
});

/** What one clear does on this device: the shown tags to close, and the quiet line to show, if any. */
export interface ClearPlan {
  readonly close: readonly string[];
  readonly show?: ReturnType<typeof handledNotification>;
}

/**
 * THE DECISION, pure: given which of the clear's tags are showing here (as shown, in the clear's order) and whether
 * Apple delivers this registration's pushes.
 */
export const planClear = (
  showing: readonly string[],
  apple: boolean,
  machine: PushMachine | null,
  origin: string,
): ClearPlan => {
  if (!apple) return { close: showing };
  const [first, ...rest] = showing;
  if (first === undefined) {
    const fixed = `${HANDLED_TAG_PREFIX}${machine === null ? 'app' : encodeURIComponent(machine.daemonId)}`;
    return { close: [], show: handledNotification(machine, origin, fixed) };
  }
  // Shown under the first match's own tag, it REPLACES that notification; the rest are closed.
  return { close: rest, show: handledNotification(machine, origin, first) };
};

/** The slice of a service-worker registration a clear needs. */
export interface ClearRegistration {
  getNotifications(options: { tag: string }): PromiseLike<readonly { close(): void }[]>;
  showNotification(title: string, options?: NotificationOptions): PromiseLike<void>;
  readonly pushManager?: { getSubscription(): PromiseLike<{ readonly endpoint: string } | null> };
}

/** Whether Apple delivers this registration's pushes, read from its own subscription. */
const deliveredByApple = async (registration: ClearRegistration): Promise<boolean> => {
  try {
    return isApplePushService((await registration.pushManager?.getSubscription())?.endpoint);
  } catch {
    return true;
  }
};

/** Carries one clear out on this registration: closes what it names, and shows the quiet line where Apple needs one. */
export const applyClear = async (
  registration: ClearRegistration,
  payload: PushClearPayload,
  machine: PushMachine | null,
  origin: string,
  order?: { readonly recent: RecentlyCleared; readonly place: number },
): Promise<ClearPlan> => {
  const tags = [...new Set(payload.tags.map(tag => shownTag(tag, machine)))];
  // Remembered before anything is awaited: a push for one of these tags still on its way through this worker reads it.
  order?.recent.remember(tags, order.place);
  const found = await Promise.all(tags.map(async tag => [tag, await registration.getNotifications({ tag })] as const));
  const showing = found.filter(([, notifications]) => notifications.length > 0).map(([tag]) => tag);
  const plan = planClear(showing, await deliveredByApple(registration), machine, origin);
  // The line is shown first: on Apple's service a push must show something, and the replacement is that something.
  if (plan.show !== undefined) await registration.showNotification(plan.show.title, plan.show.options);
  for (const [tag, notifications] of found) {
    if (!plan.close.includes(tag)) continue;
    for (const notification of notifications) notification.close();
  }
  return plan;
};

/** How long a clear is remembered in this worker: far longer than one push handler takes to read its filter and show. */
export const CLEARED_TAG_MEMORY_MS = 60_000;

/**
 * THE ORDER PUSHES REACHED THIS WORKER, AND WHAT EACH CLEAR TOOK DOWN.
 *
 * A push and the clear that follows it can be handled at once in one worker, and a push handler awaits the filter
 * mirror before it shows anything: a clear handled in that gap finds nothing to close, and the push would then put the
 * stale line up after it. So every push takes its place in arrival order ({@link arrived}), a clear remembers its
 * tags with its own place, and a push is settled as the clear would have settled it ({@link settleIfCleared}) only when
 * a clear of its tag arrived AFTER it. A push that arrives after the clear — the item woke again, a new number — is a
 * newer line and shows as usual.
 *
 * In memory: a worker that stopped in between had no such race. A clear the push service delivers BEFORE the push it
 * clears is not caught: nothing on the wire tells a stale push from a newer one, and the clear carries no more.
 */
export class RecentlyCleared {
  #place = 0;
  readonly #cleared = new Map<string, { readonly place: number; readonly at: number }>();

  constructor(private readonly now: () => number) {}

  /** A push event's place in this worker's arrival order. */
  arrived(): number {
    this.#place += 1;
    return this.#place;
  }

  /** A clear at \`place\` took these shown tags down. */
  remember(tags: readonly string[], place: number): void {
    const at = this.now();
    for (const [tag, entry] of this.#cleared) if (at - entry.at > CLEARED_TAG_MEMORY_MS) this.#cleared.delete(tag);
    for (const tag of tags) this.#cleared.set(tag, { place, at });
  }

  /** Whether a clear of \`tag\` arrived after the push at \`place\`, within memory. */
  clearedAfter(tag: string, place: number): boolean {
    const entry = this.#cleared.get(tag);
    return entry !== undefined && entry.place > place && this.now() - entry.at <= CLEARED_TAG_MEMORY_MS;
  }
}

/**
 * A push at \`place\`, about to show or just shown under \`tag\`, that a later clear took down meanwhile: settled as that
 * clear would have — whatever is under the tag closed, or on Apple's service replaced by the quiet line (a push must
 * show something there). Answers whether it was.
 */
export const settleIfCleared = async (
  registration: ClearRegistration,
  tag: string,
  recent: RecentlyCleared,
  place: number,
  machine: PushMachine | null,
  origin: string,
): Promise<boolean> => {
  if (!recent.clearedAfter(tag, place)) return false;
  const showing = await registration.getNotifications({ tag });
  const plan = planClear([tag], await deliveredByApple(registration), machine, origin);
  if (plan.show !== undefined) await registration.showNotification(plan.show.title, plan.show.options);
  if (plan.close.includes(tag)) for (const notification of showing) notification.close();
  return true;
};

/**
 * THE PAGE'S HALF: the owner opened an item here, so this device takes its own lines for it down. The daemon's clear
 * skipped this device (so it never swaps them for "Handled on another device" on the phone in the owner's hand); the
 * page closes the tags the daemon named, plus the item's own tag, which it can name itself even on a daemon too old
 * to answer.
 */
export const closeShownTags = async (
  registration: Pick<ClearRegistration, 'getNotifications'>,
  tags: readonly string[],
  machine: PushMachine,
): Promise<number> => {
  let closed = 0;
  for (const tag of new Set(tags.map(each => shownTag(each, machine)))) {
    for (const notification of await registration.getNotifications({ tag })) {
      notification.close();
      closed += 1;
    }
  }
  return closed;
};
