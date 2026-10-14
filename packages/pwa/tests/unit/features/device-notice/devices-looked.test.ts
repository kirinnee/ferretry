import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  announceDevicesLooked,
  browserDevicesLookedStorage,
  DEVICES_LOOKED_EVENT,
  type DevicesLookedDetail,
  type DevicesLookedStorage,
  devicesLookedKey,
  readDevicesSeen,
  rememberDevicesSeen,
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

describe('which devices this browser has already seen', () => {
  it('keys every set by the machine it belongs to, stored sorted', () => {
    const storage = memory();
    rememberDevicesSeen(storage, ALPHA, new Set(['b', 'a']));
    expect([...(readDevicesSeen(storage, ALPHA) ?? [])]).toEqual(['a', 'b']);
    expect(readDevicesSeen(storage, BETA)).toBeNull();
    expect([...storage.entries.entries()]).toEqual([[devicesLookedKey(ALPHA), '["a","b"]']]);
    expect(devicesLookedKey(ALPHA)).not.toBe(devicesLookedKey(BETA));
  });

  it('ignores the instant the old key held, so an upgrade takes the first-look path', () => {
    const storage = memory();
    storage.setItem(`ferretry.devices-looked.v1:${String(ALPHA)}`, '1000');
    expect(readDevicesSeen(storage, ALPHA)).toBeNull();
  });

  it('reads nothing from a garbled, mistyped, missing or throwing store', () => {
    const storage = memory();
    storage.setItem(devicesLookedKey(ALPHA), 'not json');
    expect(readDevicesSeen(storage, ALPHA)).toBeNull();
    storage.setItem(devicesLookedKey(ALPHA), '1000');
    expect(readDevicesSeen(storage, ALPHA)).toBeNull();
    storage.setItem(devicesLookedKey(ALPHA), '["a",1]');
    expect(readDevicesSeen(storage, ALPHA)).toBeNull();
    expect(readDevicesSeen(undefined, ALPHA)).toBeNull();
    expect(readDevicesSeen(throwing, ALPHA)).toBeNull();
  });

  it('survives a store that refuses the write', () => {
    expect(() => rememberDevicesSeen(throwing, ALPHA, new Set(['a']))).not.toThrow();
    expect(() => rememberDevicesSeen(undefined, ALPHA, new Set(['a']))).not.toThrow();
  });

  it('tells this page about a look, naming the machine and the devices shown', () => {
    const seen: DevicesLookedDetail[] = [];
    const listener = (event: Event): void => void seen.push((event as CustomEvent<DevicesLookedDetail>).detail);
    window.addEventListener(DEVICES_LOOKED_EVENT, listener);
    announceDevicesLooked(ALPHA, ['a']);
    announceDevicesLooked(BETA, []);
    window.removeEventListener(DEVICES_LOOKED_EVENT, listener);
    expect(seen).toEqual([
      { daemonId: ALPHA, deviceIds: ['a'] },
      { daemonId: BETA, deviceIds: [] },
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
