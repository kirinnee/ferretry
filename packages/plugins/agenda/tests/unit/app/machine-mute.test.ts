/**
 * One machine's mute over the device-wide notification filter: what Agenda provides to Access's row.
 */

import { describe, expect, it } from 'bun:test';
import { machineMute } from '../../../app/lib/machine-mute.ts';
import { DeviceNotificationFilterStore } from '../../../app/lib/notification-filter.ts';

const mute = (daemon: string, store = new DeviceNotificationFilterStore()) => ({
  store,
  mute: machineMute(daemon, () => store),
});

describe('machineMute', () => {
  it('is not muted until it is set, and setting it writes the filter the worker reads', () => {
    const { store, mute: home } = mute('home');
    expect(home.muted()).toBe(false);
    home.setMuted(true);
    expect(home.muted()).toBe(true);
    expect(store.get().machines).toEqual({ home: false });
  });

  it('mutes one machine only, and unmuting brings it back', () => {
    const { store, mute: home } = mute('home');
    const desk = machineMute('desk', () => store);
    home.setMuted(true);
    expect(desk.muted()).toBe(false);
    home.setMuted(false);
    expect(home.muted()).toBe(false);
  });

  it('tells a listener when the mute changes, and stops once it is released', () => {
    const { mute: home } = mute('home');
    let told = 0;
    const release = home.subscribe(() => {
      told += 1;
    });
    home.setMuted(true);
    release();
    home.setMuted(false);
    expect(told).toBe(1);
  });

  it('reaches the one device-wide store when none is handed in', () => {
    const real = machineMute('machine-mute-test');
    expect(typeof real.muted()).toBe('boolean');
    expect(typeof real.subscribe(() => undefined)).toBe('function');
  });
});
