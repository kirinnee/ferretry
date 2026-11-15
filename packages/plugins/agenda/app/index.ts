import { type BackgroundViewProps, type DeviceViewProps, provideToShell, type ShellProvides } from '@ferretry/app';
import type { AppComponent, PanelProps, PluginClient, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { agendaCommands } from './command-bar.ts';
import { lazyComponent } from './lazy.ts';
import type { RuntimeClient } from './lib/agenda-runtime.ts';
import { inboxBadgeOf, needsYouOf } from './lib/agenda-nav-badge.ts';

type Surfaces = {
  readonly screens: Record<string, AppComponent<ScreenProps>>;
  readonly panels: Record<string, AppComponent<PanelProps>>;
  readonly settings: Record<string, AppComponent<SettingsProps>>;
};

/**
 * The view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), so
 * the registry generator, which only inspects this module, never loads React.
 */
const loadSurfaces = (): Promise<Record<string, unknown>> => import(`./views/${'surfaces'}.tsx`);

/** A `device.settings` panel (no daemon, no client), loaded on first use with the rest of the surfaces. */
const deviceSetting = (id: 'notification-mute') =>
  lazyComponent<Record<string, never>>(async () => {
    const panels = (await loadSurfaces()).deviceSettingsPanels as Record<string, AppComponent<Record<string, never>>>;
    return panels[id] as AppComponent<Record<string, never>>;
  }) as NonNullable<ShellProvides['deviceSettings']>[string];

/** The typed `panels` name every manifest panel; a `device.settings` one is drawn from `shell.deviceSettings`, not per machine. */
const notDrawnPerDaemon: AppComponent<PanelProps> = () => null;

/** What every machine's surfaces and the device view share their one fleet through (`lib/agenda-fleet.ts`). */
const fleet = {};

/**
 * Agenda's app half: the `agenda` page and the page a buzz opens (`agenda-ask`), one ferret's agenda beside its chat
 * (`ferret-agenda`) and the `agenda` Settings tab. Every surface reads and answers through the one generated client,
 * over one runtime built for the daemon (`views/surfaces.tsx`). The ask page offers the `agenda.conversation` slot
 * (contract/slots.ts) where the ferret's conversation goes.
 */
const half = implementApp(manifest, {
  build: ({ client }) => {
    let surfaces: Promise<Surfaces> | undefined;
    const surfacesOf = (): Promise<Surfaces> => {
      surfaces ??= loadSurfaces().then(module =>
        (module.createSurfaces as (client: PluginClient, holder: object) => Surfaces)(client, fleet),
      );
      return surfaces;
    };
    const screen = (id: 'agenda' | 'agenda-ask') =>
      lazyComponent<ScreenProps>(async () => (await surfacesOf()).screens[id] as AppComponent<ScreenProps>);
    return {
      screens: { agenda: screen('agenda'), 'agenda-ask': screen('agenda-ask') },
      panels: {
        'notification-mute': notDrawnPerDaemon,
        'ferret-agenda': lazyComponent<PanelProps>(
          async () => (await surfacesOf()).panels['ferret-agenda'] as AppComponent<PanelProps>,
        ),
        'ferret-agenda-line': lazyComponent<PanelProps>(
          async () => (await surfacesOf()).panels['ferret-agenda-line'] as AppComponent<PanelProps>,
        ),
        'ferret-agenda-mode': lazyComponent<PanelProps>(
          async () => (await surfacesOf()).panels['ferret-agenda-mode'] as AppComponent<PanelProps>,
        ),
        // Drawn from `shell.navPanels` below (no machine), never from a machine's half.
        'needs-you': () => null,
      },
      settings: {
        agenda: lazyComponent<SettingsProps>(
          async () => (await surfacesOf()).settings.agenda as AppComponent<SettingsProps>,
        ),
      },
    };
  },
});

/**
 * Beside the half, Agenda claims the `#agenda/<id>?session=…&machine=…` link (shell contract S3): the shell takes it
 * off the address and hands it to the one device view, which opens the ask on the machine that runs it.
 */
const deepLinkView = lazyComponent<DeviceViewProps>(
  async () =>
    (await import('./views/agenda-deep-link-view.tsx')).agendaDeepLinkView(fleet) as AppComponent<DeviceViewProps>,
) as NonNullable<ShellProvides['device']>[string];

/**
 * Agenda writes the worker's notification filter document (shell contract S6) at app boot, from a second device view
 * that draws nothing; every change of its settings writes it again (`lib/device-filter-store.ts`).
 */
const filterBootView = lazyComponent<DeviceViewProps>(
  async () =>
    (await import('./views/agenda-filter-boot-view.tsx')).AgendaFilterBootView as AppComponent<DeviceViewProps>,
) as NonNullable<ShellProvides['device']>[string];

/**
 * The Needs you panel (shell contract S4): the ferrets waiting on the owner, drawn once under the nav entries, in a
 * column or a rail. Device-level: it lists the machines itself and reads each through its own runtime.
 */
const needsYouPanel = lazyComponent<Record<string, never>>(
  async () =>
    (await import('./views/agenda-needs-you-panel.tsx')).agendaNeedsYouPanel(fleet) as AppComponent<
      Record<string, never>
    >,
) as NonNullable<ShellProvides['navPanels']>[string];

/**
 * The in-app notification watch (shell contract S5): mounted once per paired daemon at the frame root, so a ferret that
 * dies while the app is open is notified whichever page is showing. It draws nothing and never asks for permission.
 */
const notificationWatchView = lazyComponent<BackgroundViewProps>(
  async () =>
    (await import('./views/agenda-notification-watch-view.tsx'))
      .AgendaNotificationWatchView as AppComponent<BackgroundViewProps>,
) as NonNullable<ShellProvides['background']>[string];

export default provideToShell(half, {
  commands: agendaCommands,
  fragments: [{ form: 'keyed', key: 'agenda' }],
  device: { 'deep-link': deepLinkView, 'notification-filter': filterBootView },
  background: { 'notification-watch': notificationWatchView },
  // Ferrets' list gathers the ferrets that wait on the owner (`ferrets.needs-you`); which they are is this half's fact.
  hooks: {
    'ferrets.needs-you': ({ client }) => needsYouOf(client),
  },
  // The count on the Agenda nav entry: this machine's share of the Inbox page's own number (`lib/inbox-count.ts`),
  // summed by the shell across every unlocked machine, over this machine's background client.
  navBadges: { agenda: ({ client }) => inboxBadgeOf(client as unknown as RuntimeClient) },
  navPanels: { 'needs-you': needsYouPanel },
  // Settings › This device (S4): one Mute per machine, next to Access's Notifications panel. No machine, no client.
  deviceSettings: { 'notification-mute': deviceSetting('notification-mute') },
});
