/** The `onboarding.step` panel of the "Which AI do you want to use?" page, made for one machine's client (drawn by the setup flow). */
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { type Provider, PresetCatalogSchema, providersOf } from './agents-model.ts';
import { AgentsPage } from './agents-page.tsx';

/** The providers this machine's catalog offers (`GET /v1/logins/presets`), read quietly: a page, not a person, asked. */
const readProviders = (client: PluginClient) => async (): Promise<readonly Provider[]> =>
  providersOf(PresetCatalogSchema.parse(await client.call('GET /v1/logins/presets', { quiet: true })));

export function createAgentsPanel(client: PluginClient) {
  return function AgentsPanel({ step }: PanelProps): ReactNode {
    return <AgentsPage step={step} readProviders={readProviders(client)} />;
  };
}
