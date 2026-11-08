import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { accessClaims } from './connect.ts';
import { accessPasskey } from './step-up-shell.tsx';
import { daemonlessPlaceholder, pairPage } from './pair-page.tsx';
import { pairPhoneCommands } from './pair-phone-host.tsx';
import { devicesTab, newDevicesPanel, notificationsOffPanel, notificationsPanel, UnlockPanel } from './surfaces.tsx';

/**
 * Access's app half (§2.3): Devices settings, the unlock nudge, this device's notification permission and this
 * machine's Web Push (its switch, its registered devices and the "Notifications are off" banner), and — beside them —
 * the device claims the app shell signs every session with (`connect.ts`) and the ONE passkey prompt every daemon
 * call's unlock or step-up refusal raises (`step-up-shell.tsx`). Only Access may provide either.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      // `pair` is daemon-less: the shell draws it from `shell.daemonless`, never from a machine's half.
      screens: { pair: daemonlessPlaceholder },
      settings: { devices: devicesTab(client) },
      panels: {
        'new-devices': newDevicesPanel(client),
        unlock: UnlockPanel,
        notifications: notificationsPanel(client),
        'notifications-off': notificationsOffPanel(client),
      },
    }),
  }),
  {
    claims: ports => accessClaims(ports),
    passkey: ports => accessPasskey(ports),
    commands: pairPhoneCommands,
    daemonless: ports => ({ pair: pairPage(ports) }),
  },
);
