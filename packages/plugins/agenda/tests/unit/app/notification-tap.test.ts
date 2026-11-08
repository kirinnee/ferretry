/**
 * Where a tap on each kind of push lands. The worker decides it with the shell's ONE rule, `notificationUrl`
 * (`@ferretry/app`), so the proof is that rule, per kind, against the page a daemon names (`agendaNotificationPath`,
 * `askBuzzPath`) — plus the mark every one of them wears. An ask's tap opens the ferret's chat AT the ask
 * (`/d/<daemon>/ferrets/<ferret>/chat?ask=A3`).
 */
import { describe, expect, it } from 'bun:test';
import { PUSH_TAP_SCREENS } from '@ferretry/app';
import {
  type AgendaId,
  agendaNotificationPath,
  MACHINE_AGENDA_ID,
  sessionNotificationPath,
} from '@ferretry/core-asks/contract';
import { askBuzzPath } from '../../../contract/index.ts';
import agendaManifest from '../../../manifest.ts';
import type { NotificationPayload as PushNotificationPayload } from '../../../app/lib/notify.ts';
import { inboxTargetFromSearch, inboxTargetPath } from '../../../app/lib/agenda-inbox.ts';
import { NOTIFICATION_BADGE, NOTIFICATION_ICON, showGroupedNotification } from '../../../app/lib/notify.ts';
import {
  filteredPushNotification,
  machineNotification,
  unverifiedNotification,
} from '../../../app/lib/notification-tap.ts';
import { daemonId, notificationUrl } from '../../../app/shell.ts';

const ORIGIN = 'https://ferretry.example.test';
const MACHINE = { daemonId: 'laptop', label: 'Laptop' };
const HOME = `${ORIGIN}/d/laptop`;
const A3 = 'A3' as AgendaId;
const APP = `${ORIGIN}/app/`;

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
const tapTarget = (payload: PushNotificationPayload): string => notificationUrl(payload.url, ORIGIN, MACHINE);

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

  it('a machine ask opens the machine’s Agenda page AT the ask', () => {
    const payload = push({ kind: 'attention', sessionId: MACHINE_AGENDA_ID, url: '/agenda?ask=A3' });
    expect(tapTarget(payload)).toBe(`${HOME}/agenda?ask=A3`);
  });

  it('S2: what the Agenda builds and what the shell’s one tap rule accepts cannot drift apart', () => {
    // Every builder the Agenda owns, through the rule that decides where a tap may go (`notificationUrl` in @ferretry/app).
    expect(notificationUrl(askBuzzPath('s1', A3), ORIGIN, MACHINE)).toBe(`${HOME}/ferrets/s1/chat?ask=A3`);
    expect(notificationUrl(askBuzzPath('', A3), ORIGIN, MACHINE)).toBe(`${HOME}/agenda?ask=A3`);
    expect(notificationUrl(askBuzzPath(MACHINE_AGENDA_ID, A3), ORIGIN, MACHINE)).toBe(`${HOME}/agenda?ask=A3`);
    expect(notificationUrl(agendaNotificationPath('a b', 'A12' as AgendaId), ORIGIN, MACHINE)).toBe(
      `${HOME}/ferrets/a%20b/chat?ask=A12`,
    );
    expect(notificationUrl(sessionNotificationPath('s1'), ORIGIN, MACHINE)).toBe(`${HOME}/ferrets/s1/chat`);
    expect(notificationUrl(agendaNotificationPath('s1', A3), ORIGIN, null)).toBe(`${ORIGIN}/app/`);
  });

  it('S2: the screens a push may name are the paths the manifests declare', () => {
    const declared = (manifest: { ui?: { screens?: readonly { id: string; path: string }[] } }, id: string): string =>
      manifest.ui?.screens?.find(screen => screen.id === id)?.path ?? '';
    const named = (id: string): string => PUSH_TAP_SCREENS.find(screen => screen.id === id)?.path ?? '(missing)';
    expect(named('agenda')).toBe(declared(agendaManifest, 'agenda'));
  });

  it('a push that names no page it may open, or none at all, opens the app', () => {
    expect(tapTarget(push({ kind: 'attention', sessionId: MACHINE_AGENDA_ID, url: '/' }))).toBe(APP);
    expect(tapTarget(push({ kind: 'failed', sessionId: 's1', url: '/' }))).toBe(APP);
    expect(tapTarget(push({ kind: 'device-paired', url: '/' }))).toBe(APP);
  });

  it('a ping, a deadline and a wake-up all carry their ask, so all land on it', () => {
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

  it('a link off this site or off this machine opens the app, never the machine or the link', () => {
    for (const url of ['https://evil.test/x', '//evil.test/x', '/d/other/ferrets/s1/chat?ask=A3']) {
      expect(tapTarget(push({ kind: 'attention', sessionId: 's1', url }))).toBe(APP);
    }
  });

  it('has no /session/ alias: the old path opens the app', () => {
    expect(tapTarget(push({ kind: 'attention', sessionId: 's1', url: '/session/s1?ask=A3' }))).toBe(APP);
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
