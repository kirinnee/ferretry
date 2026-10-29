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
  const calls = { revoked: [] as string[] };
  const props: NotificationSettingsViewProps = {
    permission: 'granted',
    devices: [],
    currentDeviceId: null,
    onRevokeDevice: id => calls.revoked.push(id),
    ...overrides,
  };
  return { calls, renderer: render(<NotificationSettingsView {...props} />) };
};

describe('NotificationSettingsView', () => {
  it('states unsupported capability plainly', () => {
    const { renderer } = view({ permission: 'unsupported' });
    expect(JSON.stringify(renderer.toJSON())).toContain(NOTIFICATION_UNSUPPORTED_NOTE);
  });

  it('carries no enrol switch of its own: every machine is switched in the machine list', () => {
    const { renderer } = view({ permission: 'default' });
    expect(renderer.root.findAllByProps({ role: 'switch' })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain(NOTIFICATION_SCOPE_NOTE);
    expect(JSON.stringify(renderer.toJSON())).toContain(NOTIFICATION_IOS_NOTE);
  });

  it('explains a browser-denied permission and its remedy', () => {
    const { renderer } = view({ permission: 'denied' });
    expect(JSON.stringify(renderer.toJSON())).toContain(NOTIFICATION_DENIED_NOTE);
  });

  it('states the browser permission in each of its three states', () => {
    expect(JSON.stringify(view({ permission: 'default' }).renderer.toJSON())).toContain('Not asked yet');
    expect(JSON.stringify(view({ permission: 'granted' }).renderer.toJSON())).toContain('Allowed in this browser.');
    expect(JSON.stringify(view({ permission: 'denied' }).renderer.toJSON())).toContain('Blocked in this browser.');
  });

  it('revokes the exact device id', () => {
    const { calls, renderer } = view({ devices: [device], currentDeviceId: device.id });
    expect(JSON.stringify(renderer.toJSON())).toContain('· this device');
    const revoke = renderer.root.findByProps({ 'aria-label': 'Revoke push notifications for iPhone' });
    run(() => revoke.props.onClick());
    expect(calls.revoked).toEqual([device.id]);
  });
});
