/**
 * WHICH ENGINE A DEVICE DICTATES WITH WHEN NOBODY HAS PICKED ONE — from the on-device speech research
 * of 2026-10-22 (`research-numbers.ts`), and the owner's call of 2026-11-20 ("voice default to parakeet 110M"):
 *
 *   - EVERY device, phone or computer, defaults to Parakeet TDT 110M: as accurate as Parakeet 0.6B on
 *     everyday speech, a fifth of the download, a third of the memory, and its text arrives 1.7 s after
 *     Stop on a phone-speed CPU where 0.6B takes 7.1 s;
 *   - Parakeet TDT 0.6B v3 stays one press away under "Show every engine": it is the most accurate engine
 *     measured and the only multilingual one, for a person who picks it. A pick is never changed — only an
 *     unset engine reads as 110M.
 *
 * The order is: the device's own choice (Settings › Voice), then the machine's default (`voice.yaml`,
 * chosen in setup) — whose "parakeet" means "Parakeet on this device", so it resolves to this device
 * default — then this device default. A default never downloads anything: until it is installed,
 * pressing the microphone says to install it.
 *
 * "Phone" is still a coarse guess (a touch-first pointer or at most 4 GB of reported memory); it no longer
 * changes the default engine, but a device class keeps its own table so the two can differ again.
 */

import type { OnDeviceModelId } from './model-catalog.ts';
import type { DictationEngineId } from './stt-settings.ts';

export type DeviceClass = 'phone' | 'computer';

/** The engine each kind of device dictates with by default. */
export const DEFAULT_ON_DEVICE_ENGINE: Readonly<Record<DeviceClass, OnDeviceModelId>> = {
  phone: 'parakeet-tdt-110m',
  computer: 'parakeet-tdt-110m',
};

/** The slice of the page the guess reads. */
export interface DeviceClassGlobalLike {
  matchMedia?(query: string): { readonly matches: boolean };
  readonly navigator?: { readonly deviceMemory?: unknown };
}

/** A phone when its main pointer is a finger or it reports at most 4 GB of memory; a computer otherwise. */
export const deviceClassOf = (global: DeviceClassGlobalLike): DeviceClass => {
  const memory = global.navigator?.deviceMemory;
  const touchFirst = global.matchMedia?.('(pointer: coarse)').matches === true;
  return touchFirst || (typeof memory === 'number' && memory <= 4) ? 'phone' : 'computer';
};

/** The engine this device dictates with: its own choice, else the machine's default, else the device's. */
export const effectiveEngine = (
  chosen: DictationEngineId | null,
  machineDefault: 'parakeet' | 'browser' | null,
  device: DeviceClass,
): DictationEngineId => {
  if (chosen !== null) return chosen;
  if (machineDefault === 'browser') return 'browser';
  return DEFAULT_ON_DEVICE_ENGINE[device];
};
