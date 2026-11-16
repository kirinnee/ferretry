import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { accessClaims } from './connect.ts';
import { accessPasskey } from './step-up-shell.tsx';
import { daemonlessPlaceholder, PAIR_SCREEN_ID, pairPage } from './pair-page.tsx';
import { pairPhoneCommands } from './pair-phone-host.tsx';
import {
  devicesTab,
  grantsTab,
  newDevicesPanel,
  NotificationsDevicePanel,
  notificationsOffPanel,
  securityLogTab,
  securityTab,
  UnlockPanel,
} from './surfaces.tsx';

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
      settings: {
        devices: devicesTab(client),
        grants: grantsTab(client),
        security: securityTab(client),
        audit: securityLogTab(client),
      },
      panels: {
        'new-devices': newDevicesPanel(client),
        unlock: UnlockPanel,
        // Drawn from `shell.deviceSettings` below (no machine), never from a machine's half.
        notifications: () => null,
        'notifications-off': notificationsOffPanel(client),
      },
    }),
  }),
  {
    claims: ports => accessClaims(ports),
    passkey: ports => accessPasskey(ports),
    commands: pairPhoneCommands,
    // A pairing link's fragment on `/pair` is a live credential: the shell takes it off the address bar and the history
    // entry before the first render and before this half's lazy chunk (shell contract S3); `/pair` takes it from there.
    fragments: [{ form: 'path', screen: PAIR_SCREEN_ID }],
    daemonless: ports => ({ pair: pairPage(ports) }),
    // Settings › This device: this browser's permissions and each machine's Web Push, one section per machine (S4).
    deviceSettings: { notifications: NotificationsDevicePanel },
  },
);
