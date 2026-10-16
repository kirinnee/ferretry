import { describe, expect, it } from 'bun:test';
import type { PushDeviceView } from '@ferretry/protocol';

import {
  NOTIFICATION_DENIED_NOTE,
  NOTIFICATION_IOS_NOTE,
  NOTIFICATION_SCOPE_NOTE,
  NOTIFICATION_UNSUPPORTED_NOTE,
  NotificationSettingsView,
  type NotificationSettingsViewProps,
} from '../../../../src/features/settings/notification-settings.tsx';
import { render, run } from '../../../support/react.ts';

const device: PushDeviceView = {
  id: 'push-5b2b54ad-e4a3-4f96-923f-95bd960ef61b',
  deviceName: 'iPhone',
  createdAt: '2026-07-31T12:00:00.000Z',
  updatedAt: '2026-07-31T12:00:00.000Z',
  expirationTime: null,
};

const view = (overrides: Partial<NotificationSettingsViewProps> = {}) => {
  const calls = { enabled: [] as boolean[], revoked: [] as string[] };
  const props: NotificationSettingsViewProps = {
    permission: 'granted',
    enabled: true,
    delivery: 'active',
    devices: [],
    currentDeviceId: null,
    onEnabled: enabled => calls.enabled.push(enabled),
    onRevokeDevice: id => calls.revoked.push(id),
    ...overrides,
  };
  return { calls, renderer: render(<NotificationSettingsView {...props} />) };
};

describe('NotificationSettingsView', () => {
  it('states unsupported capability plainly without offering a non-working switch', () => {
    const { renderer } = view({ permission: 'unsupported' });
    expect(JSON.stringify(renderer.toJSON())).toContain(NOTIFICATION_UNSUPPORTED_NOTE);
    expect(renderer.root.findAllByProps({ role: 'switch' })).toHaveLength(0);
  });

  it('keeps notifications quiet until browser permission and a device preference are both active', () => {
    const { renderer } = view({ permission: 'default', enabled: true });
    const switches = renderer.root.findAllByProps({ role: 'switch' });
    expect(switches).toHaveLength(1);
    expect(switches[0]?.props['aria-checked']).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).toContain(NOTIFICATION_SCOPE_NOTE);
    expect(JSON.stringify(renderer.toJSON())).toContain(NOTIFICATION_IOS_NOTE);
  });

  it('disables a browser-denied master switch and explains the remedy', () => {
    const { renderer } = view({ permission: 'denied' });
    const master = renderer.root.findByProps({ role: 'switch' });
    expect(master.props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain(NOTIFICATION_DENIED_NOTE);
  });

  it('reports an in-progress Web Push registration without claiming closed-app delivery is ready', () => {
    const { renderer } = view({ delivery: 'checking' });
    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain('Checking closed-app Web Push');
    expect(tree).not.toContain('closed-app delivery is ready');
  });

  it('flips only the master switch, never inventing daemon-global state', () => {
    const { calls, renderer } = view();
    const master = renderer.root.findByProps({ role: 'switch' });
    run(() => master.props.onClick());
    expect(calls.enabled).toEqual([false]);
  });

  it('keeps all settings controls at the touch-target floor and revokes the exact device id', () => {
    const { calls, renderer } = view({ devices: [device], currentDeviceId: device.id });
    const switches = renderer.root.findAllByProps({ role: 'switch' });
    expect(switches).toHaveLength(1);
    for (const toggle of switches) expect(toggle.props.className).toContain('min-h-[44px]');
    expect(JSON.stringify(renderer.toJSON())).toContain('closed-app delivery is ready');
    expect(JSON.stringify(renderer.toJSON())).toContain('· this device');
    const revoke = renderer.root.findByProps({ 'aria-label': 'Revoke push notifications for iPhone' });
    run(() => revoke.props.onClick());
    expect(calls.revoked).toEqual([device.id]);
  });
});
