import { describe, expect, test } from 'bun:test';
import type { PushShow } from '@ferretry/kernel/contract/push-envelope';
import {
  FILTERED_PUSH_TAG_PREFIX,
  filteredPushNotification,
  groupedNotificationBody,
  isPhoneApprovalTag,
  machineShow,
  planNotificationPresentation,
  showGroupedNotification,
  shownTag,
  urgentNotificationOptions,
} from '../../../src/worker/notify-group.ts';
import { NOTIFICATION_BADGE, NOTIFICATION_ICON } from '../../../src/worker/notifications.ts';

const ORIGIN = 'https://app.test';
const WORK = { daemonId: 'sha256:work/one', label: 'Work laptop' };
const PA = 'pa-pa_0123456789abcdef01234567';

const show = (over: Partial<PushShow> = {}): PushShow => ({ title: 'Deploy', body: 'Ship it?', ...over }) as PushShow;

describe('S6 shownTag', () => {
  test('files a daemon tag inside its machine’s namespace, and the app-wide registration’s own', () => {
    expect(shownTag('agenda-A3', WORK)).toBe('fy-push:sha256%3Awork%2Fone:agenda-A3');
    expect(shownTag('agenda-A3', null)).toBe('fy-push-unverified:agenda-A3');
  });

  test('two machines never share a shown tag for the same daemon tag', () => {
    expect(shownTag('t', WORK)).not.toBe(shownTag('t', { daemonId: 'other', label: 'x' }));
  });
});

describe('S6 machineShow', () => {
  test('titles by the reader’s label, tags in the namespace, and carries the checked page', () => {
    const shown = machineShow(
      show({ tag: 'agenda-A3', kind: 'failed', count: 3, urgency: 'high', url: '/ferrets/f1/chat?ask=A3' }),
      WORK,
      ORIGIN,
    );
    expect(shown).toEqual({
      title: 'Work laptop · Deploy',
      body: 'Ship it?',
      tag: 'fy-push:sha256%3Awork%2Fone:agenda-A3',
      daemonTag: 'agenda-A3',
      kind: 'failed',
      count: 3,
      urgency: 'high',
      url: `${ORIGIN}/d/sha256%3Awork%2Fone/ferrets/f1/chat?ask=A3`,
    });
  });

  test('an untagged, kind-less show has no tag and counts as one; the app-wide registration is unverified and opens the app', () => {
    const shown = machineShow(show({ url: '/ferrets/f1/chat' }), null, ORIGIN);
    expect(shown).toEqual({ title: 'Unverified · Deploy', body: 'Ship it?', count: 1, url: `${ORIGIN}/app/` });
  });
});

describe('S6 grouping', () => {
  test('groupedNotificationBody says how many more only above one', () => {
    expect(groupedNotificationBody('Latest', 1)).toBe('Latest');
    expect(groupedNotificationBody('Latest', 4)).toBe('Latest\n+3 more');
  });

  test('a phone approval tag is recognised in any namespace, and nothing else is', () => {
    expect(isPhoneApprovalTag(PA)).toBe(true);
    expect(isPhoneApprovalTag(`fy-push:abc:${PA}`)).toBe(true);
    expect(isPhoneApprovalTag('pa-pa_short')).toBe(false);
    expect(isPhoneApprovalTag(`xpa-pa_0123456789abcdef01234567`)).toBe(false);
    expect(isPhoneApprovalTag('agenda-A3')).toBe(false);
  });

  const shown = (over: Record<string, unknown> = {}) =>
    ({
      title: 'T',
      body: 'Latest',
      url: 'u',
      count: 1,
      kind: 'failed',
      tag: 'fy-push:abc:agenda-A3',
      daemonTag: 'agenda-A3',
      ...over,
    }) as never;

  test('a repeat merges with what is already showing; the number never goes backwards or past the bound', () => {
    const plan = (existing: object[], over: Record<string, unknown> = {}) =>
      planNotificationPresentation(shown(over), existing) as { action: 'show'; body: string; count: number };
    expect(plan([]).count).toBe(1);
    expect(plan([{ count: 1 }]).count).toBe(2);
    expect(plan([{ count: 1 }, { count: 4 }]).count).toBe(5);
    expect(plan([{ count: 2 }], { count: 9 }).count).toBe(9);
    expect(plan([{ count: 100 }]).count).toBe(100);
    expect(plan([{ count: 100 }]).body).toBe('Latest\n+99 more');
    // junk counts in what is showing are ignored
    expect(plan([{ count: 'x' }, { count: -3 }, { count: 1.5 }, {}]).count).toBe(1);
  });

  test('no merge for a push with no kind or for the paired-device notice', () => {
    const { kind: _unused, ...kindless } = shown() as Record<string, unknown>;
    expect((planNotificationPresentation(kindless as never, [{ count: 3 }]) as { count: number }).count).toBe(1);
    expect(
      (planNotificationPresentation(shown({ kind: 'device-paired' }), [{ count: 3 }]) as { count: number }).count,
    ).toBe(1);
  });

  test('M3 every kind but device-paired merges, as in v4: an agenda, failed, completed or question repeat bumps the count', () => {
    for (const kind of ['agenda', 'failed', 'completed', 'question'])
      expect([
        kind,
        (planNotificationPresentation(shown({ kind }), [{ count: 3 }]) as { count: number }).count,
      ]).toEqual([kind, 4]);
  });

  test('carries the daemon tag, un-namespaced, into the notification’s data', () => {
    const plan = planNotificationPresentation(shown(), []) as { data: unknown };
    expect(plan.data).toEqual({ url: 'u', count: 1, latestBody: 'Latest', tag: 'agenda-A3' });
    const untagged = planNotificationPresentation(shown({ tag: undefined, daemonTag: undefined }), []) as {
      data: object;
    };
    expect('tag' in untagged.data).toBe(false);
  });

  test('an approval is never merged or hidden under "+N more"; the same words are a twin, a re-read number is not', () => {
    const approval = shown({ tag: `fy-push:abc:${PA}`, kind: 'agenda', body: 'Code 123456', count: 5 });
    expect(planNotificationPresentation(approval, [{ latestBody: 'Code 123456', count: 1 }])).toEqual({
      action: 'skip',
    });
    const plan = planNotificationPresentation(approval, [{ latestBody: 'Code 654321', count: 1 }]) as {
      body: string;
      count: number;
    };
    expect(plan.body).toBe('Code 123456');
    expect(plan.count).toBe(1);
  });
});

describe('S6 urgentNotificationOptions', () => {
  test('a high push and every phone approval stay on screen and sound again; an ordinary push asks for nothing', () => {
    const loud = { requireInteraction: true, renotify: true, silent: false, vibrate: [200, 100, 200] };
    expect(urgentNotificationOptions({ urgency: 'high', tag: 'fy-push:abc:agenda-A3' })).toEqual(loud as never);
    expect(urgentNotificationOptions({ tag: `fy-push:abc:${PA}` })).toEqual(loud as never);
    expect(urgentNotificationOptions({ tag: 'agenda-A3' })).toEqual({});
    expect(urgentNotificationOptions({})).toEqual({});
  });

  test('m2 an untagged high push stays loud but never asks to renotify (a TypeError with no tag)', () => {
    const options = urgentNotificationOptions({ urgency: 'high' });
    expect(options).toEqual({ requireInteraction: true, silent: false, vibrate: [200, 100, 200] });
    expect('renotify' in options).toBe(false);
  });

  test('m2 an untagged high push is SHOWN with its words and without renotify', async () => {
    const shownLines: { title: string; options: Record<string, unknown> }[] = [];
    const result = await showGroupedNotification(
      {
        getNotifications: async () => [],
        showNotification: async (title, options) => void shownLines.push({ title, options: options as never }),
      },
      { title: 'Work · Code', body: 'Code 123456', count: 1, urgency: 'high', url: 'u' },
    );
    expect(result).toBe('shown');
    expect(shownLines).toHaveLength(1);
    expect(shownLines[0]?.options.body).toBe('Code 123456');
    expect(shownLines[0]?.options.renotify).toBe(false);
    expect(shownLines[0]?.options.requireInteraction).toBe(true);
    expect('tag' in (shownLines[0]?.options ?? {})).toBe(false);
  });
});

function registration(existing: object[] = []) {
  const asked: unknown[] = [];
  const shownLines: { title: string; options: Record<string, unknown> }[] = [];
  return {
    asked,
    shownLines,
    registration: {
      getNotifications: async (options?: unknown) => {
        asked.push(options);
        return existing;
      },
      showNotification: async (title: string, options?: NotificationOptions) => {
        shownLines.push({ title, options: options as Record<string, unknown> });
      },
    },
  };
}

describe('S6 showGroupedNotification', () => {
  const pushed = (over: Record<string, unknown> = {}) =>
    machineShow(
      show({ tag: 'agenda-A3', kind: 'failed', url: '/ferrets/f1/chat?ask=A3', ...over } as Partial<PushShow>),
      WORK,
      ORIGIN,
    );

  test('reads what is under its tag, then replaces it silently with the merged words', async () => {
    const fake = registration([{ data: { count: 2, latestBody: 'Old' } }]);
    expect(await showGroupedNotification(fake.registration, pushed())).toBe('shown');
    expect(fake.asked).toEqual([{ tag: 'fy-push:sha256%3Awork%2Fone:agenda-A3' }]);
    expect(fake.shownLines).toHaveLength(1);
    expect(fake.shownLines[0]?.options).toMatchObject({
      body: 'Ship it?\n+2 more',
      tag: 'fy-push:sha256%3Awork%2Fone:agenda-A3',
      renotify: false,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
    });
  });

  test('an untagged show reads nothing and replaces nothing', async () => {
    const fake = registration([{ data: { count: 9 } }]);
    await showGroupedNotification(fake.registration, pushed({ tag: undefined }));
    expect(fake.asked).toEqual([]);
    expect(fake.shownLines[0]?.options).not.toHaveProperty('tag');
  });

  test('a notification whose data is not a record counts for nothing', async () => {
    const fake = registration([{ data: 'text' }, { data: null }, {}]);
    await showGroupedNotification(fake.registration, pushed());
    expect(fake.shownLines[0]?.options.body).toBe('Ship it?');
  });

  test('a twin of an approval already showing is skipped; a new number sounds again', async () => {
    const tag = PA;
    const twin = registration([{ data: { latestBody: 'Ship it?', count: 1 } }]);
    expect(await showGroupedNotification(twin.registration, pushed({ tag, kind: 'agenda' }))).toBe('duplicate');
    expect(twin.shownLines).toEqual([]);
    const changed = registration([{ data: { latestBody: 'Other', count: 1 } }]);
    expect(await showGroupedNotification(changed.registration, pushed({ tag, kind: 'agenda' }))).toBe('shown');
    expect(changed.shownLines[0]?.options).toMatchObject({ requireInteraction: true, renotify: true });
  });
});

describe('S6 filteredPushNotification (a push the device’s own filter hides)', () => {
  test('says nothing the push said: fixed words, silent, one fixed tag per machine, a tap to the machine’s home', () => {
    const quiet = filteredPushNotification(WORK, ORIGIN);
    expect(quiet.title).toBe('Work laptop · Notifications muted');
    expect(quiet.options).toMatchObject({
      tag: `${FILTERED_PUSH_TAG_PREFIX}sha256%3Awork%2Fone`,
      silent: true,
      renotify: false,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
      data: { url: `${ORIGIN}/d/sha256%3Awork%2Fone` },
    });
  });

  test('the app-wide registration is unverified, files under its own tag and opens the app', () => {
    const quiet = filteredPushNotification(null, ORIGIN);
    expect(quiet.title).toBe('Unverified · Notifications muted');
    expect(quiet.options.tag).toBe(`${FILTERED_PUSH_TAG_PREFIX}app`);
    expect(quiet.options.data).toEqual({ url: `${ORIGIN}/app/` });
  });
});
