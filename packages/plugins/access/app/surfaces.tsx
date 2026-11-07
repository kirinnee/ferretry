import type { PanelProps } from '@ferretry/kernel/manifest';
import { AddDeviceSurface } from './features/settings/add-device-settings.tsx';
import { DevicePermissionsSetting } from './features/settings/device-permissions-settings.tsx';
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

/** `device.settings` › notifications: this browser's own permissions (notifications among them). */
export function NotificationsPanel() {
  return <DevicePermissionsSetting />;
}

/** Access's app half (§2.3): Devices settings, the unlock nudge and this device's notification permission. */
