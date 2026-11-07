import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { accessClaims } from './connect.ts';
import { DevicesTab, notificationsOffPanel, notificationsPanel, UnlockPanel } from './surfaces.tsx';

/**
 * Access's app half (§2.3): Devices settings, the unlock nudge, this device's notification permission and this machine's Web Push (its switch,
 * its registered devices and the "Notifications are off" banner), and — beside
 * them — the device claims the app shell signs every session with (`connect.ts`; only Access may provide them).
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      settings: { devices: DevicesTab },
      panels: {
        unlock: UnlockPanel,
        notifications: notificationsPanel(client),
        'notifications-off': notificationsOffPanel(client),
      },
    }),
  }),
  { claims: ports => accessClaims(ports) },
);
