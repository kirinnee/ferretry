import { afterEach, describe, expect, test } from 'bun:test';
import { useMachineOrder } from '../../src/hooks/use-machine-order.ts';
import { DaemonControlsStore } from '../../src/lib/controls.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';

const [A, B] = ['alpha', 'beta'] as DaemonId[] as [DaemonId, DaemonId];

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const store = () => {
  const writes: string[] = [];
  return {
    writes,
    controls: new DaemonControlsStore({ getItem: () => null, setItem: (_key, value) => writes.push(value) }),
  };
};

describe('useMachineOrder', () => {
  test('reads the saved order, follows a change, and stores nothing for a repeat', async () => {
    const { controls, writes } = store();
    let latest: ReturnType<typeof useMachineOrder> | null = null;
    const Probe = () => {
      latest = useMachineOrder(controls);
      return <p>{latest.saved.join(',')}</p>;
    };
    view = await mount(<Probe />);
    expect(view.container.textContent).toBe('');

    await interact(() => latest?.commit([B, A]));
    expect(view.container.textContent).toBe('beta,alpha');
    expect(writes).toHaveLength(1);
    expect(controls.snapshot().device.machineOrder).toEqual([B, A]);

    await interact(() => latest?.commit([B, A]));
    expect(writes).toHaveLength(1);

    await interact(() => latest?.commit([B]));
    expect(view.container.textContent).toBe('beta');
    expect(writes).toHaveLength(2);
  });
});
