import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useNeedsRuntime } from '../../../app/hooks/use-needs-runtime.ts';
import { RUNTIMES_ROUTE } from '../../../app/lib/runtimes-api.ts';
import { interact, mount } from '../support/dom.ts';
import { RUNTIMES } from './features/fleet/account-support.ts';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

/** A machine whose runtime list a test changes between reads, and whose `runtimes.changed` event a test fires. */
const machine = (state: { empty: boolean; fail?: boolean }) => {
  const listeners = new Set<(payload: unknown) => void>();
  const client = {
    call: async (route: string) => {
      if (route !== RUNTIMES_ROUTE) throw new Error(`no route ${route}`);
      if (state.fail) throw new Error('unreachable');
      return state.empty ? { format: 'none', runtimes: [] } : RUNTIMES;
    },
    subscribe: (_event: unknown, listener: (payload: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Pick<PluginClient, 'call' | 'subscribe'>;
  return {
    client,
    changed: () =>
      interact(async () => {
        for (const listener of [...listeners]) listener({});
      }),
  };
};

function Probe({ client }: { readonly client: Pick<PluginClient, 'call' | 'subscribe'> | undefined }) {
  return <output>{String(useNeedsRuntime(client))}</output>;
}

describe('useNeedsRuntime', () => {
  it('says a machine with no runtime needs one, and stops saying it once one is created', async () => {
    const state = { empty: true };
    const { client, changed } = machine(state);
    const mounted = await mount(<Probe client={client} />);
    await settle();
    expect(mounted.container.textContent).toBe('true');

    state.empty = false;
    await changed();
    await settle();
    expect(mounted.container.textContent).toBe('false');
    mounted.unmount();
  });

  it('claims nothing for a machine it cannot read, or when there is no client', async () => {
    const { client } = machine({ empty: true, fail: true });
    const mounted = await mount(<Probe client={client} />);
    await settle();
    expect(mounted.container.textContent).toBe('false');
    await mounted.render(<Probe client={undefined} />);
    await settle();
    expect(mounted.container.textContent).toBe('false');
    mounted.unmount();
  });

  it('forgets the answer for a machine the reader left', async () => {
    const mounted = await mount(<Probe client={machine({ empty: true }).client} />);
    await settle();
    expect(mounted.container.textContent).toBe('true');
    await mounted.render(<Probe client={machine({ empty: false }).client} />);
    await settle();
    expect(mounted.container.textContent).toBe('false');
    mounted.unmount();
  });
});
