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
  /** Takes the device's access away; answers the list that remains. A 404 arrives as the client's typed error. */
  revoke(deviceId: string): Promise<PairedDevicesView>;
}

/** Typed-confirmation input, injected so a test never blocks on a terminal. */
export interface IDevicePrompt {
  ask(message: string): Promise<string>;
}

/** The only client capability the device gateway consumes. */
export type DeviceApiClient = Pick<IFyApiClient, 'request'>;
