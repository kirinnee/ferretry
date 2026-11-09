import { controlState, useEveryDaemon } from '@ferretry/app';
import { useMemo } from 'react';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { NewDeviceNotices } from './features/device-notice/new-device-notice.tsx';
import { AddDeviceSurface } from './features/settings/add-device-settings.tsx';
import { pairingClientOf, useMachineOf } from './daemon-scope.tsx';
import { DevicePermissionsSetting } from './features/settings/device-permissions-settings.tsx';
import {
  MachinesNotificationsSettings,
  NotificationsOffPanel,
} from './features/settings/machine-notifications-settings.tsx';
import type { MachineSource } from './hooks/use-machines-notifications.ts';
import type { PushHost } from './lib/push-host.ts';
import { PasskeyNudge } from './features/settings/passkey-nudge.tsx';
import { useOpenSecurity, useSelectedDaemon } from './shell-grants.ts';

/**
 * Settings › ‹machine› › Devices: add a device, and every paired device with its grants (today's Add Device). Built per
 * machine: its client reaches that machine only.
 */
export function devicesTab(client: PluginClient) {
  return function DevicesTab() {
    const connection = useMachineOf();
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
    const connection = useMachineOf();
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
 * `device.settings` › notifications: this browser's own permissions, then ONE Notifications block — the browser's
 * permission and notes once, ONE list with a row per machine (its switch, status and registered devices) and "Turn on
 * for all machines". Drawn with NO machine and no client (shell contract S4): the machines come from `useEveryDaemon`,
 * each row reads and writes only through its OWN row's client, a machine this device may not use (`not-granted`) is not
 * listed, and a locked machine says so and offers Unlock. v4's per-row Mute is Agenda's notification filter, which
 * Access has no seam to (GAP in ports-pending.json).
 */
export function NotificationsDevicePanel({ host }: { readonly host?: PushHost } = {}) {
  const rows = useEveryDaemon();
  const sources: readonly MachineSource[] = useMemo(
    () =>
      rows
        .filter(row => controlState(row.authorityOf('POST /v1/push/subscriptions')).shown)
        .map(row => ({
          daemon: row.daemon,
          label: row.machine,
          client: row.client,
          locked: row.locked,
          press: row.press,
          unlock: row.unlock,
        })),
    [rows],
  );
  return (
    <>
      <DevicePermissionsSetting />
      <MachinesNotificationsSettings sources={sources} {...(host === undefined ? {} : { host })} />
    </>
  );
}

/** `daemon.status` › notifications-off: one line when this machine has no device enrolled anywhere to push to. */
export function notificationsOffPanel(client: PluginClient) {
  return function NotificationsOff() {
    return <NotificationsOffPanel client={client} />;
  };
}
