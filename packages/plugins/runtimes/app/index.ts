import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import { forSubject, provideToShell } from '@ferretry/app';
import manifest from '../manifest.ts';
import type { LiveRuntimesClient, RuntimesClient } from './lib/client.ts';
import { lazyComponent } from './lazy.ts';
import { MACHINES_SECTION } from './features/fleet/shell/machine-route.ts';

type SettingsView = 'runtimes-settings' | 'profiles-settings' | 'model-sets-settings';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`).
 */
const loadView = (name: SettingsView | 'runtime-picker' | 'account-picker-panels'): Promise<Record<string, unknown>> =>
  import(`./views/${name}.tsx`);

/** A Settings tab: its module exports `create…(client)`, called once the tab is first drawn. */
const settingsView = (name: SettingsView, factory: string, client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  lazyComponent<SettingsProps>(async () =>
    ((await loadView(name))[factory] as (client: LiveRuntimesClient) => AppComponent<SettingsProps>)(client),
  );

const pickerView = (client: RuntimesClient): AppComponent<PanelProps> =>
  lazyComponent<PanelProps>(async () =>
    ((await loadView('runtime-picker')).createRuntimePicker as (client: RuntimesClient) => AppComponent<PanelProps>)(
      client,
    ),
  );

const accountPanel = (
  client: LiveRuntimesClient,
  factory: 'createNewFerretAccountPanel' | 'createMoveAccountPanel',
): AppComponent<PanelProps> =>
  lazyComponent<PanelProps>(async () =>
    ((await loadView('account-picker-panels'))[factory] as (client: LiveRuntimesClient) => AppComponent<PanelProps>)(
      client,
    ),
  );

/**
 * Runtimes' app half: the three Settings tabs (`runtimes`, `profiles`, `model-sets`), the runtime picker above the
 * composer, and the account picker it contributes to the two slots Ferrets' new-ferret and move pages offer. The views
 * are React and load on first use (`./lazy.ts`), so this module imports no React and stays loadable by the registry
 * generator before the app shell, which owns React, is in place.
 *
 * It claims the `#machines/<machine>/<tab>[/<item>]` fragment (`machineDetailHash`) with `strip: false` (shell contract
 * S3, m9): the shell never takes it out of the address, because the tabs' own router reads it there; the claim only
 * stops another plugin from declaring the same key.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      settings: {
        runtimes: settingsView('runtimes-settings', 'createRuntimesSettings', client),
        profiles: settingsView('profiles-settings', 'createProfilesSettings', client),
        'model-sets': settingsView('model-sets-settings', 'createModelSetsSettings', client),
      },
      panels: {
        'runtime-picker': pickerView(client),
        'new-ferret-account': accountPanel(client, 'createNewFerretAccountPanel'),
        'move-account': accountPanel(client, 'createMoveAccountPanel'),
        // The first-run step's body: the runtimes view, only for its own step.
        'onboarding-step': forSubject(
          'runtimes.runtimes',
          settingsView('runtimes-settings', 'createRuntimesSettings', client) as AppComponent<PanelProps>,
        ),
      },
    }),
  }),
  { fragments: [{ form: 'keyed', key: MACHINES_SECTION, strip: false }] },
);
