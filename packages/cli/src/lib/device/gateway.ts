import {
  type DeviceGrantsPatch,
  DeviceGrantsPatchSchema,
  type PairedDevicesView,
  PairedDevicesViewSchema,
} from '@ferretry/protocol';
import type { DeviceApiClient, IDeviceGateway } from './ports.ts';

export const PAIRED_DEVICES_PATH = '/v1/pair/devices';

/**
 * Speaks the paired-device routes through the protocol client.
 *
 * Both directions are parsed rather than cast, so a daemon that answered an older shape surfaces as a
 * stated failure instead of an undefined field deep inside rendering.
 */
export class ProtocolDeviceGateway implements IDeviceGateway {
  constructor(private readonly client: DeviceApiClient) {}

  async list(): Promise<PairedDevicesView> {
    return await this.client.request(PAIRED_DEVICES_PATH, PairedDevicesViewSchema);
  }

  async changeGrants(deviceId: string, patch: DeviceGrantsPatch): Promise<PairedDevicesView> {
    return await this.client.request(
      `${PAIRED_DEVICES_PATH}/${encodeURIComponent(deviceId)}/grants`,
      PairedDevicesViewSchema,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(DeviceGrantsPatchSchema.parse(patch)),
      },
    );
  }

  async revoke(deviceId: string): Promise<PairedDevicesView> {
    return await this.client.request(
      `${PAIRED_DEVICES_PATH}/${encodeURIComponent(deviceId)}`,
      PairedDevicesViewSchema,
      {
        method: 'DELETE',
      },
    );
  }
}
