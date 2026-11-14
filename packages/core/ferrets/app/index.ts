import { provideToShell, type ShellProvides } from '@ferretry/app';
import type { AppComponent, PanelProps, ScreenProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';
import type { LiveFerretsClient } from './lib/client.ts';

type ViewName = 'list' | 'new-ferret' | 'move' | 'header' | 'info' | 'files' | 'device-settings';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker does not follow it: each module exports `create…(client)`, called once the surface is
 * first drawn, so this module imports no React and stays loadable by the registry generator.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

const screen = (name: ViewName, factory: string, client: LiveFerretsClient): AppComponent<ScreenProps> =>
  lazyComponent<ScreenProps>(async () =>
    ((await loadView(name))[factory] as (client: LiveFerretsClient) => AppComponent<ScreenProps>)(client),
  );

const panel = (name: ViewName, factory: string, client: LiveFerretsClient): AppComponent<PanelProps> =>
  lazyComponent<PanelProps>(async () =>
    ((await loadView(name))[factory] as (client: LiveFerretsClient) => AppComponent<PanelProps>)(client),
  );

/**
 * Ferrets' app half: the new-ferret page and the move page (each OFFERS the account slot Runtimes contributes its
 * runtime picker to), the ferret's header as panels on `ferret.toolbar` (name, status, info, actions) and the file
 * browser on `ferret.side`. Every surface reads and writes through the one generated client by route key.
 */
/** A `device.settings` panel (no daemon, no client): the view module loads on first use. */
const deviceSetting = (id: 'needs-you') =>
  lazyComponent<Record<string, never>>(async () => {
    const panels = (await loadView('device-settings')).deviceSettingsPanels as Record<
      string,
      AppComponent<Record<string, never>>
    >;
    return panels[id] as AppComponent<Record<string, never>>;
  }) as NonNullable<ShellProvides['deviceSettings']>[string];

/** Drawn from `shell.deviceSettings` (no daemon), never from a machine's half, so the per-daemon entry draws nothing. */
const notDrawnPerDaemon: AppComponent<PanelProps> = () => null;

export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      screens: {
        ferrets: screen('list', 'createFerretListScreen', client),
        'new-ferret': screen('new-ferret', 'createNewFerretScreen', client),
        move: screen('move', 'createMoveScreen', client),
      },
      panels: {
        name: panel('header', 'createNamePanel', client),
        status: panel('header', 'createStatusPanel', client),
        info: panel('info', 'createInfoPanel', client),
        actions: panel('header', 'createActionsPanel', client),
        files: panel('files', 'createFilesPanel', client),
        'needs-you': notDrawnPerDaemon,
      },
    }),
  }),
  { deviceSettings: { 'needs-you': deviceSetting('needs-you') } },
);
