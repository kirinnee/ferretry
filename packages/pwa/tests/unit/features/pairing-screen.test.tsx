import { describe, expect, it } from 'bun:test';

import { PairingScreen } from '../../../src/features/pairing/pairing-screen.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { QrScanHost } from '../../../src/lib/pair-scan.ts';
import type { PairingArrival, PairingSeed } from '../../../src/lib/pairing.ts';
import { interact, mount, must } from '../../support/dom.ts';

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

const LINK = 'https://pwa.example.test/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=single-use;fp=daemon-a';
const SEED: PairingSeed = { daemonUrl: 'https://daemon.example.test', daemonId: 'daemon-a', code: 'single-use' };
const PREFILLED: PairingArrival = { kind: 'seed', seed: SEED };

const idleHost: QrScanHost = { supported: true, scan: async () => await new Promise<string>(() => {}) };

const scanningHost = (text: string): QrScanHost => ({ supported: true, scan: async () => text });

const buttonNamed = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text)) ?? null,
    `a button labelled ${text}`,
  );

const typeLink = async (container: HTMLElement, value: string): Promise<void> => {
  const input = must(
    container.querySelector('input[aria-label="Pairing link"]'),
    'the paste field',
  ) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
};

const submitForm = async (container: HTMLElement): Promise<void> => {
  await interact(() =>
    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
};

const screenWith = async (overrides: Partial<Parameters<typeof PairingScreen>[0]> = {}) =>
  await mount(
    <PairingScreen
      connections={[]}
      selectedDaemonId={null}
      scanHost={idleHost}
      onPair={async () => {}}
      onRemove={() => {}}
      onSelect={() => {}}
      {...overrides}
    />,
  );

describe('PairingScreen cold open', () => {
  it('offers one action and no empty-state card', async () => {
    const screen = await screenWith();

    expect(screen.container.textContent).toContain('Connect a daemon');
    expect(buttonNamed(screen.container, 'Scan QR code')).toBeDefined();
    // The card that used to say "0" and then explain that it was 0.
    expect(screen.container.textContent).not.toContain('Paired daemons');
    expect(screen.container.textContent).not.toContain('No daemons are paired yet');
    expect(screen.container.querySelector('ul[aria-label="Paired daemons"]')).toBeNull();
    // Paste is present but quiet: a link to reveal, not the hero control.
    expect(screen.container.querySelector('input[aria-label="Pairing link"]')).toBeNull();
    expect(screen.container.textContent).toContain('Paste a link instead');
    await screen.unmount();
  });

  it('keeps the security explanation available but out of the way', async () => {
    const screen = await screenWith();

    const details = must(screen.container.querySelector('details'), 'the disclosure');
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.textContent).toContain('How this works');
    expect(details.textContent).toContain('no daemon address and no credentials');
    await screen.unmount();
  });

  it('reveals the paste field on request, and permanently when there is no camera', async () => {
    const screen = await screenWith();
    await interact(() => buttonNamed(screen.container, 'Paste a link instead').click());
    expect(screen.container.querySelector('input[aria-label="Pairing link"]')).not.toBeNull();
    await screen.unmount();

    const noCamera = await screenWith({ scanHost: null });
    expect(noCamera.container.querySelector('input[aria-label="Pairing link"]')).not.toBeNull();
    expect(noCamera.container.textContent).not.toContain('Paste a link instead');
    await noCamera.unmount();
  });
});

describe('PairingScreen with daemons already paired', () => {
  it('leads with the daemons and demotes pairing to a second action', async () => {
    const selected: string[] = [];
    const removed: string[] = [];
    const screen = await screenWith({
      connections: records,
      selectedDaemonId: alpha.daemonId,
      onSelect: id => selected.push(id),
      onRemove: id => removed.push(id),
    });

    expect(screen.container.textContent).toContain('Your daemons');
    expect(screen.container.textContent).toContain('Studio daemon');
    expect(screen.container.textContent).toContain('https://beta.example.test');
    expect(screen.container.textContent).not.toContain('alpha-secret');
    expect(screen.container.textContent).not.toContain('beta-secret');
    expect(buttonNamed(screen.container, 'Pair another daemon')).toBeDefined();

    const chosen = must(screen.container.querySelector('button[aria-current="true"]'), 'the selected daemon');
    const forget = must(screen.container.querySelector('button[aria-label="Forget beta"]'), 'the forget control');
    await interact(() => (chosen as HTMLButtonElement).click());
    await interact(() => (forget as HTMLButtonElement).click());
    expect(selected).toEqual(['alpha']);
    expect(removed).toEqual(['beta']);
    await screen.unmount();
  });
});

describe('PairingScreen arrival', () => {
  it('turns a pre-filled link into a confirmation naming the daemon, not a form', async () => {
    let taken = 0;
    const screen = await screenWith({ arrival: PREFILLED, onArrivalTaken: () => (taken += 1) });

    expect(screen.container.textContent).toContain('Pair this device?');
    expect(screen.container.textContent).toContain('daemon.example.test');
    expect(screen.container.textContent).toContain('daemon-a');
    // The one-time code is never rendered, and the address bar is emptied of it.
    expect(screen.container.textContent).not.toContain('single-use');
    expect(screen.container.querySelector('input')).toBeNull();
    expect(taken).toBe(1);
    await screen.unmount();
  });

  it('refuses a damaged link instead of showing the ordinary cold screen', async () => {
    let taken = 0;
    const screen = await screenWith({
      arrival: { kind: 'unreadable', reason: 'pairing URL must use v1' },
      onArrivalTaken: () => (taken += 1),
    });

    expect(screen.container.textContent).toContain('Pairing failed');
    expect(must(screen.container.querySelector('[role="alert"]'), 'the refusal').textContent).toContain(
      'This pairing link is damaged: pairing URL must use v1.',
    );
    expect(taken).toBe(1);
    await screen.unmount();
  });

  it('leaves the address bar alone on a cold open', async () => {
    let taken = 0;
    const screen = await screenWith({ onArrivalTaken: () => (taken += 1) });
    expect(taken).toBe(0);
    await screen.unmount();
  });
});

describe('PairingScreen exchange', () => {
  it('exchanges a confirmed seed and reports the daemon it reached', async () => {
    const exchanged: PairingSeed[] = [];
    const screen = await screenWith({
      arrival: PREFILLED,
      onPair: async seed => {
        exchanged.push(seed);
      },
    });

    await interact(() => buttonNamed(screen.container, 'Pair this device').click());

    expect(exchanged).toEqual([SEED]);
    expect(screen.container.textContent).toContain('Connected');
    expect(screen.container.textContent).toContain('daemon.example.test');
    await screen.unmount();
  });

  it('says the daemon is being reached while the exchange is in flight', async () => {
    let finish = (): void => {};
    const screen = await screenWith({
      arrival: PREFILLED,
      onPair: async () => await new Promise<void>(resolve => (finish = resolve)),
    });

    await interact(() => buttonNamed(screen.container, 'Pair this device').click());
    expect(screen.container.textContent).toContain('Exchanging the one-time code with this daemon…');
    expect(buttonNamed(screen.container, 'Pairing…').disabled).toBe(true);

    await interact(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.container.textContent).toContain('Connected');
    await screen.unmount();
  });

  it('fails honestly when the daemon cannot be reached, and offers a fresh start', async () => {
    const screen = await screenWith({
      arrival: PREFILLED,
      onPair: async () => {
        throw new Error('Failed to fetch');
      },
    });

    await interact(() => buttonNamed(screen.container, 'Pair this device').click());

    expect(screen.container.textContent).toContain('Pairing failed');
    expect(screen.container.textContent).toContain('Failed to fetch');
    expect(screen.container.textContent).toContain('Pairing codes are single-use and short-lived.');
    expect(screen.container.textContent).not.toContain('Connected');

    await interact(() => buttonNamed(screen.container, 'Start over').click());
    expect(screen.container.textContent).toContain('Connect a daemon');
    await screen.unmount();
  });

  it('reports a refusal that is not an Error, and sends a paired reader back to their daemons', async () => {
    const screen = await screenWith({
      connections: records,
      arrival: PREFILLED,
      onPair: async () => {
        throw 'the daemon hung up';
      },
    });

    await interact(() => buttonNamed(screen.container, 'Pair this device').click());
    expect(screen.container.textContent).toContain('Could not pair with that daemon.');

    await interact(() => buttonNamed(screen.container, 'Back to my daemons').click());
    expect(screen.container.textContent).toContain('Your daemons');
    await screen.unmount();
  });

  it('declines a confirmation without pairing anything', async () => {
    let calls = 0;
    const screen = await screenWith({
      arrival: PREFILLED,
      onPair: async () => {
        calls += 1;
      },
    });

    await interact(() => buttonNamed(screen.container, 'Not now').click());

    expect(calls).toBe(0);
    expect(screen.container.textContent).toContain('Connect a daemon');
    await screen.unmount();
  });
});

describe('PairingScreen scanned and pasted links', () => {
  it('confirms a scanned pairing link before exchanging it', async () => {
    const screen = await screenWith({ scanHost: scanningHost(LINK) });

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect(screen.container.textContent).toContain('Pair this device?');
    expect(screen.container.textContent).toContain('daemon.example.test');
    await screen.unmount();
  });

  it('refuses a QR code that is not a pairing link', async () => {
    const screen = await screenWith({ scanHost: scanningHost('https://example.com/some-other-qr') });

    await interact(() => buttonNamed(screen.container, 'Scan QR code').click());

    expect(screen.container.textContent).toContain('That is not a Ferretry pairing link.');
    await screen.unmount();
  });

  it('reports a malformed pasted link without asking the host to exchange anything', async () => {
    let calls = 0;
    const screen = await screenWith({
      onPair: async () => {
        calls += 1;
      },
    });

    await interact(() => buttonNamed(screen.container, 'Paste a link instead').click());
    await typeLink(screen.container, 'not a link');
    await submitForm(screen.container);

    expect(calls).toBe(0);
    expect(screen.container.textContent).toContain('pairing URL must be absolute');
    await screen.unmount();
  });

  it('clears a pasted link before confirming it, so the field never holds a live code', async () => {
    const screen = await screenWith({ scanHost: null });

    await typeLink(screen.container, LINK);
    const input = must(screen.container.querySelector('input'), 'the paste field') as HTMLInputElement;
    expect(input.value).toBe(LINK);
    await submitForm(screen.container);

    expect(screen.container.textContent).toContain('Pair this device?');
    await interact(() => buttonNamed(screen.container, 'Not now').click());
    expect((must(screen.container.querySelector('input'), 'the paste field') as HTMLInputElement).value).toBe('');
    await screen.unmount();
  });
});

describe('the embedded presentation', () => {
  it('drops the page chrome the host already owns, and keeps the whole flow', async () => {
    const screen = await screenWith({ embedded: true, scanHost: null });

    // No second landmark, no second `<h1>`, no repeated brand or instruction:
    // the setup stepper has already said all of it.
    expect(screen.container.querySelector('main')).toBeNull();
    expect(screen.container.querySelector('h1')).toBeNull();
    expect(screen.container.textContent).not.toContain('Connect a daemon');
    expect(screen.container.textContent).not.toContain('Run fy pair on your computer');
    const frame = must(screen.container.querySelector('section'), 'the embedded frame');
    expect(frame.getAttribute('aria-label')).toBe('Pair this device');

    // The arc itself is untouched: paste, parse, confirm.
    await typeLink(screen.container, LINK);
    await submitForm(screen.container);
    expect(screen.container.textContent).toContain('Pair this device?');
    // Nested titles step down rather than competing with the host's stage heading.
    expect(screen.container.querySelector('h2')).toBeNull();
    expect(must(screen.container.querySelector('h3'), 'the confirmation title').textContent).toBe('Pair this device?');
    await screen.unmount();
  });

  it('keeps the standalone screen exactly as it was', async () => {
    const screen = await screenWith({ scanHost: null });

    expect(screen.container.querySelector('main')).not.toBeNull();
    expect(must(screen.container.querySelector('h1'), 'the page title').textContent).toBe('Connect a daemon');
    expect(screen.container.querySelector('[data-pairing-setup]')).toBeNull();
    await screen.unmount();
  });

  it('offers the setup guide only where a host asked for the link', async () => {
    let opened = 0;
    const screen = await screenWith({
      connections: records,
      selectedDaemonId: alpha.daemonId,
      onOpenSetup: () => {
        opened += 1;
      },
    });

    const link = must(screen.container.querySelector<HTMLButtonElement>('[data-pairing-setup]'), 'the setup link');
    expect(link.className).toContain('min-h-[44px]');
    await interact(() => link.click());
    expect(opened).toBe(1);
    await screen.unmount();
  });
});
