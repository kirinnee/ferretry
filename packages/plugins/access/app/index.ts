import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { DevicesTab, NotificationsPanel, UnlockPanel } from './surfaces.tsx';

/** Access's app half (§2.3): Devices settings, the unlock nudge and this device's notification permission. */
export default implementApp(manifest, {
  build: () => ({
    settings: { devices: DevicesTab },
    panels: { unlock: UnlockPanel, notifications: NotificationsPanel },
  }),
});
