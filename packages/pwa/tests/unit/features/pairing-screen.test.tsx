import { describe, expect, it } from 'bun:test';

import { PairingScreen } from '../../../src/features/pairing/pairing-screen.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount } from '../../support/dom.ts';
import { render } from '../../support/react.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-secret',
});
const beta = daemonConnection({ daemonId: 'beta', baseUrl: 'https://beta.example.test', deviceToken: 'beta-secret' });
const records = [
  { ...alpha, label: 'Studio daemon', pairedAt: 1, lastSelectedAt: 2 },
  { ...beta, pairedAt: 1, lastSelectedAt: 1 },
] as const;

describe('PairingScreen', () => {
  it('renders an explicit empty pairing state through the component renderer', () => {
    const screen = render(
      <PairingScreen
        connections={[]}
        selectedDaemonId={null}
        onPair={async () => {}}
        onRemove={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(JSON.stringify(screen.toJSON())).toContain('No daemons are paired yet.');
  });

  it('renders runtime-paired daemons without exposing credentials, and delegates selection/removal', async () => {
    const selected: string[] = [];
    const removed: string[] = [];
    const screen = await mount(
      <PairingScreen
        connections={records}
        selectedDaemonId={alpha.daemonId}
        onPair={async () => {}}
        onRemove={id => removed.push(id)}
        onSelect={id => selected.push(id)}
      />,
    );

    expect(screen.container.textContent).toContain('Studio daemon');
    expect(screen.container.textContent).toContain('https://beta.example.test');
    expect(screen.container.textContent).not.toContain('alpha-secret');
    expect(screen.container.textContent).not.toContain('beta-secret');
    const selectedButton = screen.container.querySelector('button[aria-current="true"]') as HTMLButtonElement;
    const forgetButton = screen.container.querySelector('button[aria-label="Forget beta"]') as HTMLButtonElement;
    await interact(() => selectedButton.click());
    await interact(() => forgetButton.click());
    expect(selected).toEqual(['alpha']);
    expect(removed).toEqual(['beta']);
  });

  it('rejects malformed links before asking the host to exchange anything', async () => {
    let calls = 0;
    const screen = await mount(
      <PairingScreen
        connections={[]}
        selectedDaemonId={null}
        onPair={async () => {
          calls += 1;
        }}
        onRemove={() => {}}
        onSelect={() => {}}
      />,
    );
    const input = screen.container.querySelector('input[aria-label="Pairing link"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'not a link');
    await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
    await interact(() =>
      screen.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );

    expect(calls).toBe(0);
    expect(screen.container.textContent).toContain('pairing URL must be absolute');
  });

  it('parses a valid link, clears its one-time secret, and delegates only the parsed seed', async () => {
    const received: unknown[] = [];
    const screen = await mount(
      <PairingScreen
        connections={[]}
        selectedDaemonId={null}
        onPair={async seed => {
          received.push(seed);
        }}
        onRemove={() => {}}
        onSelect={() => {}}
      />,
    );
    const input = screen.container.querySelector('input[aria-label="Pairing link"]') as HTMLInputElement;
    const link = 'https://pwa.example.test/#v1;url=https%3A%2F%2Fdaemon.example.test;code=single-use;fp=daemon-a';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, link);
    await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
    await interact(async () => {
      screen.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(received).toEqual([{ daemonUrl: 'https://daemon.example.test', daemonId: 'daemon-a', code: 'single-use' }]);
    expect(input.value).toBe('');
    expect(screen.container.textContent).toContain('Daemon paired. It is now available in your fleet.');
  });

  it('clears the one-time link and reports an injected exchange failure', async () => {
    const screen = await mount(
      <PairingScreen
        connections={[]}
        selectedDaemonId={null}
        onPair={async () => {
          throw new Error('The pairing code has expired.');
        }}
        onRemove={() => {}}
        onSelect={() => {}}
      />,
    );
    const input = screen.container.querySelector('input[aria-label="Pairing link"]') as HTMLInputElement;
    const link = 'https://pwa.example.test/#v1;url=https%3A%2F%2Fdaemon.example.test;code=expired;fp=daemon-a';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, link);
    await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
    await interact(async () => {
      screen.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(input.value).toBe('');
    expect(screen.container.textContent).toContain('The pairing code has expired.');
  });
});
