import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  browserDevicesLookedStorage,
  DEVICES_LOOKED_EVENT,
  type DevicesLookedDetail,
  type DevicesLookedStorage,
  devicesLookedKey,
  markDevicesLooked,
  readDevicesLooked,
} from '../../../../src/features/device-notice/devices-looked.ts';
import type { DaemonId } from '../../../../src/lib/daemon-connection.ts';

const ALPHA = 'alpha' as DaemonId;
const BETA = 'beta' as DaemonId;

const memory = (): DevicesLookedStorage & { readonly entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  };
};

const throwing: DevicesLookedStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
});

describe('when this browser last looked at the devices', () => {
  it('keys every instant by the machine it belongs to', () => {
    const storage = memory();
    markDevicesLooked(storage, ALPHA, 1_000);
    expect(readDevicesLooked(storage, ALPHA)).toBe(1_000);
    expect(readDevicesLooked(storage, BETA)).toBeNull();
    expect([...storage.entries.keys()]).toEqual([devicesLookedKey(ALPHA)]);
    expect(devicesLookedKey(ALPHA)).not.toBe(devicesLookedKey(BETA));
  });

  it('reads nothing from a garbled, missing or throwing store', () => {
    const storage = memory();
    storage.setItem(devicesLookedKey(ALPHA), 'not a number');
    expect(readDevicesLooked(storage, ALPHA)).toBeNull();
    expect(readDevicesLooked(undefined, ALPHA)).toBeNull();
    expect(readDevicesLooked(throwing, ALPHA)).toBeNull();
  });

  it('tells this page about a mark even when storage refuses it', () => {
    const seen: DevicesLookedDetail[] = [];
    const listener = (event: Event): void => void seen.push((event as CustomEvent<DevicesLookedDetail>).detail);
    window.addEventListener(DEVICES_LOOKED_EVENT, listener);
    markDevicesLooked(throwing, ALPHA, 5);
    markDevicesLooked(undefined, BETA, 6);
    window.removeEventListener(DEVICES_LOOKED_EVENT, listener);
    expect(seen).toEqual([
      { daemonId: ALPHA, at: 5 },
      { daemonId: BETA, at: 6 },
    ]);
  });

  it('finds the browser store, or nothing when the property itself throws', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memory() });
    expect(browserDevicesLookedStorage()).toBeDefined();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    expect(browserDevicesLookedStorage()).toBeUndefined();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    expect(browserDevicesLookedStorage()).toBeUndefined();
  });
});
