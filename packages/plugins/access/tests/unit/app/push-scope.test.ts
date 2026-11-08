/**
 * One push worker per machine: which machine a registration serves, and what its notifications may
 * say and open (docs/cross-daemon.md §4a–§4c).
 */
import { describe, expect, it } from 'bun:test';
import type { PushNotificationPayload } from '../../../contract/index.ts';
import { daemonId, NOTIFICATION_BADGE, NOTIFICATION_ICON } from '../../../app/shell-pairing.ts';
import {
  FILTERED_PUSH_TAG_PREFIX,
  filteredPushNotification,
  isPushScope,
  machineNotification,
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
  it('titles it with the reader’s label, keeps its tag in the machine’s namespace and a link it may not open sent to the app', () => {
    expect(machineNotification({ ...payload, url: 'https://evil.test/' }, WORK, ORIGIN)).toEqual({
      ...payload,
      title: 'Work laptop · A new device was paired',
      tag: 'fy-push:sha256%3Awork%2Fone:pairing',
      url: `${ORIGIN}/app/`,
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

describe('the quiet notification’s mark', () => {
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
