import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { useWardenDaemonScope } from '../../../app/hooks/use-warden-daemon-scope.ts';
import { interact, type Mounted, mount } from '@ferretry/app/testing';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** The shell's device controls, as far as the hook reads them: a record with a subscription and one setter. */
class FakeControls {
  readonly writes: string[] = [];
  #listeners = new Set<() => void>();
  #device: { wardenDaemon: string | null };
  constructor(wardenDaemon: string | null = null) {
    this.#device = { wardenDaemon };
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly snapshot = () => ({ device: this.#device });
  readonly setDeviceControls = (change: { wardenDaemon: string | null }): void => {
    this.#device = { ...this.#device, ...change };
    this.writes.push(JSON.stringify(this.#device));
    for (const listener of this.#listeners) listener();
  };
}

const store = () => {
  const controls = new FakeControls();
  return { writes: controls.writes, controls };
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

  test('renders the remembered daemon on the server, where there is no subscription', () => {
    const controls = new FakeControls('daemon-ec2');
    const Probe = () => <p>{useWardenDaemonScope(controls).remembered ?? 'all'}</p>;
    expect(renderToStaticMarkup(<Probe />)).toBe('<p>daemon-ec2</p>');
  });
});
