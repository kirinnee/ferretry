/** The `onboarding.step` panel of the "Which AI do you want to use?" page, made for one machine's client (drawn by the setup flow). */
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useMemo } from 'react';
import { useScanAhead } from '../setup-flow/machine-scan.ts';
import { z } from 'zod';
import { HarnessViewSchema } from '../../../contract/index.ts';
import { type Harness, type Provider, PresetCatalogSchema, foundOn, providersOf } from './agents-model.ts';
import { AgentsPage } from './agents-page.tsx';

/** The providers this machine's catalog offers (`GET /v1/logins/presets`), read quietly: a page, not a person, asked. */
const readProviders =
  (client: PluginClient) =>
  async (installed: readonly Harness[]): Promise<readonly Provider[]> =>
    providersOf(PresetCatalogSchema.parse(await client.call('GET /v1/logins/presets', { quiet: true })), installed);

/** The harnesses installed on this machine (`GET /v1/onboarding` `harnesses`, from the daemon's registry), read quietly. */
const readHarnesses = (client: PluginClient) => async (): Promise<readonly Harness[]> =>
  z
    .object({ harnesses: z.array(HarnessViewSchema).optional() })
    .parse(await client.call('GET /v1/onboarding', { quiet: true })).harnesses ?? [];

export function createAgentsPanel(client: PluginClient) {
  const read = readProviders(client);
  const readInstalled = readHarnesses(client);
  return function AgentsPanel({ step }: PanelProps): ReactNode {
    // The flow started the machine's scan the moment it opened: this LOOKS at that read and nothing else (never a scan of its
    // own, never the machine's scan store), and a machine that wants a passkey for it, a failed read or no read simply shows no
    // note. Nothing is imported or written here.
    const models = useScanAhead(client);
    const found = useMemo(() => foundOn(models), [models]);
    return <AgentsPage step={step} readHarnesses={readInstalled} readProviders={read} found={found} />;
  };
}
