import { type DaemonlessPorts, type DaemonlessScreenProps, type DaemonlessViews, provideToShell } from '@ferretry/app';
import type { AppComponent, PluginClient, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

/**
 * The views module (React), loaded on first use. The specifier is a Vite dynamic-import path, which keeps this module
 * free of React so the registry generator can load it before the app shell is in place.
 */
const loadViews = (): Promise<Record<string, unknown>> => import('./views/onboarding-views.tsx');

const stepsScreen = (client: PluginClient): AppComponent<ScreenProps> =>
  lazyComponent<ScreenProps>(async () =>
    ((await loadViews()).createStepsScreen as (client: PluginClient) => AppComponent<ScreenProps>)(client),
  );

const setupTab = (client: PluginClient): AppComponent<SettingsProps> =>
  lazyComponent<SettingsProps>(async () =>
    ((await loadViews()).createSetupTab as (client: PluginClient) => AppComponent<SettingsProps>)(client),
  );

/** The per-machine slot of the daemon-less `onboarding` screen: never drawn (its route is under no `/d/<machine>/`). */
const daemonlessPlaceholder = (): null => null;

/**
 * Onboarding's app half. The first run (`/onboarding`) is DAEMON-LESS on purpose: it happens before any daemon is
 * paired, so the shell mounts it from `shell.daemonless` with no client. The shell does not draw the steps; Onboarding
 * does: `onboarding/steps` is its per-machine screen, which OFFERS the `onboarding.step` slot and draws one panel
 * slot per step the plugins declared (`subject = <plugin>.<stepId>`).
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      screens: { onboarding: daemonlessPlaceholder, steps: stepsScreen(client) },
      panels: {},
      settings: { setup: setupTab(client) },
      renderers: {},
    }),
  }),
  {
    daemonless: ports => ({
      onboarding: lazyComponent<DaemonlessScreenProps>(async () =>
        ((await loadViews()).createOnboardingRoute as (ports: DaemonlessPorts) => AppComponent<DaemonlessScreenProps>)(
          ports,
        ),
      ) as DaemonlessViews[string],
    }),
  },
);
