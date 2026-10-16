import { describe, expect, it } from 'bun:test';

import {
  ALL_NOTIFICATION_KINDS,
  DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
  DEFAULT_QUIET_HOURS,
  type DeviceNotificationFilterPreferences,
  DeviceNotificationFilterStore,
  formatTimeOfDay,
  isWithinQuietHours,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_FILTER_PREFERENCES_KEY,
  notificationCategoryFor,
  parseNotificationFilterPreferences,
  parseTimeOfDay,
  shouldShowNotification,
} from '../../src/lib/notification-filter.ts';

const prefs = (over: Partial<DeviceNotificationFilterPreferences> = {}): DeviceNotificationFilterPreferences => ({
  categories: { ...DEFAULT_NOTIFICATION_FILTER_PREFERENCES.categories },
  quietHours: { ...DEFAULT_QUIET_HOURS },
  machines: {},
  ...over,
});

const at = (hour: number, minute: number): Date => {
  const now = new Date(2026, 0, 1, hour, minute, 0, 0);
  return now;
};

describe('notificationCategoryFor', () => {
  it('collapses the five wire kinds onto exactly four categories', () => {
    expect(notificationCategoryFor('attention')).toBe('needs-you');
    expect(notificationCategoryFor('question')).toBe('needs-you');
    expect(notificationCategoryFor('completed')).toBe('finished');
    expect(notificationCategoryFor('failed')).toBe('failed');
    expect(notificationCategoryFor('device-paired')).toBe('new-device');
  });

  it('names every protocol kind, so a schema addition cannot fall through silently', () => {
    for (const kind of ALL_NOTIFICATION_KINDS) expect(NOTIFICATION_CATEGORIES).toContain(notificationCategoryFor(kind));
  });
});

describe('parseTimeOfDay / formatTimeOfDay', () => {
  it('round-trips every boundary time of day', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('23:59')).toBe(1_439);
    expect(parseTimeOfDay('09:05')).toBe(545);
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(1_439)).toBe('23:59');
    expect(formatTimeOfDay(545)).toBe('09:05');
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseTimeOfDay(' 07:30 ')).toBe(450);
  });

  it('rejects anything that is not a valid 24-hour HH:MM', () => {
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('12:60')).toBeNull();
    expect(parseTimeOfDay('noon')).toBeNull();
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay('1:2:3')).toBeNull();
  });

  it('wraps out-of-range and non-finite minutes instead of throwing', () => {
    expect(formatTimeOfDay(1_440)).toBe('00:00');
    expect(formatTimeOfDay(-30)).toBe('23:30');
    expect(formatTimeOfDay(Number.NaN)).toBe('00:00');
    expect(formatTimeOfDay(90.9)).toBe('01:30');
  });
});

describe('isWithinQuietHours', () => {
  it('is never quiet while disabled', () => {
    expect(isWithinQuietHours({ enabled: false, startMinute: 0, endMinute: 1 }, at(0, 30))).toBe(false);
  });

  it('reads identical bounds as quiet all day', () => {
    const quiet = { enabled: true, startMinute: 90, endMinute: 90 };
    expect(isWithinQuietHours(quiet, at(0, 0))).toBe(true);
    expect(isWithinQuietHours(quiet, at(23, 59))).toBe(true);
  });

  it('treats a same-day window as a plain range', () => {
    const quiet = { enabled: true, startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(isWithinQuietHours(quiet, at(9, 0))).toBe(true);
    expect(isWithinQuietHours(quiet, at(12, 0))).toBe(true);
    expect(isWithinQuietHours(quiet, at(16, 59))).toBe(true);
    expect(isWithinQuietHours(quiet, at(17, 0))).toBe(false);
    expect(isWithinQuietHours(quiet, at(8, 59))).toBe(false);
  });

  it('wraps past midnight when the start is after the end', () => {
    const quiet = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 };
    expect(isWithinQuietHours(quiet, at(22, 0))).toBe(true);
    expect(isWithinQuietHours(quiet, at(23, 59))).toBe(true);
    expect(isWithinQuietHours(quiet, at(0, 0))).toBe(true);
    expect(isWithinQuietHours(quiet, at(6, 59))).toBe(true);
    expect(isWithinQuietHours(quiet, at(7, 0))).toBe(false);
    expect(isWithinQuietHours(quiet, at(21, 59))).toBe(false);
  });
});

describe('shouldShowNotification', () => {
  it('shows an unclassified payload whatever the category switches say', () => {
    const silenced = prefs({
      categories: { 'needs-you': false, finished: false, failed: false, 'new-device': false },
    });
    expect(shouldShowNotification({ kind: null, daemonId: null }, silenced, at(12, 0))).toBe(true);
  });

  it('still mutes an unclassified payload during quiet hours — quiet hours is total, not per-kind', () => {
    const quiet = prefs({ quietHours: { enabled: true, startMinute: 0, endMinute: 0 } });
    expect(shouldShowNotification({ kind: null, daemonId: null }, quiet, at(12, 0))).toBe(false);
  });

  it('refuses a kind whose category switch is off', () => {
    const prefsOff = prefs({ categories: { ...DEFAULT_NOTIFICATION_FILTER_PREFERENCES.categories, failed: false } });
    expect(shouldShowNotification({ kind: 'failed', daemonId: 'daemon-a' }, prefsOff, at(12, 0))).toBe(false);
    expect(shouldShowNotification({ kind: 'completed', daemonId: 'daemon-a' }, prefsOff, at(12, 0))).toBe(true);
  });

  it('refuses a daemon this device muted, and nothing else', () => {
    const muted = prefs({ machines: { 'daemon-b': false } });
    expect(shouldShowNotification({ kind: 'attention', daemonId: 'daemon-b' }, muted, at(12, 0))).toBe(false);
    expect(shouldShowNotification({ kind: 'attention', daemonId: 'daemon-a' }, muted, at(12, 0))).toBe(true);
  });

  it('treats an absent machine row as on, so a freshly paired daemon is heard', () => {
    expect(shouldShowNotification({ kind: 'attention', daemonId: 'brand-new-daemon' }, prefs(), at(12, 0))).toBe(true);
  });

  it('skips the machine check entirely for an event tied to no daemon', () => {
    const muted = prefs({ machines: { 'daemon-a': false } });
    expect(shouldShowNotification({ kind: 'device-paired', daemonId: null }, muted, at(12, 0))).toBe(true);
  });

  it('refuses everything during quiet hours, even a kind that is switched on', () => {
    const quiet = prefs({ quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 } });
    expect(shouldShowNotification({ kind: 'attention', daemonId: 'daemon-a' }, quiet, at(23, 0))).toBe(false);
    expect(shouldShowNotification({ kind: 'attention', daemonId: 'daemon-a' }, quiet, at(12, 0))).toBe(true);
  });
});

describe('parseNotificationFilterPreferences', () => {
  it('answers safe defaults for an absent record', () => {
    expect(parseNotificationFilterPreferences(null)).toEqual(DEFAULT_NOTIFICATION_FILTER_PREFERENCES);
  });

  it('answers safe defaults for malformed JSON, a non-record, and the wrong version', () => {
    expect(parseNotificationFilterPreferences('{')).toEqual(DEFAULT_NOTIFICATION_FILTER_PREFERENCES);
    expect(parseNotificationFilterPreferences('"a string"')).toEqual(DEFAULT_NOTIFICATION_FILTER_PREFERENCES);
    expect(parseNotificationFilterPreferences(JSON.stringify({ version: 2 }))).toEqual(
      DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
    );
  });

  it('round-trips a complete, well-shaped record', () => {
    const value: DeviceNotificationFilterPreferences = {
      categories: { 'needs-you': true, finished: false, failed: true, 'new-device': false },
      quietHours: { enabled: true, startMinute: 60, endMinute: 120 },
      machines: { 'daemon-a': false },
    };
    expect(parseNotificationFilterPreferences(JSON.stringify({ version: 1, ...value }))).toEqual(value);
  });

  it('falls back field by field rather than discarding the whole record', () => {
    const parsed = parseNotificationFilterPreferences(
      JSON.stringify({
        version: 1,
        categories: { 'needs-you': 'yes', finished: false },
        quietHours: { enabled: true, startMinute: -1, endMinute: 9_000 },
        machines: { 'daemon-a': true, '': true, 'daemon-b': 'not a boolean', empty: null },
      }),
    );
    expect(parsed.categories).toEqual({ 'needs-you': true, finished: false, failed: true, 'new-device': true });
    expect(parsed.quietHours).toEqual({ enabled: true, startMinute: 0, endMinute: 0 });
    expect(parsed.machines).toEqual({ 'daemon-a': true });
  });

  it('answers defaults when categories, quietHours or machines are not records', () => {
    const parsed = parseNotificationFilterPreferences(
      JSON.stringify({ version: 1, categories: 'nope', quietHours: 'nope', machines: 'nope' }),
    );
    expect(parsed).toEqual(DEFAULT_NOTIFICATION_FILTER_PREFERENCES);
  });

  it('caps how many machine rows one record remembers', () => {
    const many = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`daemon-${index}`, false]));
    const parsed = parseNotificationFilterPreferences(JSON.stringify({ version: 1, machines: many }));
    expect(Object.keys(parsed.machines)).toHaveLength(200);
  });
});

describe('DeviceNotificationFilterStore', () => {
  const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
  };

  it('hydrates from storage and answers the stable default object without one', () => {
    const bare = new DeviceNotificationFilterStore();
    expect(bare.get()).toEqual(DEFAULT_NOTIFICATION_FILTER_PREFERENCES);

    const storage = memoryStorage();
    storage.setItem(
      NOTIFICATION_FILTER_PREFERENCES_KEY,
      JSON.stringify({ version: 1, ...prefs({ machines: { 'daemon-a': false } }) }),
    );
    const hydrated = new DeviceNotificationFilterStore(storage);
    expect(hydrated.get().machines).toEqual({ 'daemon-a': false });
  });

  it('merges a patch, persists it, and notifies every subscriber', () => {
    const storage = memoryStorage();
    const store = new DeviceNotificationFilterStore(storage);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    const next = store.set({ categories: { failed: false }, machines: { 'daemon-a': false } });

    expect(next.categories.failed).toBe(false);
    expect(next.categories['needs-you']).toBe(true);
    expect(next.machines).toEqual({ 'daemon-a': false });
    expect(notified).toBe(1);
    expect(parseNotificationFilterPreferences(storage.values.get(NOTIFICATION_FILTER_PREFERENCES_KEY) ?? null)).toEqual(
      next,
    );

    unsubscribe();
    store.set({ quietHours: { enabled: true } });
    expect(notified).toBe(1);
  });

  it('merges quiet-hours fields independently, keeping the ones not patched', () => {
    const store = new DeviceNotificationFilterStore();
    store.set({ quietHours: { enabled: true, startMinute: 60 } });
    const next = store.set({ quietHours: { endMinute: 120 } });
    expect(next.quietHours).toEqual({ enabled: true, startMinute: 60, endMinute: 120 });
  });

  it('merges one machine at a time, leaving an existing row for a different daemon alone', () => {
    const store = new DeviceNotificationFilterStore();
    store.set({ machines: { 'daemon-a': false } });
    const next = store.set({ machines: { 'daemon-b': false } });
    expect(next.machines).toEqual({ 'daemon-a': false, 'daemon-b': false });
  });

  it('ignores a blank daemon id in a patch', () => {
    const store = new DeviceNotificationFilterStore();
    const next = store.set({ machines: { '': false } });
    expect(next.machines).toEqual({});
  });

  it('survives a storage that throws on read or write', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const store = new DeviceNotificationFilterStore(throwing);
    expect(store.get()).toEqual(DEFAULT_NOTIFICATION_FILTER_PREFERENCES);
    expect(store.set({ categories: { failed: false } }).categories.failed).toBe(false);
  });
});
