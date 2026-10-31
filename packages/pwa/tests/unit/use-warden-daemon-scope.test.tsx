import { afterEach, describe, expect, test } from 'bun:test';

import { useWardenDaemonScope } from '../../src/hooks/use-warden-daemon-scope.ts';
import { DaemonControlsStore } from '../../src/lib/controls.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';

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

describe('useWardenDaemonScope', () => {
  test('starts on All, remembers a choice on this device, and stores nothing for a repeat', async () => {
    const { controls, writes } = store();
    let latest: ReturnType<typeof useWardenDaemonScope> | null = null;
    const Probe = () => {
      latest = useWardenDaemonScope(controls);
      return <p>{latest.remembered ?? 'all'}</p>;
    };
    view = await mount(<Probe />);
    expect(view.container.textContent).toBe('all');

    await interact(() => latest?.remember('daemon-mbp'));
    expect(view.container.textContent).toBe('daemon-mbp');
    expect(controls.snapshot().device.wardenDaemon).toBe('daemon-mbp');
    expect(writes).toHaveLength(1);

    await interact(() => latest?.remember('daemon-mbp'));
    expect(writes).toHaveLength(1);

    await interact(() => latest?.remember(null));
    expect(view.container.textContent).toBe('all');
    expect(controls.snapshot().device.wardenDaemon).toBeNull();
  });
});
