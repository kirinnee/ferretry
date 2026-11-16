import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  PushDeviceListResponseSchema,
  PushDeviceViewSchema,
  RegisterPushDeviceRequestSchema,
  VapidPublicKeyResponseSchema,
} from '../../contract/index.ts';
import type { DaemonPushService } from './push-enrolment.ts';
import { pushSubscriptionJson } from './push-subscriptions.ts';

/**
 * The daemon push API through THIS half's own client (§9.6), by route key.
 *
 * The half is built once per machine against that machine's client, so a call here can only reach the machine the
 * screen is about: the `connection` the enrolment flow passes is the machine's identity for the device memory and the
 * push scope, and is never an address. Every answer is parsed by the contract's schema before it is used, and the
 * subscription is projected to the wire shape (`pushSubscriptionJson`) so an incomplete one is refused here.
 */
export const clientPushService = (client: PluginClient): DaemonPushService => ({
  vapidKey: async () => VapidPublicKeyResponseSchema.parse(await client.call('GET /v1/push/vapid')).publicKey,
  list: async () => PushDeviceListResponseSchema.parse(await client.call('GET /v1/push/subscriptions')).devices,
  register: async (_connection, subscription, deviceName) =>
    PushDeviceViewSchema.parse(
      await client.call('POST /v1/push/subscriptions', {
        body: RegisterPushDeviceRequestSchema.parse({
          deviceName,
          subscription: pushSubscriptionJson(subscription),
        }),
      }),
    ),
  revoke: async (_connection, deviceId) =>
    PushDeviceViewSchema.parse(
      await client.call('DELETE /v1/push/subscriptions/:pushId', {
        params: { pushId: PushDeviceViewSchema.shape.id.parse(deviceId) },
      }),
    ),
});
