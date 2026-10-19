import { describe, expect, it } from 'bun:test';
import { useNeedsRuntime } from '../../src/hooks/use-needs-runtime.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, mount } from '../support/dom.ts';
import { configChangeHarness } from './config-change-support.tsx';

const laptop = daemonConnection({ daemonId: 'daemon/laptop', baseUrl: 'https://l.example.test', deviceId: 'token-l' });
const other = daemonConnection({ daemonId: 'daemon/other', baseUrl: 'https://o.example.test', deviceId: 'token-o' });

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

/** A machine whose runtime list a test changes between reads. */
const machine = (state: { names: string[]; fail?: boolean }) => ({
  factory: async () => ({
    request: (async () => {
      if (state.fail) throw new Error('unreachable');
      return { format: 2, runtimes: state.names.map(name => ({ name })) };
    }) as never,
  }),
});

function Probe({ connection, factory }: { readonly connection: typeof laptop; readonly factory: never }) {
  return <output>{String(useNeedsRuntime(connection, factory))}</output>;
}

describe('useNeedsRuntime', () => {
  it('says a machine with no runtime needs one, and stops saying it once one is created', async () => {
    const state = { names: [] as string[] };
    const { factory } = machine(state);
    const harness = configChangeHarness(laptop.daemonId);
    const mounted = await mount(harness.wrap(<Probe connection={laptop} factory={factory as never} />));
    await settle();
    expect(mounted.container.textContent).toBe('true');

    state.names = ['first'];
    await harness.move(['runtimes']);
    await settle();
    expect(mounted.container.textContent).toBe('false');
    mounted.unmount();
  });

  it('claims nothing for a machine it cannot read, or when there is no client', async () => {
    const { factory } = machine({ names: [], fail: true });
    const mounted = await mount(<Probe connection={laptop} factory={factory as never} />);
    await settle();
    expect(mounted.container.textContent).toBe('false');
    await mounted.render(<Probe connection={laptop} factory={undefined as never} />);
    await settle();
    expect(mounted.container.textContent).toBe('false');
    mounted.unmount();
  });

  it('forgets the answer for a machine the reader left', async () => {
    const { factory } = machine({ names: [] });
    const mounted = await mount(<Probe connection={laptop} factory={factory as never} />);
    await settle();
    expect(mounted.container.textContent).toBe('true');
    await mounted.render(<Probe connection={other} factory={machine({ names: ['x'] }).factory as never} />);
    await settle();
    expect(mounted.container.textContent).toBe('false');
    mounted.unmount();
  });
});
