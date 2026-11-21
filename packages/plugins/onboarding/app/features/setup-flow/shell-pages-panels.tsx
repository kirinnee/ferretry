/** The `onboarding.step` panels for Onboarding's own two pages, made for one machine's client (drawn by the setup flow). */
import { daemonOfClient } from '@ferretry/app';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { AppearancePage } from './appearance-page.tsx';
import { NamePage } from './shell-pages.tsx';

export function createNamePanel(client: PluginClient) {
  return function NamePanel({ step }: PanelProps): ReactNode {
    const daemon = daemonOfClient(client);
    return daemon === undefined ? null : <NamePage daemon={daemon} step={step} />;
  };
}

export function createAppearancePanel(_client: PluginClient) {
  return function AppearancePanel({ step }: PanelProps): ReactNode {
    return <AppearancePage step={step} />;
  };
}
