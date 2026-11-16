import { describe, expect, it } from 'bun:test';
import { testPluginClient } from '@ferretry/kernel/testing';
import type { RuntimesAssembly } from '../../../daemon/index.ts';
import type { FerretRuntimeSubsystem } from '../../../daemon/routes/ferret-runtime.ts';
import { runtimeControlApi } from '../../../app/lib/runtime-switch.ts';
import { hostRuntimes } from '../routes/support.ts';

/** The picker's api over the real mounted `POST /v1/ferrets/:id/runtime`, which refuses a control with no request id. */
const picker = async () => {
  const controls: unknown[] = [];
  const runtime: FerretRuntimeSubsystem = {
    models: async () => ({}),
    control: async (...args) => {
      controls.push(args);
      return { changed: true };
    },
  };
  const { host } = await hostRuntimes({
    catalog: {} as RuntimesAssembly['catalog'],
    setup: {} as RuntimesAssembly['setup'],
    runtime,
  });
  return { api: runtimeControlApi(testPluginClient(host)), controls };
};

describe('the runtime picker reaches the control route instead of a 400 missing_request_id', () => {
  it('a model switch, an effort switch and a fast toggle each arrive with the id the click supplied', async () => {
    const { api, controls } = await picker();
    await api.runtime('ferret-1', { action: 'model', model: 'gpt-6', effort: 'high' }, 'click-1');
    await api.runtime('ferret-1', { action: 'effort', effort: 'low' }, 'click-2');
    await api.runtime('ferret-1', { action: 'fast', fast: true }, 'click-3');
    expect(controls).toEqual([
      ['ferret-1', { action: 'model', model: 'gpt-6', effort: 'high' }, 'click-1'],
      ['ferret-1', { action: 'effort', effort: 'low' }, 'click-2'],
      ['ferret-1', { action: 'fast', fast: true }, 'click-3'],
    ]);
  });
});
