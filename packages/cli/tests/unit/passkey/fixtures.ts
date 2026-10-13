import { DEFAULT_DEVICE_GRANTS, type PairedDevice, type PairedDeviceId, type PasskeyWindowOpened } from '@ferretry/protocol';
import type { IPasskeyGateway, IPasskeyLocalTime, IPasskeyOutput } from '../../../src/lib/passkey/ports';

export const PIXEL_ID = `fy_device_id_${'a'.repeat(22)}` as PairedDeviceId;
export const LAPTOP_ID = `fy_device_id_${'b'.repeat(22)}` as PairedDeviceId;
const OTHER_LAPTOP_ID = `fy_device_id_${'c'.repeat(22)}` as PairedDeviceId;
export const CLOSES_AT = '2026-10-13T14:32:00.000Z';

export const device = (id: PairedDeviceId, name: string): PairedDevice => ({
  id,
  name,
  platform: 'browser',
  createdAt: '2026-10-01T09:00:00.000Z',
  lastSeenAt: '2026-10-12T09:00:00.000Z',
  idleExpiresAt: '2026-11-11T09:00:00.000Z',
  grants: DEFAULT_DEVICE_GRANTS,
});

export const PIXEL = device(PIXEL_ID, 'Pixel 8');
export const LAPTOP = device(LAPTOP_ID, 'Chrome');
export const OTHER_LAPTOP = device(OTHER_LAPTOP_ID, 'Chrome');

export class RecordingOutput implements IPasskeyOutput {
  readonly messages: string[] = [];
  readonly errors: string[] = [];
  exitCode: number | undefined;

  success(message: string): void {
    this.messages.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }
}

/** A gateway that lists fixed devices and either opens a window or fails with a chosen error. */
export class ScriptedGateway implements IPasskeyGateway {
  readonly opened: PairedDeviceId[] = [];

  constructor(
    private readonly listed: readonly PairedDevice[],
    private readonly failure?: unknown,
  ) {}

  async devices(): Promise<readonly PairedDevice[]> {
    return this.listed;
  }

  async openWindow(deviceId: PairedDeviceId): Promise<PasskeyWindowOpened> {
    this.opened.push(deviceId);
    if (this.failure !== undefined) throw this.failure;
    const named = this.listed.find(candidate => candidate.id === deviceId);
    return { deviceId, deviceName: named?.name ?? 'unknown', closesAt: CLOSES_AT };
  }
}

/** Reads the clock in a zone the test names, so the sentence it expects never depends on the runner's. */
export class FixedLocalTime implements IPasskeyLocalTime {
  readonly asked: string[] = [];

  clockTime(instant: string): string {
    this.asked.push(instant);
    return '14:32';
  }
}
