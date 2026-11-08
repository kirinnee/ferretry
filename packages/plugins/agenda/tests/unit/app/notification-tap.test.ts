/**
 * Where a tap on each kind of push lands. The worker's click handler is
 * `notificationTapUrl(notificationUrl(url, origin, machine, sessionId), origin)`, so the proof is that
 * composition, per kind, against the page a daemon names (`agendaNotificationPath`) — plus the mark every
 * one of them wears. The rules are the Agenda's own (`lib/notification-tap.ts`); an ask's tap opens the ferret's
 * chat AT the ask (`/d/<daemon>/ferrets/<ferret>/chat?ask=A3`), checked by the shell's route table.
 */
import { describe, expect, it } from 'bun:test';
import { routeTable, type ScreenRef } from '@ferretry/app';
import { type AgendaId, agendaNotificationPath, MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import type { NotificationPayload as PushNotificationPayload } from '../../../app/lib/notify.ts';
import { inboxTargetFromSearch, inboxTargetPath } from '../../../app/lib/agenda-inbox.ts';
import { NOTIFICATION_BADGE, NOTIFICATION_ICON, showGroupedNotification } from '../../../app/lib/notify.ts';
import {
  filteredPushNotification,
  machineNotification,
  notificationTapUrl,
  notificationUrl,
  unverifiedNotification,
} from '../../../app/lib/notification-tap.ts';
import { daemonId } from '../../../app/shell.ts';

const ORIGIN = 'https://ferretry.example.test';
const MACHINE = { daemonId: 'laptop', label: 'Laptop' };
const HOME = `${ORIGIN}/d/laptop`;
const A3 = 'A3' as AgendaId;
const CHAT: ScreenRef = { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' };
const AGENDA: ScreenRef = { plugin: 'agenda', id: 'agenda', path: 'agenda', label: 'Agenda' };
const ROUTES = routeTable([CHAT, AGENDA]);

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
    ROUTES,
  );

describe('inboxTargetPath / inboxTargetFromSearch', () => {
  it('opens a buzz on the ask’s own page', () => {
    expect(inboxTargetPath(daemonId('laptop'), 'session 1', A3)).toBe('/d/laptop/agenda/session%201/A3');
  });

  it('reads a conversation and an item named on a query', () => {
    expect(inboxTargetFromSearch('?session=session%201&ask=A3')).toEqual({ sessionId: 'session 1', id: A3 });
  });

  it('is null unless both the conversation and the item are named', () => {
    expect(inboxTargetFromSearch('?ask=A3')).toBeNull();
    expect(inboxTargetFromSearch('?session=s1')).toBeNull();
    expect(inboxTargetFromSearch('?session=%20&ask=A3')).toBeNull();
    expect(inboxTargetFromSearch('')).toBeNull();
  });
});

describe('a tap, per kind of push', () => {
  it('writes an ask’s push as the ferret’s chat AT the ask, the one spelling', () => {
    expect(agendaNotificationPath('s1', A3)).toBe('/ferrets/s1/chat?ask=A3');
    expect(agendaNotificationPath('a b', 'A12' as AgendaId)).toBe('/ferrets/a%20b/chat?ask=A12');
  });

  it('an agenda item lands on its ferret’s chat with the ask named', () => {
    const payload = push({ kind: 'attention', sessionId: 's1', url: agendaNotificationPath('s1', A3) });
    expect(tapTarget(payload)).toBe(`${HOME}/ferrets/s1/chat?ask=A3`);
  });

  it('a push that named no page opens the Agenda for a machine notice, not a machine-agenda chat', () => {
    expect(tapTarget(push({ kind: 'attention', sessionId: MACHINE_AGENDA_ID, url: '/' }))).toBe(`${HOME}/agenda`);
  });

  it('a ping, a deadline, a wake-up and a stop all carry their ask, so all land on it', () => {
    for (const kind of ['agenda', 'attention', 'question'] as const) {
      const payload = push({ kind, sessionId: 's9', url: agendaNotificationPath('s9', 'A12' as AgendaId) });
      expect(tapTarget(payload)).toBe(`${HOME}/ferrets/s9/chat?ask=A12`);
    }
  });

  it('a ferret that stopped or failed opens its chat', () => {
    expect(tapTarget(push({ kind: 'failed', sessionId: 's1', url: '/ferrets/s1/chat' }))).toBe(
      `${HOME}/ferrets/s1/chat`,
    );
    expect(tapTarget(push({ kind: 'completed', sessionId: 's1', url: '/ferrets/s1/chat' }))).toBe(
      `${HOME}/ferrets/s1/chat`,
    );
  });

  it('an older daemon that named no page still opens the chat it is about', () => {
    expect(tapTarget(push({ kind: 'failed', sessionId: 's1', url: '/' }))).toBe(`${HOME}/ferrets/s1/chat`);
  });

  it('a pairing opens the machine itself', () => {
    expect(tapTarget(push({ kind: 'device-paired', url: '/' }))).toBe(HOME);
  });

  it('a link off this site or off this machine never leaves the machine', () => {
    for (const url of ['https://evil.test/x', '//evil.test/x', '/d/other/ferrets/s1/chat?ask=A3']) {
      expect(tapTarget(push({ kind: 'attention', sessionId: 's1', url }))).not.toContain('evil.test');
      expect(tapTarget(push({ kind: 'attention', sessionId: 's1', url })).startsWith(`${HOME}`)).toBe(true);
    }
  });

  it('has no /session/ alias: the old path is outside the machine, so it opens the chat the push is about', () => {
    expect(tapTarget(push({ kind: 'attention', sessionId: 's1', url: '/session/s1?ask=A3' }))).toBe(
      `${HOME}/ferrets/s1/chat`,
    );
  });
});

describe('notificationTapUrl (the shell’s route table decides what a tap may open)', () => {
  it('opens a page the table draws as named, ask and all', () => {
    expect(notificationTapUrl(`${HOME}/ferrets/s1/chat?ask=A3`, ORIGIN, ROUTES)).toBe(`${HOME}/ferrets/s1/chat?ask=A3`);
    expect(notificationTapUrl(`${HOME}/settings`, ORIGIN, ROUTES)).toBe(`${HOME}/settings`);
  });

  it('opens the machine’s home for a page the table does not draw, and the app for a foreign origin', () => {
    expect(notificationTapUrl(`${HOME}/session/s1?ask=A3`, ORIGIN, ROUTES)).toBe(HOME);
    expect(notificationTapUrl('https://evil.test/d/laptop/ferrets/s1/chat?ask=A3', ORIGIN, ROUTES)).toBe(
      `${ORIGIN}/app/`,
    );
  });

  it('never throws on junk', () => {
    for (const junk of ['', 'not a url', '/d/%E0%A4%A/ferrets/s1/chat', 'javascript:alert(1)']) {
      expect(() => notificationTapUrl(junk, ORIGIN, ROUTES)).not.toThrow();
      expect(new URL(notificationTapUrl(junk, ORIGIN, ROUTES)).origin).toBe(ORIGIN);
    }
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
