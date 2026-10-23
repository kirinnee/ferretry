/**
 * One push worker per machine: which machine a registration serves, and what its notifications may
 * say and open (docs/cross-daemon.md §4a–§4c).
 */
import { describe, expect, it, test } from 'bun:test';
import { attentionNotificationPath, type PushNotificationPayload } from '@ferretry/protocol';
import { daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { buildNotification } from '../../src/lib/notification-ledger.ts';
import { NOTIFICATION_BADGE, NOTIFICATION_ICON } from '../../src/lib/notify.ts';
import {
  FILTERED_PUSH_TAG_PREFIX,
  filteredPushNotification,
  isPushScope,
  machineNotification,
  notificationUrl,
  PUSH_SCOPE_ROOT,
  pushMachineOf,
  pushScopePath,
  pushWorkerUrl,
  unreadablePushTitle,
  unverifiedNotification,
} from '../../src/lib/push-scope.ts';
import { sessionView } from '../support/sessions.ts';

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
    const own = `/d/${encodeURIComponent(WORK.daemonId)}/session/s1`;
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
    expect(notificationUrl('/d/x/session/1', ORIGIN, null)).toBe(`${ORIGIN}/d/x/session/1`);
    expect(notificationUrl('https://evil.test/phish', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl('//evil.test/phish', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl('javascript:alert(1)', ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl(undefined, ORIGIN, null)).toBe(`${ORIGIN}/app/`);
    expect(notificationUrl(42, ORIGIN, null)).toBe(`${ORIGIN}/app/`);
  });

  it('keeps a machine inside its own pages, even through a climbing or look-alike path', () => {
    const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
    expect(notificationUrl(`${home}/session/s1`, ORIGIN, WORK)).toBe(`${home}/session/s1`);
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

  it('places a daemon’s machine-relative conversation link under THAT machine, item and all', () => {
    const home = `${ORIGIN}/d/sha256%3Awork%2Fone`;
    const link = attentionNotificationPath('session 1', 'A3');
    expect(link).toBe('/session/session%201?attention=A3');
    expect(notificationUrl(link, ORIGIN, WORK)).toBe(`${home}/session/session%201?attention=A3`);
    // A climb out of the machine from a relative link is still caught by the machine check.
    expect(notificationUrl('/session/../../d/other', ORIGIN, WORK)).toBe(home);
    // The app-wide worker knows no machine, so a relative link opens nothing but the app.
    expect(notificationUrl(link, ORIGIN, null)).toBe(`${ORIGIN}/session/session%201?attention=A3`);
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
    // The same session id on both machines: the URL is what keeps them apart.
    const spec = buildNotification(
      daemonSessionScope(
        daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.test', deviceId: 'd' }),
        's-1',
      ),
      sessionView('s-1'),
      'question',
    );
    expect(spec.url).toBe('/d/laptop/session/s-1');
    expect(notificationUrl(spec.url, origin, laptop)).toBe(`${origin}/d/laptop/session/s-1`);
    // Studio's worker refuses to open the laptop's page, and falls back to its own sessions.
    expect(notificationUrl(spec.url, origin, studio)).toBe(`${origin}/d/studio`);
  });
});
