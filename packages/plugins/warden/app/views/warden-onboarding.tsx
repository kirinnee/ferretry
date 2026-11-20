/** The Warden's first-run step (`warden.warden`): the one simple page, over the plugin client of the machine being set up. */

import type { StepHost } from '@ferretry/kernel/contract';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { useMemo } from 'react';
import { z } from 'zod';
import { JevKeyRow } from '../features/onboarding/key-row-slot.tsx';
import { WardenStepPage, type WardenStepDeps } from '../features/onboarding/warden-step-page.tsx';
import { useCurrentDaemon } from '../hooks/use-warden-daemons.ts';
import { readSpeedups } from '../lib/speedups.ts';
import { wardenClientOf } from '../lib/warden-client.ts';

/** The route's reply is `{ path, exists, text, state, … }`; the page reads only whether the file is there. */
const FileSchema = z.looseObject({ exists: z.boolean() });

const depsOf = (client: PluginClient): WardenStepDeps => ({
  client: wardenClientOf(client),
  // QUIET: the page reads on its own when it mounts, so a step-up the machine wants asks nobody.
  readFile: async () =>
    FileSchema.parse(
      await client.call<unknown>('GET /v1/config/file', { query: { path: 'warden.yaml' }, quiet: true }),
    ),
  readKey: () => readSpeedups(client),
});

export function createWardenOnboarding(client: PluginClient) {
  return function WardenOnboarding(props: PanelProps) {
    const connection = useCurrentDaemon(client);
    const deps = useMemo(() => depsOf(client), []);
    const step: StepHost | undefined = props.step;
    return <WardenStepPage deps={deps} step={step} keyRow={<JevKeyRow daemon={connection.daemonId} />} />;
  };
}
