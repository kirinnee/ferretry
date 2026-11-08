import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_NOTIFICATION_FILTER_DOCUMENT,
  MINUTES_PER_DAY,
  NOTIFICATION_FILTER_DB,
  NOTIFICATION_FILTER_DB_VERSION,
  NOTIFICATION_FILTER_KEY,
  NOTIFICATION_FILTER_STORE,
  type NotificationFilterDocument,
  readNotificationFilterDocument,
  shouldShowPush,
} from '../../../contract/notification-filter.ts';

const doc = (over: Partial<NotificationFilterDocument> = {}): NotificationFilterDocument => ({
  version: 2,
  hiddenKinds: [],
  mutedDaemons: [],
  quietHours: { enabled: false, startMinute: 0, endMinute: 0 },
  ...over,
});
/** A local instant at `hour:minute`: quiet hours are read in the device's own time. */
/** The stored encoding: the document's JSON text, as Agenda's mirror writes it. */
const stored = (value: unknown): string => JSON.stringify(value);
const at = (hour: number, minute: number): Date => new Date(2026, 0, 1, hour, minute, 0, 0);
const quiet = (startMinute: number, endMinute: number, enabled = true): NotificationFilterDocument =>
  doc({ quietHours: { enabled, startMinute, endMinute } });
const show = (d: NotificationFilterDocument, now: Date, kind: string | null = 'agenda', daemon: string | null = 'a') =>
  shouldShowPush(d, { kind, daemon }, now);

describe('where the document lives', () => {
  test('the names are the ones Agenda’s mirror uses today, so the database is not renamed', () => {
    expect([NOTIFICATION_FILTER_DB, NOTIFICATION_FILTER_STORE, NOTIFICATION_FILTER_KEY]).toEqual([
      'ferretry-notification-filter',
      'mirror',
      'preferences',
    ]);
    expect(NOTIFICATION_FILTER_DB_VERSION).toBe(1);
    expect(MINUTES_PER_DAY).toBe(1_440);
  });
});

describe('readNotificationFilterDocument', () => {
  test('the default shows everything, mutes nothing and has no quiet hours, and is frozen', () => {
    expect(DEFAULT_NOTIFICATION_FILTER_DOCUMENT).toEqual(doc());
    expect(Object.isFrozen(DEFAULT_NOTIFICATION_FILTER_DOCUMENT)).toBe(true);
    expect(Object.isFrozen(DEFAULT_NOTIFICATION_FILTER_DOCUMENT.hiddenKinds)).toBe(true);
    for (const kind of ['agenda', 'failed', null])
      for (const hour of [0, 12, 23]) expect(show(DEFAULT_NOTIFICATION_FILTER_DOCUMENT, at(hour, 0), kind)).toBe(true);
  });

  test('a v2 string reads as its document, and comes back frozen', () => {
    const written = doc({
      hiddenKinds: ['failed'],
      mutedDaemons: ['daemon-b'],
      quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 },
    });
    expect(readNotificationFilterDocument(stored(written))).toEqual(written);
    expect(Object.isFrozen(readNotificationFilterDocument(stored(written)).mutedDaemons)).toBe(true);
  });

  test('the stored encoding is JSON text: the same document as a structured record reads as the default', () => {
    const written = doc({ hiddenKinds: ['failed'] });
    expect(readNotificationFilterDocument(written)).toBe(DEFAULT_NOTIFICATION_FILTER_DOCUMENT);
    // an array whose only element is the text, and an object whose text IS the document, are still not the encoding
    expect(readNotificationFilterDocument([stored(written)])).toBe(DEFAULT_NOTIFICATION_FILTER_DOCUMENT);
    expect(readNotificationFilterDocument({ toString: () => stored(written) })).toBe(
      DEFAULT_NOTIFICATION_FILTER_DOCUMENT,
    );
    for (const raw of [undefined, null, 0, true, [], {}])
      expect(readNotificationFilterDocument(raw)).toBe(DEFAULT_NOTIFICATION_FILTER_DOCUMENT);
  });

  test('a v1 string (today’s category-shaped mirror) reads as the default until Agenda rewrites it', () => {
    const v1 = {
      version: 1,
      categories: { 'needs-you': false, finished: true, failed: false, 'new-device': true },
      quietHours: { enabled: true, startMinute: 0, endMinute: 0 },
      machines: { 'daemon-a': false },
    };
    expect(readNotificationFilterDocument(stored(v1))).toBe(DEFAULT_NOTIFICATION_FILTER_DOCUMENT);
  });

  test('garbage, an unknown key, and ONE over-bound field anywhere reset the whole document to the default', () => {
    for (const raw of ['', 'not json', '{', 'null', '42', '[]', '{}', '"text"'])
      expect(readNotificationFilterDocument(raw)).toBe(DEFAULT_NOTIFICATION_FILTER_DOCUMENT);
    for (const value of [
      { ...doc(), extra: true },
      doc({ hiddenKinds: Array.from({ length: 65 }, (_, i) => `k${i}`) }),
      doc({ mutedDaemons: Array.from({ length: 201 }, (_, i) => `d${i}`) }),
      doc({ mutedDaemons: [''] }),
      doc({ mutedDaemons: ['x'.repeat(201)] }),
      doc({ hiddenKinds: ['clear'] }),
      doc({ hiddenKinds: ['Failed'] }),
      quiet(0, MINUTES_PER_DAY),
      quiet(-1, 0),
      quiet(1.5, 0),
      { ...doc(), quietHours: { enabled: true, startMinute: 0, endMinute: 0, extra: 1 } },
      { ...doc(), version: 3 },
      { ...doc(), version: 1 },
      { ...doc(), hiddenKinds: 'failed' },
    ])
      expect(readNotificationFilterDocument(stored(value))).toBe(DEFAULT_NOTIFICATION_FILTER_DOCUMENT);
  });

  test('the bounds themselves read: 64 kinds, 200 machines of 200 characters, minutes 0 and 1439', () => {
    const full = doc({
      hiddenKinds: Array.from({ length: 64 }, (_, i) => `k${i}`),
      mutedDaemons: Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(200, 'd')),
      quietHours: { enabled: true, startMinute: 0, endMinute: MINUTES_PER_DAY - 1 },
    });
    expect(readNotificationFilterDocument(stored(full))).toEqual(full);
  });

  test('it is total: a deeply nested string and a throwing value never throw', () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    expect(readNotificationFilterDocument(deep)).toBe(DEFAULT_NOTIFICATION_FILTER_DOCUMENT);
    const throwing = {
      toString: () => {
        throw new Error('boom');
      },
    };
    expect(readNotificationFilterDocument(throwing)).toBe(DEFAULT_NOTIFICATION_FILTER_DOCUMENT);
  });
});

describe('shouldShowPush: kinds and machines', () => {
  test('a hidden kind hides, and only that kind', () => {
    const hidden = doc({ hiddenKinds: ['failed'] });
    expect(show(hidden, at(12, 0), 'failed')).toBe(false);
    expect(show(hidden, at(12, 0), 'completed')).toBe(true);
  });

  test('a push with no kind is never hidden by kind', () => {
    expect(
      show(doc({ hiddenKinds: ['agenda', 'question', 'failed', 'completed', 'device-paired'] }), at(12, 0), null),
    ).toBe(true);
  });

  test('a muted daemon hides, and nothing else; an unlisted daemon is heard', () => {
    const muted = doc({ mutedDaemons: ['daemon-b'] });
    expect(show(muted, at(12, 0), 'agenda', 'daemon-b')).toBe(false);
    expect(show(muted, at(12, 0), 'agenda', 'daemon-a')).toBe(true);
    expect(show(muted, at(12, 0), 'agenda', 'brand-new-daemon')).toBe(true);
  });

  test('a push tied to no daemon is never muted', () => {
    expect(show(doc({ mutedDaemons: ['daemon-a'] }), at(12, 0), 'device-paired', null)).toBe(true);
  });
});

describe('shouldShowPush: quiet hours (today’s isWithinQuietHours cases)', () => {
  test('disabled never hides', () => {
    expect(show(quiet(0, 1, false), at(0, 0))).toBe(true);
    expect(show(quiet(0, 0, false), at(12, 0))).toBe(true);
  });

  test('start === end while enabled is quiet all day', () => {
    for (const [hour, minute] of [
      [0, 0],
      [1, 30],
      [12, 0],
      [23, 59],
    ] as const)
      expect(show(quiet(90, 90), at(hour, minute))).toBe(false);
  });

  test('a same-day window is a plain range, start inclusive, end exclusive', () => {
    const window = quiet(9 * 60, 17 * 60);
    expect(show(window, at(9, 0))).toBe(false);
    expect(show(window, at(12, 0))).toBe(false);
    expect(show(window, at(16, 59))).toBe(false);
    expect(show(window, at(17, 0))).toBe(true);
    expect(show(window, at(8, 59))).toBe(true);
  });

  test('a window whose start is after its end wraps midnight', () => {
    const night = quiet(22 * 60, 7 * 60);
    expect(show(night, at(22, 0))).toBe(false);
    expect(show(night, at(23, 59))).toBe(false);
    expect(show(night, at(0, 0))).toBe(false);
    expect(show(night, at(6, 59))).toBe(false);
    expect(show(night, at(7, 0))).toBe(true);
    expect(show(night, at(21, 59))).toBe(true);
  });

  test('quiet hours hold every push, a kind-less one and one tied to no daemon included', () => {
    const allDay = quiet(0, 0);
    expect(show(allDay, at(12, 0), null, null)).toBe(false);
    expect(show(allDay, at(12, 0), 'agenda', 'daemon-a')).toBe(false);
  });
});
