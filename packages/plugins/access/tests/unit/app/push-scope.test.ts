/**
 * One push worker per machine: which machine a registration serves, and what its notifications may
 * say and open (docs/cross-daemon.md §4a–§4c).
 */
import { describe, expect, it, test } from 'bun:test';
import { routeTable } from '@ferretry/app';
import type { ScreenRef } from '@ferretry/app';
import type { PushNotificationPayload } from '../../../contract/index.ts';
import {
  daemonConnection,
  daemonId,
  daemonFerretChatPath,
  NOTIFICATION_BADGE,
  NOTIFICATION_ICON,
} from '../../../app/shell-pairing.ts';
import {
  FILTERED_PUSH_TAG_PREFIX,
  filteredPushNotification,
  isPushScope,
  machineNotification,
  notificationTapUrl,
  notificationUrl,
  PUSH_SCOPE_ROOT,
  pushMachineOf,
  pushScopePath,
  pushWorkerUrl,
  unreadablePushTitle,
  unverifiedNotification,
} from '../../../app/lib/push-scope.ts';

const ORIGIN = 'https://ferretry.example.test';
const WORK = { daemonId: 'sha256:work/one', label: 'Work laptop' };

const payload: PushNotificationPayload = {
  version: 1,
  eventKey: 'e1',
  title: 'A new device was paired',
  body: 'Pixel 9 can now reach this machine.',
  tag: 'pairing',
  url: '/',
  count: 1,
};

describe('the per-machine scope and worker address', () => {
  it('puts each machine under its own escaped scope, never a page the app serves', () => {
    expect(PUSH_SCOPE_ROOT).toBe('/push/');
    expect(pushScopePath(daemonId('sha256:work/one'))).toBe('/push/sha256%3Awork%2Fone/');
  });

  it('registers the signed worker file itself, with the reader’s label as its only addition', () => {
    expect(pushWorkerUrl('/sw.verified.js', 'Work & play')).toBe('/sw.verified.js?machine=Work%20%26%20play');
  });
});

describe('pushMachineOf', () => {
  it('reads the machine from the scope and the reader’s label from the script', () => {
    expect(
      pushMachineOf(`${ORIGIN}/push/sha256%3Awork%2Fone/`, `${ORIGIN}/sw.verified.js?machine=Work%20laptop`),
    ).toEqual(WORK);
  });

  it('falls back to the daemon id when the script names no label', () => {
    expect(pushMachineOf(`${ORIGIN}/push/abc/`, `${ORIGIN}/sw.verified.js?machine=%20`)).toEqual({
      daemonId: 'abc',
      label: 'abc',
    });
    expect(pushMachineOf(`${ORIGIN}/push/abc/`, 'not a url')).toEqual({ daemonId: 'abc', label: 'abc' });
  });

  it('is null for the app-wide registration and anything that is not exactly one machine', () => {
    for (const scope of [
      `${ORIGIN}/`,
      `${ORIGIN}/push/`,
      `${ORIGIN}/push/a/b/`,
      `${ORIGIN}/push/%E0%A4%A/`,
      `${ORIGIN}/app/`,
      'not a url',
    ]) {
      expect(pushMachineOf(scope, `${ORIGIN}/sw.verified.js`)).toBeNull();
    }
    expect(isPushScope(`${ORIGIN}/push/abc/`)).toBe(true);
    expect(isPushScope(`${ORIGIN}/`)).toBe(false);
  });
});

describe('machineNotification', () => {
  it('titles it with the reader’s label, keeps its tag in the machine’s namespace and its link at home', () => {
    expect(machineNotification({ ...payload, url: 'https://evil.test/' }, WORK, ORIGIN)).toEqual({
      ...payload,
      title: 'Work laptop · A new device was paired',
      tag: 'fy-push:sha256%3Awork%2Fone:pairing',
      url: `${ORIGIN}/d/sha256%3Awork%2Fone`,
    });
  });

  it('keeps a link that is already one of the machine’s own pages', () => {
    const own = `/d/${encodeURIComponent(WORK.daemonId)}/ferrets/s1/chat`;
    expect(machineNotification({ ...payload, url: own }, WORK, ORIGIN).url).toBe(`${ORIGIN}${own}`);
  });

  it('cannot reuse another machine’s tag, so it can never replace that machine’s notification', () => {
    const other = { daemonId: 'sha256:home', label: 'Home' };
    expect(machineNotification(payload, WORK, ORIGIN).tag).not.toBe(machineNotification(payload, other, ORIGIN).tag);
  });

  it('titles a push nobody composed by the machine it came through', () => {
    expect(unreadablePushTitle(WORK)).toBe('Work laptop · Ferretry');
    expect(unreadablePushTitle(null)).toBe('Unverified · Ferretry');
  });
});

describe('notificationUrl (§4a: only this site; §4c: only this machine)', () => {
  it('opens this site’s own page, and the app for anything off this site', () => {
    expect(notificationUrl('/d/x/ferrets/1/chat', ORIGIN, null)).toBe(`${ORIGIN}/d/x/ferrets/1/chat`);
    expect(notificationUrl('https://evil.test/phish', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl('//evil.test/phish', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl('javascript:alert(1)', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl(undefined, ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl(42, ORIGIN, null)).toBe(`${ORIGIN}/app/`);
  });

  it('keeps a machine inside its own pages, even through a climbing or look-alike path', () => {
    const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
    expect(notificationUrl(`${home}/ferrets/s1/chat`, ORIGIN, WORK)).toBe(`${home}/ferrets/s1/chat`);
    expect(notificationUrl(home, ORIGIN, WORK)).toBe(home);
    for (const elsewhere of [
      '/d/sha256%3Ahome/settings',
      `/d/sha256%3Awork%2Fone/../../d/other`,
      '/d/sha256%3Awork%2Fone-evil/x',
      '/',
      'https://evil.test/',
    ]) {
      expect(notificationUrl(elsewhere, ORIGIN, WORK)).toBe(home);
    }
  });

  it('places a daemon’s machine-relative chat link under THAT machine, ask and all', () => {
    const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
    // The machine-relative link the Agenda writes for an ask (`agendaNotificationPath('session 1', 'A3')`).
    const link = '/ferrets/session%201/chat?ask=A3';
    expect(notificationUrl(link, ORIGIN, WORK)).toBe(`${home}/ferrets/session%201/chat?ask=A3`);
    // A climb out of the machine from a relative link is still caught by the machine check.
    expect(notificationUrl('/ferrets/../../d/other', ORIGIN, WORK)).toBe(home);
    // The app-wide worker knows no machine, so a relative link opens nothing but the app.
    expect(notificationUrl(link, ORIGIN, null)).toBe(`${ORIGIN}/app/`);
  });

  it('places a machine ask’s Agenda link under that machine, ask kept; the app-wide worker opens the app', () => {
    const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
    expect(notificationUrl('/agenda?ask=A3', ORIGIN, WORK)).toBe(`${home}/agenda?ask=A3`);
    expect(notificationUrl('/agenda?ask=A3', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
  });

  it('writes the ask as `?ask=` and has no /session/ alias', () => {
    const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
    expect(notificationUrl('/ferrets/s1/chat?ask=A3', ORIGIN, WORK, 's1')).toBe(`${home}/ferrets/s1/chat?ask=A3`);
    // The old spelling is just another address outside the machine: the chat of the ferret the push is about.
    expect(notificationUrl('/session/s1?attention=A3', ORIGIN, WORK, 's1')).toBe(`${home}/ferrets/s1/chat`);
  });

  it('opens the conversation a push is about when its daemon named no page (before #768, `fy attention notify`)', () => {
    const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
    // An older daemon's ask, and every push it sent: `url: '/'`, with the session it is about.
    expect(notificationUrl('/', ORIGIN, WORK, 'session 1')).toBe(`${home}/ferrets/session%201/chat`);
    // Off this site, or on another machine's pages: still this machine's copy of that conversation.
    expect(notificationUrl('https://evil.test/', ORIGIN, WORK, 's1')).toBe(`${home}/ferrets/s1/chat`);
    expect(notificationUrl('/d/other/ferrets/s1/chat', ORIGIN, WORK, 's1')).toBe(`${home}/ferrets/s1/chat`);
    // A page it did name, and may open, wins over the session.
    expect(notificationUrl('/ferrets/s1/chat?ask=A3', ORIGIN, WORK, 's1')).toBe(`${home}/ferrets/s1/chat?ask=A3`);
    expect(notificationUrl(`${home}/settings`, ORIGIN, WORK, 's1')).toBe(`${home}/settings`);
    // About no conversation (a blank id is none): the machine's sessions. The app-wide worker knows no
    // machine to open a session on, so the id changes nothing there.
    expect(notificationUrl('/', ORIGIN, WORK, ' ')).toBe(home);
    expect(notificationUrl('/', ORIGIN, null, 's1')).toBe(notificationUrl('/', ORIGIN, null));
  });

  it('shows an older daemon’s session push pointing at its conversation', () => {
    const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
    const shown = machineNotification({ ...payload, sessionId: 's1', kind: 'failed', url: '/' }, WORK, ORIGIN);
    expect(shown.url).toBe(`${home}/ferrets/s1/chat`);
    expect(machineNotification({ ...payload, url: '/' }, WORK, ORIGIN).url).toBe(home);
  });

  it('carries the Ferretry mark on the quiet notification too', () => {
    const shown = filteredPushNotification(WORK, ORIGIN);
    expect(shown.options.icon).toBe(NOTIFICATION_ICON);
    expect(shown.options.badge).toBe(NOTIFICATION_BADGE);
  });
});

describe('filteredPushNotification', () => {
  it('never carries the suppressed content, is silent, and collapses to one tag per machine', () => {
    const shown = filteredPushNotification(WORK, ORIGIN);

    expect(shown.title).toBe('Work laptop · Notifications muted');
    expect(shown.options.body).not.toContain('A new device was paired');
    expect(shown.options.silent).toBe(true);
    expect(shown.options.renotify).toBe(false);
    expect(shown.options.tag).toBe(`${FILTERED_PUSH_TAG_PREFIX}sha256%3Awork%2Fone`);
    // Never in a live machine's own push namespace, so it can neither replace nor be replaced by one.
    expect(shown.options.tag?.startsWith('fy-push:')).toBe(false);
    expect((shown.options.data as { url: string }).url).toBe(`${ORIGIN}/d/sha256%3Awork%2Fone`);
  });

  it('opens the app, under the app-wide tag, for a push tied to no machine', () => {
    const shown = filteredPushNotification(null, ORIGIN);

    expect(shown.title).toBe('Unverified · Notifications muted');
    expect(shown.options.tag).toBe(`${FILTERED_PUSH_TAG_PREFIX}app`);
    expect((shown.options.data as { url: string }).url).toBe(`${ORIGIN}/app/`);
  });

  it('cannot reuse another machine’s quiet tag, so one machine’s filtered pushes never collapse into another’s', () => {
    const other = { daemonId: 'sha256:home', label: 'Home' };
    expect(filteredPushNotification(WORK, ORIGIN).options.tag).not.toBe(
      filteredPushNotification(other, ORIGIN).options.tag,
    );
  });
});

describe('unverifiedNotification (review M3)', () => {
  it('titles a push to the app-wide registration Unverified, keeps it out of every machine’s tags, opens the app', () => {
    const shown = unverifiedNotification({ ...payload, url: '/d/sha256%3Ahome/settings' }, ORIGIN);
    expect(shown).toEqual({
      ...payload,
      title: 'Unverified · A new device was paired',
      tag: 'fy-push-unverified:pairing',
      url: `${ORIGIN}/app/`,
    });
    expect(shown.tag.startsWith('fy-push:')).toBe(false);
  });
});

describe('a tap opens the machine the notification came from', () => {
  test('a session on the other machine opens that machine’s session, and never this one’s', () => {
    const origin = 'https://app.example.test';
    const studio = { daemonId: 'studio', label: 'studio' };
    const laptop = { daemonId: 'laptop', label: 'laptop' };
    // The same session id on both machines: the URL is what keeps them apart. A session notification's page is
    // its machine's conversation path (today built by the notification ledger from the session's scope).
    const laptopConnection = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.test', deviceId: 'd' });
    const spec = { url: daemonFerretChatPath(laptopConnection.daemonId, 's-1') };
    expect(spec.url).toBe('/d/laptop/ferrets/s-1/chat');
    expect(notificationUrl(spec.url, origin, laptop)).toBe(`${origin}/d/laptop/ferrets/s-1/chat`);
    // Studio's worker refuses to open the laptop's page, and falls back to its own sessions.
    expect(notificationUrl(spec.url, origin, studio)).toBe(`${origin}/d/studio`);
  });
});

describe('notificationTapUrl (the tap lands on the page the shell’s route table draws)', () => {
  const chat: ScreenRef = { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' };
  const routes = routeTable([chat]);
  const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
  /** What the click handler opens, from a payload as the daemon sent it. */
  const tapped = (url: string, sessionId?: string): string =>
    notificationTapUrl(notificationUrl(url, ORIGIN, WORK, sessionId), ORIGIN, routes);

  it('opens an ask’s push on the ferret’s chat with the ask named, the one spelling', () => {
    expect(tapped('/ferrets/f1/chat?ask=A3', 'f1')).toBe(`${home}/ferrets/f1/chat?ask=A3`);
  });

  it('opens a push with no ask on the chat it is about', () => {
    expect(tapped('/', 'f1')).toBe(`${home}/ferrets/f1/chat`);
  });

  it('fails closed on a foreign origin and on junk, and never throws', () => {
    expect(notificationTapUrl('https://evil.test/d/x/ferrets/f1/chat?ask=A3', ORIGIN, routes)).toBe(`${ORIGIN}/app/`);
    for (const junk of ['', 'not a url', '/d/%E0%A4%A/ferrets/f1/chat']) {
      expect(() => notificationTapUrl(junk, ORIGIN, routes)).not.toThrow();
      expect(new URL(notificationTapUrl(junk, ORIGIN, routes)).origin).toBe(ORIGIN);
    }
  });
});
