import type { DeviceGrantsPatch, IFyApiClient, PairedDevicesView } from '@ferretry/protocol';

/** Presentation for the device commands. */
export interface IDeviceOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** The daemon calls the device commands need. */
export interface IDeviceGateway {
  list(): Promise<PairedDevicesView>;
  /** Answers the whole list after the change. */
  changeGrants(deviceId: string, patch: DeviceGrantsPatch): Promise<PairedDevicesView>;
}

/** The only client capability the device gateway consumes. */
export type DeviceApiClient = Pick<IFyApiClient, 'request'>;
