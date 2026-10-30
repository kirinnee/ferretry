/**
 * THE CLIENT-SIDE NOTIFICATION FILTER — one device's own decision, nothing the daemon stores.
 *
 * `packages/daemon/src/lib/push/service.ts` sends every enrolled device every event now: there is no
 * server-stored preference left to consult (see `docs/standards` and `push/policy.ts`'s own doc
 * comment). "Every machine sends every event; each device decides what to show" (the owner-approved
 * spec) means the decision has to live somewhere, and this is that somewhere — a pure function over
 * one event, this browser's own local preferences, and the current instant.
 *
 * FOUR SWITCHES, NOT FIVE KINDS. The protocol's `PushNotificationKind` has five values because two of
 * them — `attention` and `question` — are both "a session is waiting on a person", just with
 * different body text. The Settings screen offers exactly the four switches the spec names (needs
 * you, finished, failed, new device), so `notificationCategoryFor` is the one place that collapses
 * the wire's five kinds onto the UI's four categories; nothing else in the app needs to know the
 * collapse happened.
 *
 * QUIET HOURS CAN WRAP MIDNIGHT. A window from 22:00 to 07:00 has its start AFTER its end on the
 * 0–1439 minute-of-day line, so `isWithinQuietHours` treats `start > end` as "wraps around
 * midnight" rather than as an empty range. `start === end` is read as the full day: a reader who set
 * identical start and end asked for quiet always, not for a window of zero width that can never be
 * open.
 *
 * "PER MACHINE ON/OFF" IS A DISPLAY FILTER, NOT A SUBSCRIPTION SWITCH. `DaemonNotificationPreferences`
 * already has an `enabled` flag per daemon that gates the Web Push *subscription* itself (asking the
 * browser for permission, creating and revoking an endpoint) — that machinery is unrelated to this
 * file and untouched by it. `machines` here is the lighter-weight twin the Settings screen's
 * per-machine list toggles: a reader may be subscribed to a machine's pushes yet still not want them
 * shown, the same way they can switch off `failed` without unsubscribing from anything. A daemon id
 * absent from the map is on, so a newly paired machine is heard from immediately.
 *
 * WHERE THIS IS APPLIED. The in-app live watch (`notification-ledger.ts`) calls this directly on
 * every transition it is about to show, because the page already holds this device's preferences in
 * memory. The service worker's `push` handler (`worker/service-worker.ts`) calls the SAME function
 * too, but cannot read `localStorage` at all — a service worker has no DOM storage — so every write
 * this store makes is also mirrored into IndexedDB (`notification-filter-mirror.ts`), which both
 * contexts can reach. A push the filter would hide still has to show SOMETHING: a push that is
 * received but shows nothing is a pattern browsers can revoke a subscription over. The worker's own
 * comment names the least-bad compliant answer it picked.
 */

import type { PushNotificationKind } from '@ferretry/protocol';
import type { NotificationFilterMirrorWriter } from './notification-filter-mirror.ts';

/**
 * Every protocol notification kind, exhaustively. `notificationCategoryFor` below is the real
 * classifier; this witness exists so that a kind FUTURE protocol change adds, and nobody taught a
 * category to, fails the build rather than silently falling through. Also doubles as the PWA half of
 * the `push-notification-kinds` closed-set agreement with `@ferretry/protocol`'s
 * `PushNotificationKindSchema` (`scripts/validate/closed-set-agreement.ts`).
 */
const NOTIFICATION_KIND_FIELDS = {
  attention: true,
  agenda: true,
  question: true,
  completed: true,
  failed: true,
  'device-paired': true,
} as const satisfies { readonly [K in PushNotificationKind]: true };

/** Every protocol notification kind. */
export const ALL_NOTIFICATION_KINDS: readonly PushNotificationKind[] = Object.keys(
  NOTIFICATION_KIND_FIELDS,
) as PushNotificationKind[];

/** The four switches the Settings screen exposes, in the owner-approved spec's own order. */
export const NOTIFICATION_CATEGORIES = ['needs-you', 'finished', 'failed', 'new-device'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CATEGORY_COPY: Record<
  NotificationCategory,
  { readonly label: string; readonly description: string }
> = {
  'needs-you': { label: 'Needs you', description: 'A session is waiting on you — a prompt or a question.' },
  finished: { label: 'Finished', description: 'A session completed its task.' },
  failed: { label: 'Failed', description: 'A session failed, stalled, or could not be stopped.' },
  'new-device': { label: 'New device', description: 'Another browser was paired with this machine.' },
};

/**
 * Collapses the wire's five notification kinds onto the four switches a reader is shown.
 *
 * `attention` and `question` are both "a session needs a person", so both read as `needs-you`; every
 * other kind already names exactly one category.
 */
export function notificationCategoryFor(kind: PushNotificationKind): NotificationCategory {
  switch (kind) {
    case 'attention':
    case 'agenda':
    case 'question':
      return 'needs-you';
    case 'completed':
      return 'finished';
    case 'failed':
      return 'failed';
    case 'device-paired':
      return 'new-device';
  }
}

export type NotificationCategoryPrefs = Readonly<Record<NotificationCategory, boolean>>;

const MINUTES_PER_DAY = 1_440;

export interface QuietHours {
  readonly enabled: boolean;
  /** Local minutes since midnight, `0`–`1439`. Meaningless while `enabled` is false. */
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface DeviceNotificationFilterPreferences {
  readonly categories: NotificationCategoryPrefs;
  readonly quietHours: QuietHours;
  /** Keyed by `DaemonId` (as a plain string). Absent means on — see the module doc above. */
  readonly machines: Readonly<Record<string, boolean>>;
}

export const DEFAULT_QUIET_HOURS: QuietHours = Object.freeze({ enabled: false, startMinute: 0, endMinute: 0 });

const DEFAULT_CATEGORIES: NotificationCategoryPrefs = Object.freeze({
  'needs-you': true,
  finished: true,
  failed: true,
  'new-device': true,
});

const DEFAULT_MACHINES: Readonly<Record<string, boolean>> = Object.freeze({});

/** Safe defaults: everything on, no quiet hours — a reader who never opened Settings hears everything. */
export const DEFAULT_NOTIFICATION_FILTER_PREFERENCES: DeviceNotificationFilterPreferences = Object.freeze({
  categories: DEFAULT_CATEGORIES,
  quietHours: DEFAULT_QUIET_HOURS,
  machines: DEFAULT_MACHINES,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMinute = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MINUTES_PER_DAY;

/** "HH:MM" (24-hour) to minutes since local midnight, or `null` for anything else. */
export function parseTimeOfDay(value: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes since local midnight to "HH:MM". Out-of-range input wraps rather than throwing. */
export function formatTimeOfDay(minute: number): string {
  const normalised = Number.isFinite(minute) ? Math.trunc(minute) : 0;
  const wrapped = ((normalised % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Whether `now` falls inside a quiet window that may wrap midnight.
 *
 * `start === end` reads as quiet all day: a reader who set identical bounds asked for quiet always,
 * not for a zero-width window that could never open.
 */
export function isWithinQuietHours(quiet: QuietHours, now: Date): boolean {
  if (!quiet.enabled) return false;
  if (quiet.startMinute === quiet.endMinute) return true;
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  return quiet.startMinute < quiet.endMinute
    ? minuteOfDay >= quiet.startMinute && minuteOfDay < quiet.endMinute
    : minuteOfDay >= quiet.startMinute || minuteOfDay < quiet.endMinute;
}

export interface NotificationFilterEvent {
  /** `null` is an unclassified payload — an enrolment confirmation — and is always shown. */
  readonly kind: PushNotificationKind | null;
  /** The daemon id (as a string) the event is about, or `null` for one tied to no machine. */
  readonly daemonId: string | null;
}

/**
 * THE decision: given one event, this device's preferences, and the instant it arrived, show it or
 * not. Total and pure — no storage, no browser global, no daemon.
 */
export function shouldShowNotification(
  event: NotificationFilterEvent,
  prefs: DeviceNotificationFilterPreferences,
  now: Date,
): boolean {
  if (event.kind !== null && !prefs.categories[notificationCategoryFor(event.kind)]) return false;
  if (event.daemonId !== null && prefs.machines[event.daemonId] === false) return false;
  return !isWithinQuietHours(prefs.quietHours, now);
}

/* ---------- persistence: one device-wide record, never per-daemon -------------------------------- */

export const NOTIFICATION_FILTER_PREFERENCES_KEY = 'fy-pwa-notification-filter-v1';

const copyDefaults = (): DeviceNotificationFilterPreferences => ({
  categories: { ...DEFAULT_NOTIFICATION_FILTER_PREFERENCES.categories },
  quietHours: { ...DEFAULT_NOTIFICATION_FILTER_PREFERENCES.quietHours },
  machines: { ...DEFAULT_NOTIFICATION_FILTER_PREFERENCES.machines },
});

/** A cap on how many daemon ids this record remembers an OFF for; a reader pairs with few machines. */
const MAX_REMEMBERED_MACHINES = 200;

const parseMachines = (value: unknown): Readonly<Record<string, boolean>> => {
  if (!isRecord(value)) return {};
  const machines: Record<string, boolean> = {};
  for (const [daemonId, state] of Object.entries(value)) {
    if (daemonId.trim() === '' || typeof state !== 'boolean') continue;
    if (Object.keys(machines).length >= MAX_REMEMBERED_MACHINES) break;
    machines[daemonId] = state;
  }
  return machines;
};

const parseQuietHours = (value: unknown): QuietHours => {
  if (!isRecord(value)) return { ...DEFAULT_QUIET_HOURS };
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_QUIET_HOURS.enabled,
    startMinute: isMinute(value.startMinute) ? value.startMinute : DEFAULT_QUIET_HOURS.startMinute,
    endMinute: isMinute(value.endMinute) ? value.endMinute : DEFAULT_QUIET_HOURS.endMinute,
  };
};

const parseCategories = (value: unknown): NotificationCategoryPrefs => {
  const raw = isRecord(value) ? value : {};
  const categories = {} as Record<NotificationCategory, boolean>;
  for (const category of NOTIFICATION_CATEGORIES) {
    const current = raw[category];
    categories[category] = typeof current === 'boolean' ? current : DEFAULT_CATEGORIES[category];
  }
  return categories;
};

/** Decode a persisted record without allowing one malformed field to poison it. Never throws. */
export const parseNotificationFilterPreferences = (raw: string | null): DeviceNotificationFilterPreferences => {
  if (raw === null) return copyDefaults();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return copyDefaults();
  }
  if (!isRecord(parsed) || parsed.version !== 1) return copyDefaults();
  return {
    categories: parseCategories(parsed.categories),
    quietHours: parseQuietHours(parsed.quietHours),
    machines: parseMachines(parsed.machines),
  };
};

export type NotificationFilterPatch = Readonly<{
  categories?: Readonly<Partial<Record<NotificationCategory, boolean>>>;
  quietHours?: Readonly<Partial<QuietHours>>;
  /** One daemon id at a time; an existing row for a different id is left alone. */
  machines?: Readonly<Record<string, boolean>>;
}>;

const mergeNotificationFilterPreferences = (
  current: DeviceNotificationFilterPreferences,
  patch: NotificationFilterPatch,
): DeviceNotificationFilterPreferences => {
  const categories = { ...current.categories };
  for (const category of NOTIFICATION_CATEGORIES) {
    const value = patch.categories?.[category];
    if (typeof value === 'boolean') categories[category] = value;
  }
  const quietPatch = patch.quietHours;
  const quietHours: QuietHours = {
    enabled: typeof quietPatch?.enabled === 'boolean' ? quietPatch.enabled : current.quietHours.enabled,
    startMinute: isMinute(quietPatch?.startMinute) ? quietPatch.startMinute : current.quietHours.startMinute,
    endMinute: isMinute(quietPatch?.endMinute) ? quietPatch.endMinute : current.quietHours.endMinute,
  };
  const machines = { ...current.machines };
  for (const [daemonId, state] of Object.entries(patch.machines ?? {})) {
    if (daemonId.trim() === '') continue;
    if (typeof state === 'boolean') machines[daemonId] = state;
  }
  return { categories, quietHours, machines };
};

export interface NotificationFilterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * A synchronously readable external store holding one device-wide snapshot.
 *
 * The record as a whole is NOT keyed by `DaemonId`, unlike `DaemonNotificationPreferences`: which
 * event kinds show and when quiet hours apply are decisions about THIS BROWSER, made once, not once
 * per pairing. `machines` inside it is the one per-daemon exception — see the module doc above — and
 * it still lives in this one record because it is read by the same pure function on the same tick.
 * The snapshot is identity-stable between real changes, which is what `useSyncExternalStore` requires.
 */
export class DeviceNotificationFilterStore {
  readonly #storage: NotificationFilterStorage | null;
  readonly #mirror: NotificationFilterMirrorWriter | null;
  readonly #listeners = new Set<() => void>();
  #snapshot: DeviceNotificationFilterPreferences;

  constructor(storage: NotificationFilterStorage | null = null, mirror: NotificationFilterMirrorWriter | null = null) {
    this.#storage = storage;
    this.#mirror = mirror;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(NOTIFICATION_FILTER_PREFERENCES_KEY) ?? null;
    } catch {
      // Denied storage is an ordinary browser mode; memory state still works.
    }
    this.#snapshot = parseNotificationFilterPreferences(raw);
  }

  /** Bound so it can be handed straight to `useSyncExternalStore`. */
  readonly get = (): DeviceNotificationFilterPreferences => this.#snapshot;

  set(patch: NotificationFilterPatch): DeviceNotificationFilterPreferences {
    const next = mergeNotificationFilterPreferences(this.#snapshot, patch);
    this.#snapshot = next;
    this.#persist(next);
    // Fire-and-forget: the worker reads whatever the mirror last held, and `localStorage` above is
    // already the correct, durable answer for this page regardless of whether this write lands.
    void this.#mirror?.write(next).catch(() => undefined);
    for (const listener of [...this.#listeners]) listener();
    return next;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #persist(value: DeviceNotificationFilterPreferences): void {
    if (this.#storage === null) return;
    try {
      this.#storage.setItem(NOTIFICATION_FILTER_PREFERENCES_KEY, JSON.stringify({ version: 1, ...value }));
    } catch {
      // Private mode and exhausted quota must not break the live store.
    }
  }
}
