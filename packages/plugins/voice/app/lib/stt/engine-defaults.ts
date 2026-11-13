/**
 * WHICH ENGINE A DEVICE DICTATES WITH WHEN NOBODY HAS PICKED ONE — from the on-device speech research
 * of 2026-10-22 (`research-numbers.ts`):
 *
 *   - a PHONE defaults to Parakeet TDT 110M: as accurate as Parakeet 0.6B on everyday speech, a fifth
 *     of the download, a third of the memory, and its text arrives 1.7 s after Stop on a phone-speed CPU
 *     where 0.6B takes 7.1 s;
 *   - a COMPUTER keeps Parakeet TDT 0.6B v3, the most accurate engine measured and the only multilingual
 *     one, which a desktop core runs faster than real time.
 *
 * The order is: the device's own choice (Settings › Voice), then the machine's default (`voice.yaml`,
 * chosen in setup) — whose "parakeet" means "Parakeet on this device", so a phone gets the Parakeet that
 * suits it — then this device default. A default never downloads anything: until it is installed,
 * pressing the microphone says to install it.
 *
 * "Phone" is a coarse guess, on purpose: a touch-first pointer or at most 4 GB of reported memory. A
 * tablet with a keyboard may guess either way; the person can always pick an engine in Settings.
 */

import type { OnDeviceModelId } from './model-catalog.ts';
import type { DictationEngineId } from './stt-settings.ts';

export type DeviceClass = 'phone' | 'computer';

/** The engine each kind of device dictates with by default. */
export const DEFAULT_ON_DEVICE_ENGINE: Readonly<Record<DeviceClass, OnDeviceModelId>> = {
  phone: 'parakeet-tdt-110m',
  computer: 'parakeet',
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
