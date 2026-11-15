/**
 * Each machine row's Mute (v4's `onToggleShown`): drawn from the `access.machine-mute` hook Agenda provides, flips the
 * machine's mute through it, and is not drawn at all without a provider.
 */
import { describe, expect, it } from 'bun:test';
import { WithAppHooks } from '@ferretry/app/testing';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { MachineNotificationList } from '../../../../../app/features/settings/notification-machines.tsx';
import { ACCESS_MACHINE_MUTE_HOOK, isAccessMachineMute } from '../../../../../contract/index.ts';
import { render, run } from '../../../../support/app/react.ts';

/** A mute that remembers what it was set to and tells its listeners. */
const fakeMute = (muted = false) => {
  const listeners = new Set<() => void>();
  const set: boolean[] = [];
  return {
    set,
    value: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      muted: () => muted,
      setMuted: (next: boolean) => {
        set.push(next);
        muted = next;
        for (const listener of listeners) listener();
      },
    },
  };
};

const row = {
  daemonId: 'home',
  label: 'Home',
  status: 'on',
  statusText: 'On',
  enrolledDevices: 1,
  shown: true,
} as const;

const list = (provided: Record<string, unknown>) =>
  render(
    <WithAppHooks provided={provided}>
      <MachineNotificationList
        rows={[row]}
        canEnrol
        busy={new Set()}
        failures={{}}
        onEnable={() => undefined}
        onDisable={() => undefined}
        onTurnOnAll={() => undefined}
        unlocks={new Map()}
        detail={() => null}
      />
    </WithAppHooks>,
  );

const buttons = (surface: ReactTestRenderer) =>
  surface.root.findAll(node => node.type === 'button' && node.props['data-machine-mute'] !== undefined);

describe('a machine row’s Mute', () => {
  it('should offer Mute on a machine this browser shows, and mute it on a press', () => {
    const mute = fakeMute();
    const surface = list({ [ACCESS_MACHINE_MUTE_HOOK]: mute.value });
    const only = (): ReactTestInstance => {
      const [found] = buttons(surface);
      if (found === undefined) throw new Error('no Mute drawn');
      return found;
    };
    expect(only().children.join('')).toBe('Mute');
    expect(only().props['aria-pressed']).toBe(false);
    run(() => (only().props.onClick as () => void)());
    expect(mute.set).toEqual([true]);
    // The row re-reads the provider: it now says Unmute, and a second press brings the machine back.
    expect(only().children.join('')).toBe('Unmute');
    expect(only().props['aria-pressed']).toBe(true);
    run(() => (only().props.onClick as () => void)());
    expect(mute.set).toEqual([true, false]);
    run(() => surface.unmount());
  });

  it('should draw no Mute when no half provides it, or the value has not the shape', () => {
    const bare = list({});
    expect(buttons(bare)).toHaveLength(0);
    run(() => bare.unmount());
    const wrong = list({ [ACCESS_MACHINE_MUTE_HOOK]: { muted: () => false } });
    expect(buttons(wrong)).toHaveLength(0);
    run(() => wrong.unmount());
  });

  it('should narrow a provided value by its three functions', () => {
    expect(isAccessMachineMute(fakeMute().value)).toBe(true);
    expect(isAccessMachineMute(null)).toBe(false);
    expect(isAccessMachineMute({ subscribe: 1, muted: 1, setMuted: 1 })).toBe(false);
  });
});
