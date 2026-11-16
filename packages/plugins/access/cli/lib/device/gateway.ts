import {
  type DeviceGrantsPatch,
  DeviceGrantsPatchSchema,
  type PairedDevicesView,
  PairedDevicesViewSchema,
} from '../../../contract/index.ts';
import { callDaemon } from '../../shell.ts';
import type { DeviceApiClient, IDeviceGateway } from './ports.ts';

export const PAIRED_DEVICES_PATH = '/v1/pair/devices';

/** The route keys this gateway calls, exactly as `manifest.ts` declares them. */
export const DEVICE_ROUTES = {
  list: 'GET /v1/pair/devices',
  changeGrants: 'PATCH /v1/pair/devices/:deviceId/grants',
  revoke: 'DELETE /v1/pair/devices/:deviceId',
} as const;

/**
 * Speaks the paired-device routes through the plugin client.
 *
 * Both directions are parsed rather than cast, so a daemon that answered another shape surfaces as a
 * stated failure instead of an undefined field deep inside rendering.
 */
export class ProtocolDeviceGateway implements IDeviceGateway {
  constructor(private readonly client: DeviceApiClient) {}

  async list(): Promise<PairedDevicesView> {
    return PairedDevicesViewSchema.parse(await callDaemon(this.client, DEVICE_ROUTES.list));
  }

  async changeGrants(deviceId: string, patch: DeviceGrantsPatch): Promise<PairedDevicesView> {
    return PairedDevicesViewSchema.parse(
      await callDaemon(this.client, DEVICE_ROUTES.changeGrants, {
        params: { deviceId },
        body: DeviceGrantsPatchSchema.parse(patch),
      }),
    );
  }

  async revoke(deviceId: string): Promise<PairedDevicesView> {
    return PairedDevicesViewSchema.parse(await callDaemon(this.client, DEVICE_ROUTES.revoke, { params: { deviceId } }));
  }
}
