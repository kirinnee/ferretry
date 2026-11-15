import { provideToShell } from '@ferretry/app';
import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import manifest from '../manifest.ts';
import { whatsNewCommands } from './commands.ts';
import { lazyComponent } from './lazy.ts';

type ViewName = 'updates-settings' | 'behind-panel' | 'whats-new-panel';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

/**
 * Updates' app half: its Settings tab (how this daemon was installed, whether it is behind, the update and the
 * automatic-install switch), the `behind` notice on the daemon-status panel, and "What's new" (a Settings › This device
 * panel that owns the release-notes sheet, and the command bar entry that opens it).
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
        // Drawn from `shell.deviceSettings` below (no machine), never from a machine's half.
        'whats-new': () => null,
      },
    }),
  }),
  {
    commands: whatsNewCommands,
    deviceSettings: {
      'whats-new': lazyComponent<Record<string, never>>(async () => {
        const view = await loadView('whats-new-panel');
        return view.WhatsNewPanel as AppComponent<Record<string, never>>;
      }) as (props: Record<string, never>) => ReactNode,
    },
  },
);
