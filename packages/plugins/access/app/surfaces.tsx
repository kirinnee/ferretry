import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { GrantsSurface } from './features/settings/grants-settings.tsx';
import { SecurityLogSurface } from './features/settings/security-log-settings.tsx';
import { connectionOfClient, gateRouteClient } from './lib/gate-client.ts';
import { AddDeviceSurface } from './features/settings/add-device-settings.tsx';
import { DevicePermissionsSetting } from './features/settings/device-permissions-settings.tsx';
import {
  MachineNotificationsSettings,
  NotificationsOffPanel,
} from './features/settings/machine-notifications-settings.tsx';
import { PasskeyNudge } from './features/settings/passkey-nudge.tsx';
import { useOpenSecurity, useSelectedDaemon } from './shell-grants.ts';

/** Settings › ‹machine› › Devices: add a device, and every paired device with its grants (today's Add Device). */
export function DevicesTab() {
  const connection = useSelectedDaemon();
  return connection === undefined ? null : <AddDeviceSurface connection={connection} />;
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

/**
 * Settings › ‹machine› › Grants: what a caller NOT on this host may do, from Gate's `/v1/grants` through this half's
 * client. A widen from a remote device is refused by Gate and the screen shows its sentence (G111-G113).
 */
export function grantsTab(client: PluginClient) {
  const routed = gateRouteClient(client);
  const createClient = async () => routed;
  return function GrantsTab() {
    const connection = connectionOfClient(client);
    return connection === undefined ? null : <GrantsSurface connection={connection} createClient={createClient} />;
  };
}

/** Settings › ‹machine› › Audit log: recent pairings, removals and refusals, from Gate's `/v1/audit`. */
export function auditTab(client: PluginClient) {
  const routed = gateRouteClient(client);
  const createClient = async () => routed;
  return function AuditTab() {
    const connection = connectionOfClient(client);
    return connection === undefined ? null : (
      <SecurityLogSurface connection={connection} createClient={createClient} />
    );
  };
}
