import type { IFyApiClient, PairedDevice, PairedDeviceId, PasskeyWindowOpened } from '@ferretry/protocol';

/** Presentation for `fy passkey`: one plain sentence to stdout, or one to stderr with a non-zero exit. */
export interface IPasskeyOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/**
 * The daemon calls the recovery verb needs.
 *
 * `devices` is how a NAME becomes an id, and the id is what the route takes: the daemon has no notion
 * of a device name as an address, because two phones can call themselves the same thing.
 */
export interface IPasskeyGateway {
  devices(): Promise<readonly PairedDevice[]>;
  openWindow(deviceId: PairedDeviceId): Promise<PasskeyWindowOpened>;
}

/**
 * Turns an instant into the clock time a person reads off the wall in THIS machine's zone.
 *
 * A port because "local" is the process's zone and locale, which the pure domain may not read — and so
 * a test can state the sentence it expects rather than whatever zone the CI runner happens to be in.
 */
export interface IPasskeyLocalTime {
  clockTime(instant: string): string;
}

/** The only client capability the passkey gateway consumes. */
export type PasskeyApiClient = Pick<IFyApiClient, 'request'>;
