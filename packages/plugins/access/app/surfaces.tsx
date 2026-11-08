import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { NewDeviceNotices } from './features/device-notice/new-device-notice.tsx';
import { AddDeviceSurface } from './features/settings/add-device-settings.tsx';
import { pairingClientOf, useMachineOf } from './daemon-scope.tsx';
import { DevicePermissionsSetting } from './features/settings/device-permissions-settings.tsx';
import {
  MachineNotificationsSettings,
  NotificationsOffPanel,
} from './features/settings/machine-notifications-settings.tsx';
import { PasskeyNudge } from './features/settings/passkey-nudge.tsx';
import { useOpenSecurity, useSelectedDaemon } from './shell-grants.ts';

/**
 * Settings › ‹machine› › Devices: add a device, and every paired device with its grants (today's Add Device). Built per
 * machine: its client reaches that machine only.
 */
export function devicesTab(client: PluginClient) {
  return function DevicesTab() {
    const connection = useMachineOf(client);
    return connection === undefined ? null : (
      <AddDeviceSurface connection={connection} createClient={async () => pairingClientOf(client)} />
    );
  };
}

/**
 * `daemon.status` › new-devices: "a new device was paired with this machine", told to every other device (today's
 * `NewDeviceNotices`, one machine at a time because the half is built per machine). Reads this machine's device list
 * through Access's own client; a read that fails says nothing.
 */
export function newDevicesPanel(client: PluginClient) {
  const clients = { client: async () => pairingClientOf(client) };
  return function NewDevicesPanel() {
    const connection = useMachineOf(client);
    return connection === undefined ? null : <NewDeviceNotices connections={[connection]} clients={clients} />;
  };
}

/** `daemon.status` › unlock: the one dismissible line asking for a passkey on a machine with none (P130). */
export function UnlockPanel({ subject }: PanelProps) {
  const connection = useSelectedDaemon(subject);
  const openSecurity = useOpenSecurity();
  return connection === undefined ? null : <PasskeyNudge connection={connection} onOpenSecurity={openSecurity} />;
}

/**
 * `device.settings` › notifications: this browser's own permissions (notifications among them), and beneath them this
 * machine's Web Push — the permission, the switch that enrols this browser with it, and its registered devices.
 * Built per machine: the half's client reaches that machine only.
 */
export function notificationsPanel(client: PluginClient) {
  return function NotificationsPanel() {
    return (
      <>
        <DevicePermissionsSetting />
        <MachineNotificationsSettings client={client} />
      </>
    );
  };
}

/** `daemon.status` › notifications-off: one line when this machine has no device enrolled anywhere to push to. */
export function notificationsOffPanel(client: PluginClient) {
  return function NotificationsOff() {
    return <NotificationsOffPanel client={client} />;
  };
}
