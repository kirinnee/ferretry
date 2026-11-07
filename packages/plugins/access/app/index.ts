import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { accessClaims } from './connect.ts';
import { DevicesTab, NotificationsPanel, UnlockPanel } from './surfaces.tsx';

/**
 * Access's app half (§2.3): Devices settings, the unlock nudge and this device's notification permission, and — beside
 * them — the device claims the app shell signs every session with (`connect.ts`; only Access may provide them).
 */
export default provideToShell(
  implementApp(manifest, {
    build: () => ({
      settings: { devices: DevicesTab },
      panels: { unlock: UnlockPanel, notifications: NotificationsPanel },
    }),
  }),
  { claims: ports => accessClaims(ports) },
);
