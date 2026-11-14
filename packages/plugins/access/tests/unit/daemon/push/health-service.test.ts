import { describe, expect, test } from 'bun:test';
import { notificationsDoctor } from '../../../../daemon/lib/push/health.ts';
import { PushService } from '../../../../daemon/lib/push/index.ts';
import { AT, deviceId, pushId, subscription } from './support.ts';

const enrolled = {
  id: pushId('a'),
  deviceId: deviceId('a'),
  deviceName: 'Phone',
  subscription: subscription('https://push.example/secret-endpoint-token'),
  createdAt: AT,
  updatedAt: AT,
};

const payload = {
  version: 1 as const,
  eventKey: 'e1',
  title: 'Needs you',
  body: 'Fixture',
  tag: 't1',
  url: '/',
  count: 1,
  sessionId: 's1',
  kind: 'agenda' as const,
};

/** A push service whose store, transport and clock a test breaks on purpose. */
function world() {
  const state = { storeFails: false, transportFails: false, at: '2026-11-14T10:00:00.000Z' };
  const service = new PushService({
    store: {
      list: async () => {
        if (state.storeFails) throw new Error('fixture store read failure /secret/path');
        return [enrolled];
      },
      save: async () => {},
      forget: async () => 0,
    },
    transport: {
      deliver: async () => {
        if (state.transportFails) throw new Error('fixture transport failure');
        return 'delivered';
      },
    },
    keys: { publicKey: async () => 'fixture-public' },
    devices: { granted: async () => new Set([enrolled.deviceId]) },
    clock: { now: () => state.at },
    ids: { next: () => 'fixture' },
  });
  const doctor = notificationsDoctor(async () => {
    const latest = service.latestOutcome();
    return { enrolled: (await service.list()).length, ...(latest === undefined ? {} : { latest }) };
  });
  return { state, service, doctor };
}

describe('the push service and the notifications row, together (v4 notificationHealthChecks: a newer failure beats an older success)', () => {
  test('V-0257 a push that throws after a success makes the row warn, and the caller still sees the error', async () => {
    const { state, service, doctor } = world();
    await service.notify({ payload });
    expect(await doctor()).toMatchObject({ state: 'ok' });
    state.at = '2026-11-14T10:01:00.000Z';
    state.storeFails = true;
    await expect(service.notify({ payload })).rejects.toThrow('fixture store read failure');
    state.storeFails = false;
    const finding = await doctor();
    expect(finding).toMatchObject({ state: 'warn', detail: 'the newest push failed at 2026-11-14T10:01:00.000Z' });
    expect(JSON.stringify(finding)).not.toContain('secret');
  });

  test('V-0257 a failure inside the fan-out (the transport) counts the same, and only a LATER success supersedes it', async () => {
    const { state, service, doctor } = world();
    state.transportFails = true;
    state.at = '2026-11-14T10:02:00.000Z';
    await expect(service.notify({ payload })).rejects.toThrow('fixture transport failure');
    expect(await doctor()).toMatchObject({
      state: 'warn',
      detail: 'the newest push failed at 2026-11-14T10:02:00.000Z',
    });
    state.transportFails = false;
    state.at = '2026-11-14T10:03:00.000Z';
    await service.notify({ payload });
    expect(await doctor()).toMatchObject({
      state: 'ok',
      detail: '1 device enrolled; the newest push reached 1 at 2026-11-14T10:03:00.000Z',
    });
  });

  test('V-0257 a failing health read is a warning row with no error text or subscription data, however long it persists', async () => {
    const { state, doctor } = world();
    state.storeFails = true;
    for (let read = 0; read < 3; read += 1) {
      const finding = await doctor();
      expect(finding).toMatchObject({ state: 'warn', name: 'notifications' });
      expect(JSON.stringify(finding)).not.toContain('secret');
      expect(JSON.stringify(finding)).not.toContain('push.example');
    }
  });
});
