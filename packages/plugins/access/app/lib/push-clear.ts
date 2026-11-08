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
 * `filteredPushNotification` answers for a muted push — and so does Mozilla's, once a small quota is spent (review
 * round 7). So wherever the service needs every push to show something, a clear REPLACES the item's notification with
 * one quiet "Handled on another device" line under the same tag (silent, no item words); where it finds nothing
 * showing, it shows that line once under a fixed per-machine tag, so lines never pile up. Only where the service is
 * known to let a push show nothing — FCM (Chrome, Android, Edge on Android) and WNS (Edge on Windows) — does a clear
 * just close the matching notifications.
 *
 * WHICH SERVICE IT IS is read from this registration's own push subscription endpoint, never from the user agent: an
 * iPad's says Mac, and Safari on a Mac has the same rule. A subscription that cannot be read, or a service not named
 * above, is treated as needing a line: a needless quiet line beats a revoked subscription.
 *
 * ## ONE MACHINE, ITS OWN TAGS
 *
 * A machine's worker turns each named tag into that machine's namespace (`fy-push:<daemonId>:<tag>`, the one
 * `machineNotification` shows under), so a clear can only ever take down what that same machine showed.
 */

import { type PushClearPayload, pushServiceAllowsSilent } from '../../contract/index.ts';
import { notificationBrand } from '../shell-pairing.ts';
import { machineHomeUrl, type PushMachine } from './push-scope.ts';

/** The fixed, per-machine tag the quiet line goes under when nothing of the item's was showing. */
export const HANDLED_TAG_PREFIX = 'fy-handled:';

/** The quiet line's words: the same whatever was handled, so no item words ever reach a lock screen through it. */
export const HANDLED_TITLE = 'Handled on another device';
export const HANDLED_BODY = 'Nothing to do here.';

/**
 * Whether the push service behind this registration needs every push to show something, from its subscription
 * endpoint (see the header; the services and their rules are `PUSH_SERVICE_ALLOWS_SILENT`'s). An unknown, absent or
 * unreadable endpoint needs one: a needless quiet line beats a revoked subscription.
 */
export const mustShowForEveryPush = (endpoint: string | null | undefined): boolean => {
  if (endpoint === null || endpoint === undefined) return true;
  const host = URL.parse(endpoint)?.hostname;
  return host === undefined || !pushServiceAllowsSilent(host);
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
    data: { url: machineHomeUrl(machine, origin), handled: true },
  },
});

/** The fixed tag one machine's quiet line goes under when nothing of the item's was showing. */
const handledTag = (machine: PushMachine | null): string =>
  `${HANDLED_TAG_PREFIX}${machine === null ? 'app' : encodeURIComponent(machine.daemonId)}`;

/** Whether a shown tag is one this machine's lines go under: its namespace, or its fixed quiet-line tag. */
const ownTag = (tag: string | undefined, machine: PushMachine | null): boolean =>
  tag !== undefined && (tag.startsWith(shownTag('', machine)) || tag === handledTag(machine));

/** What one clear does on this device: the shown tags to close, and the quiet line to show, if any. */
export interface ClearPlan {
  readonly close: readonly string[];
  readonly show?: ReturnType<typeof handledNotification>;
}

/**
 * THE DECISION, pure: given which of the clear's tags are showing here (as shown, in the clear's order) and whether
 * this registration's push service needs every push to show something.
 */
export const planClear = (
  showing: readonly string[],
  mustShow: boolean,
  machine: PushMachine | null,
  origin: string,
): ClearPlan => {
  if (!mustShow) return { close: showing };
  const [first, ...rest] = showing;
  if (first === undefined) {
    const fixed = handledTag(machine);
    return { close: [], show: handledNotification(machine, origin, fixed) };
  }
  // Shown under the first match's own tag, it REPLACES that notification; the rest are closed.
  return { close: rest, show: handledNotification(machine, origin, first) };
};

/** One notification showing, as a registration lists it: `timestamp` is when it was shown, where the browser says. */
export interface ShownNotification {
  close(): void;
  readonly timestamp?: number;
  readonly tag?: string;
  readonly data?: unknown;
}

/** The slice of a service-worker registration a clear needs. */
export interface ClearRegistration {
  getNotifications(options?: { tag: string }): PromiseLike<readonly ShownNotification[]>;
  showNotification(title: string, options?: NotificationOptions): PromiseLike<void>;
  readonly pushManager?: { getSubscription(): PromiseLike<{ readonly endpoint: string } | null> };
}

/** Whether this registration's push service needs every push to show something, read from its own subscription. */
const mustShowSomething = async (registration: ClearRegistration): Promise<boolean> => {
  try {
    return mustShowForEveryPush((await registration.pushManager?.getSubscription())?.endpoint);
  } catch {
    return true;
  }
};

/**
 * Shows the quiet line, then closes every OTHER quiet line this registration shows (review round 9): each item has its
 * own tag, so a line swapped under one item's tag would otherwise stay beside the next, and a phone would collect one
 * per handled item. The newest one is kept, so the push that showed it still showed something.
 */
const showHandled = async (
  registration: ClearRegistration,
  note: ReturnType<typeof handledNotification>,
  machine: PushMachine | null,
): Promise<void> => {
  await registration.showNotification(note.title, note.options);
  for (const shown of await registration.getNotifications()) {
    const handled = (shown.data as { readonly handled?: unknown } | null | undefined)?.handled === true;
    // Only this machine's own: the browser lists one registration's lines, but the guarantee is kept here too.
    if (handled && shown.tag !== note.options.tag && ownTag(shown.tag, machine)) shown.close();
  }
};

/** Carries one clear out on this registration: closes what it names, and shows the quiet line where its push service needs one. */
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
  const plan = planClear(showing, await mustShowSomething(registration), machine, origin);
  // The line is shown first: where a push must show something, the replacement is that something.
  if (plan.show !== undefined) await showHandled(registration, plan.show, machine);
  for (const [tag, notifications] of found) {
    if (!plan.close.includes(tag)) continue;
    for (const notification of notifications) notification.close();
  }
  return plan;
};

/** How long a clear is remembered in this worker: far longer than one push handler takes to read its filter and show. */
export const CLEARED_TAG_MEMORY_MS = 60_000;

/** What a push about to show under a tag must do (`RecentlyCleared.verdict`). */
export type ShowVerdict = 'show' | 'cleared' | 'superseded';

/**
 * THE ORDER PUSHES REACHED THIS WORKER, AND WHAT EACH CLEAR TOOK DOWN.
 *
 * A push and the clear that follows it can be handled at once in one worker, and a push handler awaits the filter
 * mirror before it shows anything: a clear handled in that gap finds nothing to close, and the push would then put the
 * stale line up after it. So:
 *
 * - every push takes its place in arrival order ({@link arrived}) before it awaits anything;
 * - showing and clearing run one at a time ({@link serial}), so a clear always sees a line a push put up;
 * - a clear remembers its tags with its own place, and a push about to show under one is settled as that clear would
 *   have settled it ONLY when the clear arrived after it ({@link verdict}). A push that arrives after the clear — the
 *   item woke again, a new number — is a newer line and shows as usual, and a stale push never touches a newer
 *   push's line under the same tag (`superseded`).
 *
 * In memory: a worker that stopped in between had no such race. A clear the push service delivers BEFORE the push it
 * clears is not caught: nothing on the wire tells a stale push from a newer one, and the clear carries no more.
 */
export class RecentlyCleared {
  #place = 0;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #cleared = new Map<string, Stamp>();
  /** The newest push that showed under each tag. */
  readonly #shown = new Map<string, Stamp>();

  constructor(private readonly now: () => number) {}

  /** A push event's place in this worker's arrival order. */
  arrived(): number {
    this.#place += 1;
    return this.#place;
  }

  /** Runs one show or one clear after every earlier one: never two at once. A failure does not stop the next. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** A clear at `place` took these shown tags down. */
  remember(tags: readonly string[], place: number): void {
    const at = this.now();
    for (const stamps of [this.#cleared, this.#shown])
      for (const [tag, stamp] of stamps) if (at - stamp.at > CLEARED_TAG_MEMORY_MS) stamps.delete(tag);
    for (const tag of tags) this.#cleared.set(tag, { place, at });
  }

  /**
   * What the push at `place` does under `tag`: `show`; `cleared` when a clear that arrived after it took the tag down;
   * `superseded` when, after that clear, a newer push already showed its own line there.
   */
  verdict(tag: string, place: number): ShowVerdict {
    const cleared = this.#fresh(this.#cleared, tag);
    if (cleared === undefined || cleared.place <= place) return 'show';
    const shown = this.#fresh(this.#shown, tag);
    return shown !== undefined && shown.place > cleared.place ? 'superseded' : 'cleared';
  }

  /** The push at `place` showed under `tag`. */
  showed(tag: string, place: number): void {
    const shown = this.#shown.get(tag);
    if (shown === undefined || shown.place < place) this.#shown.set(tag, { place, at: this.now() });
  }

  #fresh(stamps: Map<string, Stamp>, tag: string): Stamp | undefined {
    const stamp = stamps.get(tag);
    return stamp !== undefined && this.now() - stamp.at <= CLEARED_TAG_MEMORY_MS ? stamp : undefined;
  }
}

interface Stamp {
  readonly place: number;
  readonly at: number;
}

/**
 * A push at `place` about to show under `tag` (inside {@link RecentlyCleared.serial}): settled as a later clear would
 * have, instead of showing — where a push must show something, the quiet line under the tag (or under the fixed tag when a newer push
 * owns it, or nothing is under it), elsewhere nothing. Answers whether it was; `false` means show it, and it is
 * recorded as shown.
 */
export const settleIfCleared = async (
  registration: ClearRegistration,
  tag: string,
  recent: RecentlyCleared,
  place: number,
  machine: PushMachine | null,
  origin: string,
): Promise<boolean> => {
  const verdict = recent.verdict(tag, place);
  if (verdict === 'show') {
    recent.showed(tag, place);
    return false;
  }
  // Only the clear's own quiet line can be under a cleared tag here; a newer push's line is never touched.
  const showing = verdict === 'cleared' ? await registration.getNotifications({ tag }) : [];
  const plan = planClear(showing.length > 0 ? [tag] : [], await mustShowSomething(registration), machine, origin);
  if (plan.show !== undefined) await showHandled(registration, plan.show, machine);
  return true;
};

/**
 * THE PAGE'S HALF: the owner opened an item here, so this device takes its own lines for it down. The daemon's clear
 * skipped this device (so it never swaps them for "Handled on another device" on the phone in the owner's hand); the
 * page closes the tags the daemon named, plus the item's own tag, which it can name itself even on a daemon too old
 * to answer.
 *
 * With `shownBy`, only a line shown at or before that moment is closed: the daemon's answer arrives later, and a
 * newer line under one of its tags (a new stop, after the next item was raised) is not the one the open saw. A line
 * whose browser gives no `timestamp` is left up then: losing a newer alert is worse than keeping an old one.
 */
export const closeShownTags = async (
  registration: Pick<ClearRegistration, 'getNotifications'>,
  tags: readonly string[],
  machine: PushMachine,
  shownBy?: number,
): Promise<number> => {
  let closed = 0;
  for (const tag of new Set(tags.map(each => shownTag(each, machine)))) {
    for (const notification of await registration.getNotifications({ tag })) {
      if (shownBy !== undefined && !(typeof notification.timestamp === 'number' && notification.timestamp <= shownBy))
        continue;
      notification.close();
      closed += 1;
    }
  }
  return closed;
};
