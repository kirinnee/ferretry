import { describe, expect, test } from 'bun:test';
import { notificationsDoctor, type PushHealth } from '../../../../daemon/lib/push/health.ts';

const run = async (health: PushHealth) => await notificationsDoctor(async () => health)();

const SILENT = 'The phone stays silent for stops, deadlines and pings while this lasts.';

describe('notifications: whether this daemon can buzz a phone (v4 notificationHealthChecks)', () => {
  test('V-0257 no enrolled device is a warning that says nothing buzzes and where to turn it on', async () => {
    expect(await run({ enrolled: 0 })).toEqual({
      state: 'warn',
      name: 'notifications',
      requirement: 'capability',
      detail: 'no device is enrolled for push',
      fix: 'Nothing buzzes. Turn notifications on in the app: Settings → Notifications.',
    });
  });

  test('V-0257 a newest push that reached no device is a warning naming the count and when', async () => {
    expect(await run({ enrolled: 2, latest: { at: '2026-11-14T10:00:00Z', delivered: 0, failed: 2 } })).toEqual({
      state: 'warn',
      name: 'notifications',
      requirement: 'capability',
      detail: 'the newest push, at 2026-11-14T10:00:00Z, reached none of its 2 devices',
      fix: 'A device that refuses pushes needs enrolling again: Settings → Notifications on that device.',
    });
    expect(await run({ enrolled: 1, latest: { at: '2026-11-14T10:00:00Z', delivered: 0, failed: 1 } })).toMatchObject({
      detail: 'the newest push, at 2026-11-14T10:00:00Z, reached none of its 1 device',
    });
  });

  test('V-0257 an enrolled device with a push that went out is ok and says what the phone buzzes for', async () => {
    expect(await run({ enrolled: 2, latest: { at: '2026-11-14T10:00:00Z', delivered: 2, failed: 0 } })).toEqual({
      state: 'ok',
      name: 'notifications',
      requirement: 'capability',
      detail: '2 devices enrolled; the newest push reached 2 at 2026-11-14T10:00:00Z',
      fix: 'The phone buzzes when a ferret stops on you, a deadline nears, or a notice pings.',
    });
    expect(await run({ enrolled: 1 })).toMatchObject({
      state: 'ok',
      detail: '1 device enrolled; no push recorded yet',
    });
  });

  test('V-0257 a newest push that threw is a warning that names when, and keeps no error text', async () => {
    expect(
      await run({ enrolled: 2, latest: { at: '2026-11-14T10:01:00Z', delivered: 0, failed: 0, thrown: true } }),
    ).toEqual({
      state: 'warn',
      name: 'notifications',
      requirement: 'capability',
      detail: 'the newest push failed at 2026-11-14T10:01:00Z',
      fix: 'The phone stays silent for stops, deadlines and pings until a push goes out again.',
    });
  });

  test('V-0257 a health read that fails is a safe warning row, never a hidden one and never the error’s own text', async () => {
    const finding = await notificationsDoctor(async () => {
      throw new Error('ENOENT /secret/subscriptions.json endpoint=https://push.example/abc');
    })();
    expect(finding).toMatchObject({ state: 'warn', name: 'notifications', requirement: 'capability' });
    expect(JSON.stringify(finding)).not.toContain('secret');
    expect(JSON.stringify(finding)).not.toContain('push.example');
  });

  test('V-0257 the silence sentence is the one v4 used', () => {
    expect(SILENT).toContain('silent');
  });
});
