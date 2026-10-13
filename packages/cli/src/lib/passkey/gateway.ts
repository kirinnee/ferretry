import {
  PASSKEY_WINDOW_PATH,
  type PairedDevice,
  type PairedDeviceId,
  PairedDevicesViewSchema,
  type PasskeyWindowOpened,
  PasskeyWindowOpenedSchema,
  PasskeyWindowRequestSchema,
} from '@ferretry/protocol';
import type { IPasskeyGateway, PasskeyApiClient } from './ports.ts';

/** The paired-device registry, read to turn what the owner typed into a device id. */
export const PAIRED_DEVICES_PATH = '/v1/pair/devices';

/**
 * Speaks the two routes this verb needs through the protocol client.
 *
 * Both answers are parsed rather than cast, so a daemon that answered an error envelope or an older
 * shape fails here with a stated reason instead of as an `undefined` inside a sentence. The refusals
 * are NOT caught here: they arrive as the client's typed errors and the controller words each one.
 */
export class ProtocolPasskeyGateway implements IPasskeyGateway {
  constructor(private readonly client: PasskeyApiClient) {}

  async devices(): Promise<readonly PairedDevice[]> {
    return (await this.client.request(PAIRED_DEVICES_PATH, PairedDevicesViewSchema)).devices;
  }

  async openWindow(deviceId: PairedDeviceId): Promise<PasskeyWindowOpened> {
    return await this.client.request(PASSKEY_WINDOW_PATH, PasskeyWindowOpenedSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PasskeyWindowRequestSchema.parse({ deviceId })),
    });
  }
}
