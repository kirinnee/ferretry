import { describe, expect, it } from 'bun:test';

import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';
import { machineNameFromAddress } from '../../../../app/features/pairing/machine-name-field.tsx';
import type { PairingSeed } from '../../../../app/lib/pairing.ts';
import { interact, mount, must } from '../../../support/app/dom.ts';

const seedAt = (daemonUrl: string): PairingSeed => ({ daemonUrl, daemonId: 'daemon-a', code: 'single-use' });

const screenFor = async (seed: PairingSeed, onPair: (name?: string) => void = () => {}) =>
  await mount(
    <PairingScreen
      connections={[]}
      selectedDaemonId={null}
      arrival={{ kind: 'seed', seed }}
      onPair={async (_seed, _device, machine) => onPair(machine)}
      onRemove={() => {}}
      onSelect={() => {}}
    />,
  );

const field = (container: HTMLElement): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>('[data-pair-machine-name]'), 'the machine name field');

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
};

describe('machineNameFromAddress: what a link really knows about the machine name', () => {
  it('is the host of a real DNS name', () => {
    expect(machineNameFromAddress('https://studio.example.com')).toBe('studio.example.com');
    expect(machineNameFromAddress('https://studio.example.com:7456')).toBe('studio.example.com');
    expect(machineNameFromAddress('http://studio:7456')).toBe('studio');
  });

  it('is nothing for an IP address or a loopback name, which are addresses and not names', () => {
    expect(machineNameFromAddress('http://192.168.1.20:7456')).toBe('');
    expect(machineNameFromAddress('http://127.0.0.1:7456')).toBe('');
    expect(machineNameFromAddress('http://localhost:7456')).toBe('');
    expect(machineNameFromAddress('http://app.localhost:7456')).toBe('');
    expect(machineNameFromAddress('http://[::1]:7456')).toBe('');
    expect(machineNameFromAddress('http://[fd00::1]:7456')).toBe('');
  });

  it('is nothing for an address that is not a URL', () => {
    expect(machineNameFromAddress('not a url')).toBe('');
  });
});

describe('PairingScreen machine name field', () => {
  it('starts prefilled with the link host, keeps its placeholder hint, and sends that name', async () => {
    const sent: (string | undefined)[] = [];
    const screen = await screenFor(seedAt('https://studio.example.com'), name => sent.push(name));

    expect(field(screen.container).value).toBe('studio.example.com');
    expect(field(screen.container).placeholder).toBe('Optional, e.g. Studio box');

    const pair = [...screen.container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Pair this device'),
    );
    await interact(() => must(pair ?? null, 'the pair button').click());
    expect(sent).toEqual(['studio.example.com']);
    await screen.unmount();
  });

  it('stays empty for an IP link, with the hint', async () => {
    const screen = await screenFor(seedAt('http://192.168.1.20:7456'));
    expect(field(screen.container).value).toBe('');
    expect(field(screen.container).placeholder).toBe('Optional, e.g. Studio box');
    await screen.unmount();
  });

  it('can be edited and emptied, and an emptied field stays empty and sends no name', async () => {
    const sent: (string | undefined)[] = [];
    const screen = await screenFor(seedAt('https://studio.example.com'), name => sent.push(name));

    await type(field(screen.container), 'Studio box');
    expect(field(screen.container).value).toBe('Studio box');
    await type(field(screen.container), '');
    expect(field(screen.container).value).toBe('');

    const pair = [...screen.container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Pair this device'),
    );
    await interact(() => must(pair ?? null, 'the pair button').click());
    expect(sent).toEqual([undefined]);
    await screen.unmount();
  });
});
