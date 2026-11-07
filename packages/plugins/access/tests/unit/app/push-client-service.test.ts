import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { InstantSchema } from '@ferretry/std';
import { clientPushService } from '../../../app/lib/push-client-service.ts';

const ID = 'push-00000000-0000-4000-8000-000000000000';
const device = {
  id: ID,
  deviceName: 'kirin phone',
  createdAt: InstantSchema.parse('2026-07-31T10:00:00.000Z'),
  updatedAt: InstantSchema.parse('2026-07-31T10:05:00.000Z'),
  expirationTime: null,
};
const VAPID = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');

type Call = { readonly route: string; readonly init?: Parameters<PluginClient['call']>[1] };

const scripted = (answers: Record<string, unknown>) => {
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: Call['init']) => {
      calls.push({ route, ...(init === undefined ? {} : { init }) });
      return answers[route];
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  return { calls, service: clientPushService(client) };
};

const target = { daemonId: 'daemon-a' as never };

describe('clientPushService', () => {
  it('reads the VAPID key, and the device list, through the half’s own client by route key', async () => {
    const { calls, service } = scripted({
      'GET /v1/push/vapid': { publicKey: VAPID },
      'GET /v1/push/subscriptions': { devices: [device] },
    });
    expect(await service.vapidKey(target)).toBe(VAPID);
    expect(await service.list(target)).toEqual([device]);
    expect(calls.map(call => call.route)).toEqual(['GET /v1/push/vapid', 'GET /v1/push/subscriptions']);
  });

  it('enrols a subscription under the typed device name and sends only the wire shape', async () => {
    const { calls, service } = scripted({ 'POST /v1/push/subscriptions': device });
    const stored = await service.register(
      target,
      {
        toJSON: () => ({
          endpoint: 'https://fcm.googleapis.com/x',
          expirationTime: null,
          keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
        }),
      },
      'kirin phone',
    );
    expect(stored).toEqual(device);
    const body = calls[0]?.init?.body as { deviceName: string; subscription: { endpoint: string } };
    expect(body.deviceName).toBe('kirin phone');
    expect(Object.keys(body).sort()).toEqual(['deviceName', 'subscription']);
  });

  it('refuses an incomplete subscription before anything is sent', async () => {
    const { calls, service } = scripted({});
    await expect(
      service.register(target, { toJSON: () => ({ endpoint: 'https://x.example.test' }) }, 'x'),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('revokes one device by id through the :pushId route', async () => {
    const { calls, service } = scripted({ 'DELETE /v1/push/subscriptions/:pushId': device });
    await service.revoke(target, ID);
    expect(calls).toEqual([{ route: 'DELETE /v1/push/subscriptions/:pushId', init: { params: { pushId: ID } } }]);
  });

  it('refuses an answer that is not a device, and an id that is not one', async () => {
    const { service } = scripted({ 'GET /v1/push/subscriptions': { devices: [{ id: 'x' }] } });
    await expect(service.list(target)).rejects.toThrow();
    await expect(service.revoke(target, '../../etc')).rejects.toThrow();
  });
});
