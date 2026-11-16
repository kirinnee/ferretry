import {
  type PairedDevice,
  type PairedDeviceId,
  PairedDevicesViewSchema,
  type PasskeyWindowOpened,
  PasskeyWindowOpenedSchema,
  PasskeyWindowRequestSchema,
} from '../../../contract/index.ts';
import { callDaemon } from '../../shell.ts';
import type { IPasskeyGateway, PasskeyApiClient } from './ports.ts';

/** The paired-device registry, read to turn what the owner typed into a device id. */
export const PAIRED_DEVICES_PATH = '/v1/pair/devices';

/** The route keys this gateway calls, exactly as `manifest.ts` declares them. */
export const PASSKEY_ROUTES = {
  devices: 'GET /v1/pair/devices',
  openWindow: 'POST /v1/passkeys/registration-window',
} as const;

/**
 * Speaks the two routes this verb needs through the plugin client.
 *
 * Both answers are parsed rather than cast, so a daemon that answered an error envelope or another
 * shape fails here with a stated reason instead of as an `undefined` inside a sentence. The refusals
 * are NOT caught here: they arrive as the client's typed errors and the controller words each one.
 */
export class ProtocolPasskeyGateway implements IPasskeyGateway {
  constructor(private readonly client: PasskeyApiClient) {}

  async devices(): Promise<readonly PairedDevice[]> {
    return PairedDevicesViewSchema.parse(await callDaemon(this.client, PASSKEY_ROUTES.devices)).devices;
  }

  async openWindow(deviceId: PairedDeviceId): Promise<PasskeyWindowOpened> {
    return PasskeyWindowOpenedSchema.parse(
      await callDaemon(this.client, PASSKEY_ROUTES.openWindow, {
        body: PasskeyWindowRequestSchema.parse({ deviceId }),
      }),
    );
  }
}
