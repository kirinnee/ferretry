import { forSubject, provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { accessClaims } from './connect.ts';
import { accessPasskey } from './step-up-shell.tsx';
import { daemonlessPlaceholder, PAIR_SCREEN_ID, pairPage } from './pair-page.tsx';
import { DeviceStep } from './features/onboarding/device-step.tsx';
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
        // The first-run step's body: what kind of device this is, only for its own step.
        'onboarding-step': forSubject('access.device', () => createElement(DeviceStep, {})),
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
  },
);
