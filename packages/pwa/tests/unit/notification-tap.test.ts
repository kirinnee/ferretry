/**
 * Where a tap on each kind of push lands. The worker's click handler is
 * `notificationTapUrl(notificationUrl(url, origin, machine, sessionId), origin)`, so the proof is that
 * composition, per kind, against the page a daemon names (`agendaNotificationPath`) — plus the mark every
 * one of them wears.
 */
import { describe, expect, it } from 'bun:test';
import { agendaNotificationPath, type AgendaId, type PushNotificationPayload } from '@ferretry/protocol';
import { inboxTargetFromSearch, inboxTargetPath } from '../../src/lib/agenda-inbox.ts';
import { NOTIFICATION_BADGE, NOTIFICATION_ICON, showGroupedNotification } from '../../src/lib/notify.ts';
import {
  filteredPushNotification,
  machineNotification,
  notificationTapUrl,
  notificationUrl,
  unverifiedNotification,
} from '../../src/lib/push-scope.ts';
import { daemonId } from '../../src/lib/daemon-connection.ts';

const ORIGIN = 'https://ferretry.example.test';
const MACHINE = { daemonId: 'laptop', label: 'Laptop' };
const HOME = `${ORIGIN}/d/laptop`;
const A3 = 'A3' as AgendaId;

const push = (over: Partial<PushNotificationPayload>): PushNotificationPayload =>
  ({
    version: 1,
    eventKey: 'e1',
    title: 'Ferretry',
    body: 'body',
    tag: 'tag',
    url: '/',
    count: 1,
    ...over,
  }) as PushNotificationPayload;

/** What the worker's `notificationclick` opens, from a payload as the daemon sent it. */
const tapTarget = (payload: PushNotificationPayload): string =>
  notificationTapUrl(
    notificationUrl(payload.url, ORIGIN, MACHINE, 'sessionId' in payload ? payload.sessionId : undefined),
    ORIGIN,
  );

describe('inboxTargetPath / inboxTargetFromSearch', () => {
  it('round-trips a conversation and an item through the Inbox address', () => {
    const path = inboxTargetPath(daemonId('laptop'), 'session 1', A3);
    expect(path).toBe('/d/laptop/inbox?session=session%201&agenda=A3');
    expect(inboxTargetFromSearch(new URL(path, ORIGIN).search)).toEqual({ sessionId: 'session 1', id: A3 });
  });

  it('is null unless both the conversation and the item are named', () => {
    expect(inboxTargetFromSearch('?agenda=A3')).toBeNull();
    expect(inboxTargetFromSearch('?session=s1')).toBeNull();
    expect(inboxTargetFromSearch('?session=%20&agenda=A3')).toBeNull();
    expect(inboxTargetFromSearch('')).toBeNull();
  });
});

describe('a tap, per kind of push', () => {
  it('an agenda item lands on that item in the Inbox', () => {
    const payload = push({ kind: 'attention', sessionId: 's1', url: agendaNotificationPath('s1', 'A3') });
    expect(tapTarget(payload)).toBe(`${HOME}/inbox?session=s1&agenda=A3`);
  });

  it('a ping, a deadline, a wake-up and a stop all carry their item, so all land on it', () => {
    for (const kind of ['agenda', 'attention', 'question'] as const) {
      const payload = push({ kind, sessionId: 's9', url: agendaNotificationPath('s9', 'A12') });
      expect(tapTarget(payload)).toBe(`${HOME}/inbox?session=s9&agenda=A12`);
    }
  });

  it('a ferret that stopped or failed opens its conversation', () => {
    expect(tapTarget(push({ kind: 'failed', sessionId: 's1', url: '/session/s1' }))).toBe(`${HOME}/session/s1`);
    expect(tapTarget(push({ kind: 'completed', sessionId: 's1', url: '/session/s1' }))).toBe(`${HOME}/session/s1`);
  });

  it('an older daemon that named no page still opens the conversation it is about', () => {
    expect(tapTarget(push({ kind: 'failed', sessionId: 's1', url: '/' }))).toBe(`${HOME}/session/s1`);
  });

  it('a pairing opens the machine itself', () => {
    expect(tapTarget(push({ kind: 'device-paired', url: '/' }))).toBe(HOME);
  });

  it('a link off this site or off this machine never leaves the machine', () => {
    for (const url of ['https://evil.test/x', '//evil.test/x', '/d/other/inbox?session=s1&agenda=A3']) {
      expect(tapTarget(push({ kind: 'attention', sessionId: 's1', url }))).not.toContain('evil.test');
      expect(tapTarget(push({ kind: 'attention', sessionId: 's1', url })).startsWith(`${HOME}`)).toBe(true);
    }
  });

  it('a conversation page with no item is left as the conversation', () => {
    expect(notificationTapUrl(`${HOME}/session/s1`, ORIGIN)).toBe(`${HOME}/session/s1`);
    expect(notificationTapUrl(`${HOME}/settings`, ORIGIN)).toBe(`${HOME}/settings`);
  });
});

/** A registration that records what it was asked to show. */
const recorder = () => {
  const shown: { title: string; options: NotificationOptions }[] = [];
  return {
    shown,
    registration: {
      getNotifications: async () => [],
      showNotification: async (title: string, options?: NotificationOptions) => {
        shown.push({ title, options: options ?? {} });
      },
    },
  };
};

describe('every notification wears the Ferretry mark', () => {
  it('shows the app icon and the monochrome badge, whatever the kind', async () => {
    for (const kind of ['attention', 'agenda', 'question', 'failed', 'completed', 'device-paired'] as const) {
      const { shown, registration } = recorder();
      await showGroupedNotification(
        registration as never,
        machineNotification(push({ kind, sessionId: 's1' }), MACHINE, ORIGIN),
      );
      expect(shown).toHaveLength(1);
      expect(shown[0]?.options.icon).toBe(NOTIFICATION_ICON);
      expect(shown[0]?.options.badge).toBe(NOTIFICATION_BADGE);
    }
  });

  it('shows it on a push no machine could vouch for, and on the quiet one', async () => {
    const { shown, registration } = recorder();
    await showGroupedNotification(registration as never, unverifiedNotification(push({ kind: 'attention' }), ORIGIN));
    expect(shown[0]?.options.icon).toBe(NOTIFICATION_ICON);
    expect(shown[0]?.options.badge).toBe(NOTIFICATION_BADGE);
    const quiet = filteredPushNotification(MACHINE, ORIGIN);
    expect(quiet.options.icon).toBe(NOTIFICATION_ICON);
    expect(quiet.options.badge).toBe(NOTIFICATION_BADGE);
  });

  it('points at icons the manifest actually ships', () => {
    expect(NOTIFICATION_ICON).toBe('/icons/icon-any-192.png');
    expect(NOTIFICATION_BADGE).toBe('/icons/badge-96.png');
  });
});
