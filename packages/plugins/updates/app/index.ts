import { type BackgroundViewProps, provideToShell, type ShellProvides } from '@ferretry/app';
import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

type ViewName = 'updates-settings' | 'behind-panel';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

/** Drawn from `shell.deviceSettings` (no daemon), never from a machine's half, so the per-daemon entry draws nothing. */
const notDrawnPerDaemon: AppComponent<PanelProps> = () => null;

/**
 * The install offer's `device.settings` panel (Settings › This device › Install app, S4): no daemon and no client,
 * because it reads only this device's install prompt (`useInstallPrompt`, S13).
 */
const installAppPanel = lazyComponent<Record<string, never>>(
  async () => (await import('./views/install-offer.tsx')).InstallAppPanel as AppComponent<Record<string, never>>,
) as NonNullable<ShellProvides['deviceSettings']>[string];

/**
 * The install offer's `background` toast (S5): mounted once per paired machine at the frame root, it draws on the
 * first machine's mount only, because the offer is this device's and not a machine's.
 */
const installToast = lazyComponent<BackgroundViewProps>(
  async () => (await import('./views/install-offer.tsx')).InstallToast as AppComponent<BackgroundViewProps>,
) as NonNullable<ShellProvides['background']>[string];

/**
 * Updates' app half: its Settings tab (how this daemon was installed, whether it is behind, the update and the
 * automatic-install switch), the `behind` notice on the daemon-status panel, and the offer to install Ferretry as an
 * app — a `device.settings` panel and a `background` toast over the shell's install prompt.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      settings: {
        updates: lazyComponent<SettingsProps>(async () => {
          const view = await loadView('updates-settings');
          return (view.createSettings as (client: unknown) => AppComponent<SettingsProps>)(client);
        }),
      },
      panels: {
        behind: lazyComponent<PanelProps>(async () => {
          const view = await loadView('behind-panel');
          return (view.createPanel as (client: unknown) => AppComponent<PanelProps>)(client);
        }),
        'install-app': notDrawnPerDaemon,
      },
    }),
  }),
  { deviceSettings: { 'install-app': installAppPanel }, background: { 'install-offer': installToast } },
);
