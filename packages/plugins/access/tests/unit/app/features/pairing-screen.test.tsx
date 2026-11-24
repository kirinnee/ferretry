import { describe, expect, it, spyOn } from 'bun:test';
import { StrictMode } from 'react';

import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';
import { DeviceKeyUnsupportedError, UNSUPPORTED_DEVICE_KEY_SENTENCE } from '../../../../app/lib/device-keys.ts';
import type { QrScanHost } from '../../../../app/lib/pair-scan.ts';
import type { PairingArrival, PairingSeed } from '../../../../app/lib/pairing.ts';
import { daemonConnection, RelayPairingRefusedError } from '../../../../app/shell-pairing.ts';
import { interact, mount, must } from '../../../support/app/dom.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-secret',
  daemonName: 'Studio daemon',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceId: 'beta-secret',
  daemonName: 'beta-host',
});
/** Paired before the daemon's own name was kept: its address is all this browser has. */
const gamma = daemonConnection({ daemonId: 'gamma', baseUrl: 'https://gamma.example.test', deviceId: 'gamma-secret' });
const records = [
  { ...alpha, pairedAt: 1, lastSelectedAt: 2 },
  { ...beta, pairedAt: 1, lastSelectedAt: 1 },
  { ...gamma, pairedAt: 1, lastSelectedAt: 0 },
] as const;

const LINK =
  'https://pwa.example.test/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=7F3K-Q2ND;fp=fy_daemon_ddddddddddddddddddddddddddddddddddddddddddd';
const SEED: PairingSeed = { daemonUrl: 'https://daemon.example.test', daemonId: 'daemon-a', code: 'single-use' };
const PREFILLED: PairingArrival = { kind: 'seed', seed: SEED };

const idleHost: QrScanHost = { supported: true, scan: async () => await new Promise<string>(() => {}) };

const scanningHost = (text: string): QrScanHost => ({ supported: true, scan: async () => text });

const buttonNamed = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text)) ?? null,
    `a button labelled ${text}`,
  );

/** One of the three ways, by its title: the card (a label over a native radio) the person presses. */
const wayNamed = (container: HTMLElement, text: string): HTMLLabelElement =>
  must(
    [...container.querySelectorAll<HTMLLabelElement>('[data-pair-ways] label')].find(candidate =>
      candidate.textContent?.includes(text),
    ) ?? null,
    `a way titled ${text}`,
  );

const wayOff = (way: HTMLElement): boolean => must(way.querySelector('input'), 'the way radio').disabled;

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
    expect(wayNamed(screen.container, 'Scan QR code')).toBeDefined();
    // The card that used to say "0" and then explain that it was 0.
    expect(screen.container.textContent).not.toContain('Paired daemons');
    expect(screen.container.textContent).not.toContain('No daemons are paired yet');
    expect(screen.container.querySelector('ul[aria-label="Paired daemons"]')).toBeNull();
    // Paste is present but quiet: a link to reveal, not the hero control.
    expect(screen.container.querySelector('input[aria-label="Pairing link"]')).toBeNull();
    expect(screen.container.textContent).toContain('Paste a link');
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
    await interact(() => wayNamed(screen.container, 'Paste a link').click());
    expect(screen.container.querySelector('input[aria-label="Pairing link"]')).not.toBeNull();
    await screen.unmount();

    const noCamera = await screenWith({ scanHost: null });
    expect(noCamera.container.querySelector('input[aria-label="Pairing link"]')).not.toBeNull();
    expect(wayOff(wayNamed(noCamera.container, 'Scan QR code'))).toBe(true);
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
    // An unlabelled machine is named by what it calls itself, with its address beneath — never by its
    // fingerprint, and never by its address alone when it has said its name.
    expect(screen.container.textContent).toContain('beta-host');
    expect(screen.container.textContent).toContain('https://beta.example.test');
    // A pairing with nothing but its address shows that address once, not twice.
    expect(screen.container.textContent?.split('https://gamma.example.test')).toHaveLength(2);
    expect(screen.container.textContent).not.toContain('alpha-secret');
    expect(screen.container.textContent).not.toContain('beta-secret');
    expect(wayNamed(screen.container, 'Scan QR code')).toBeDefined();

    const chosen = must(screen.container.querySelector('button[aria-current="true"]'), 'the selected daemon');
    const forget = must(screen.container.querySelector('button[aria-label="Forget beta-host"]'), 'the forget control');
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
    expect(screen.container.textContent).toContain('Pairing directly with daemon.example.test.');
    expect(screen.container.textContent).toContain('daemon.example.test');
    expect(screen.container.textContent).toContain('daemon-a');
    // The one-time code is never rendered, and the address bar is emptied of it.
    expect(screen.container.textContent).not.toContain('single-use');
    expect(screen.container.querySelector('input:not([data-pair-machine-name])')).toBeNull();
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

  /*
   * The other half of the same rule. A sealed `pair-refused` means the DAEMON judged this code, and
   * §14 gives its remedy as "the direct route's own sentence — the code is wrong, expired or spent;
   * mint a fresh one". The two causes must never share a sentence, and the attribute is what a
   * browser harness reads instead of matching on the copy.
   */
  it('sends a reader whose code the daemon refused to mint a fresh one', async () => {
    const screen = await screenWith({
      arrival: PREFILLED,
      onPair: async () => {
        throw new RelayPairingRefusedError();
      },
    });

    await interact(() => buttonNamed(screen.container, 'Pair this device').click());

    expect(screen.container.querySelector('[data-pairing-failure="refusal"]')).not.toBeNull();
    expect(screen.container.textContent).toContain('Pairing codes are single-use and short-lived.');
    expect(screen.container.textContent).not.toContain('its code is probably still good');
    await screen.unmount();
  });

  it('says plainly when this browser cannot make the key Ferretry pairs with', async () => {
    // B6: the host is told, so the setup step stops adding advice about the code beneath it.
    const told: boolean[] = [];
    const screen = await screenWith({
      arrival: PREFILLED,
      onPair: async () => {
        throw new DeviceKeyUnsupportedError();
      },
      onStatedFailure: stated => told.push(stated),
    });

    await interact(() => buttonNamed(screen.container, 'Pair this device').click());

    expect(
      must(screen.container.querySelector('[data-pairing-failure="stated"]'), 'the stated failure').textContent,
    ).toBe(UNSUPPORTED_DEVICE_KEY_SENTENCE);
    expect(screen.container.textContent).not.toContain('its code is probably still good');
    expect(screen.container.textContent).not.toContain('Pairing codes are single-use');
    expect(told).toEqual([false, true]);
    await screen.unmount();
  });

  it('shows what was tried as short lines and the likely fixes as a numbered list', async () => {
    const screen = await screenWith({
      arrival: PREFILLED,
      onPair: async () => {
        throw new Error(
          [
            'First, directly at 127.0.0.1:7617: no answer. 127.0.0.1 only works on that machine itself, or through an SSH tunnel from this computer.',
            "Then Ferretry's relay (relay.example) answered, but the machine is not connected to it, so it could not carry the pairing.",
            'Most likely fix:',
            '1. If you use an SSH tunnel: check it is still running.',
            '2. Open the link in the same browser, on the same computer as the tunnel.',
          ].join('\n'),
        );
      },
    });

    await interact(() => buttonNamed(screen.container, 'Pair this device').click());

    const failure = must(screen.container.querySelector('[data-pairing-failure="transport"]'), 'the failure');
    expect([...failure.querySelectorAll('p')].map(line => line.textContent)).toEqual([
      'First, directly at 127.0.0.1:7617: no answer. 127.0.0.1 only works on that machine itself, or through an SSH tunnel from this computer.',
      "Then Ferretry's relay (relay.example) answered, but the machine is not connected to it, so it could not carry the pairing.",
      'Most likely fix:',
    ]);
    expect([...failure.querySelectorAll('ol > li')].map(item => item.textContent)).toEqual([
      'If you use an SSH tunnel: check it is still running.',
      'Open the link in the same browser, on the same computer as the tunnel.',
    ]);
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
    // One remedy per reason: nothing reached the daemon, so the code is probably still good and
    // telling this reader to mint another would send them to redo the step that was working.
    expect(screen.container.querySelector('[data-pairing-failure="transport"]')).not.toBeNull();
    expect(screen.container.textContent).toContain('its code is probably still good');
    // (The progress bar names its stages, "Connected" among them; the success HEADING is what a failure must not show.)
    expect(screen.container.querySelector('#pairing-title')?.textContent).toBe('Pairing failed');

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

    await interact(() => wayNamed(screen.container, 'Scan QR code').click());

    expect(screen.container.textContent).toContain('Pair this device?');
    expect(screen.container.textContent).toContain('daemon.example.test');
    await screen.unmount();
  });

  it('refuses a QR code that is not a pairing link', async () => {
    const screen = await screenWith({ scanHost: scanningHost('https://example.com/some-other-qr') });

    await interact(() => wayNamed(screen.container, 'Scan QR code').click());

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

    await interact(() => wayNamed(screen.container, 'Paste a link').click());
    await typeLink(screen.container, 'not a link');
    await submitForm(screen.container);

    expect(calls).toBe(0);
    expect(screen.container.textContent).toContain('pairing URL must be absolute');
    await screen.unmount();
  });

  it('clears a pasted link before confirming it, so the field never holds a live code', async () => {
    const screen = await screenWith({ scanHost: null });

    await typeLink(screen.container, LINK);
    const input = must(
      screen.container.querySelector('input[aria-label="Pairing link"]'),
      'the paste field',
    ) as HTMLInputElement;
    expect(input.value).toBe(LINK);
    await submitForm(screen.container);

    expect(screen.container.textContent).toContain('Pair this device?');
    await interact(() => buttonNamed(screen.container, 'Not now').click());
    expect(
      (must(screen.container.querySelector('input[aria-label="Pairing link"]'), 'the paste field') as HTMLInputElement)
        .value,
    ).toBe('');
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

describe('PairingScreen naming this device', () => {
  const setField = async (container: HTMLElement, value: string): Promise<void> => {
    if (container.querySelector('input[data-pair-device-name]') === null)
      await interact(() => buttonNamed(container, 'Rename').click());
    const input = must(container.querySelector('input[data-pair-device-name]'), 'the name field') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));
  };

  it('offers a distinct default name and sends whatever the person changed it to', async () => {
    // Arrange — every browser used to pair as "Ferretry PWA", so two made every name ambiguous.
    const sent: [PairingSeed, string][] = [];
    const screen = await screenWith({
      arrival: PREFILLED,
      defaultName: () => 'Chrome on macOS · K7Q2',
      onPair: async (seed, name) => {
        sent.push([seed, name]);
      },
    });
    // Said, not asked: the screen is still one decision until the person chooses to rename.
    expect(screen.container.querySelector('[data-pair-device-label]')?.textContent).toContain('Chrome on macOS · K7Q2');
    expect(screen.container.querySelector('input:not([data-pair-machine-name])')).toBeNull();

    // Act
    await setField(screen.container, '  Kitchen iPad  ');
    await interact(() => buttonNamed(screen.container, 'Pair this device').click());

    // Assert — trimmed, and the code goes with it.
    expect(sent).toEqual([[SEED, 'Kitchen iPad']]);
    await screen.unmount();
  });

  it('sends the machine name typed on the confirm screen with the pair, and none when it is left empty', async () => {
    const sent: (string | undefined)[] = [];
    const screen = await screenWith({
      arrival: PREFILLED,
      onPair: async (_seed, _name, machine) => {
        sent.push(machine);
      },
    });
    const field = must(
      screen.container.querySelector('input[data-pair-machine-name]'),
      'the machine field',
    ) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, '  Studio box ');
    await interact(() => field.dispatchEvent(new Event('input', { bubbles: true })));
    await interact(() => buttonNamed(screen.container, 'Pair this device').click());
    expect(sent).toEqual(['Studio box']);
    await screen.unmount();

    // A link by IP address names no machine, so an untouched field is empty and sends none (a named host is prefilled: pairing-machine-name-prefill.test.tsx).
    const quiet = await screenWith({
      arrival: { kind: 'seed', seed: { ...SEED, daemonUrl: 'http://192.168.1.20:7456' } },
      onPair: async (_seed, _name, machine) => {
        sent.push(machine);
      },
    });
    await interact(() => buttonNamed(quiet.container, 'Pair this device').click());
    expect(sent).toEqual(['Studio box', undefined]);
    await quiet.unmount();
  });

  it('says why a machine name with an invisible character cannot be used, inline, and does not pair', async () => {
    const sent: (string | undefined)[] = [];
    const screen = await screenWith({
      arrival: PREFILLED,
      onPair: async (_seed, _name, machine) => {
        sent.push(machine);
      },
    });
    const field = must(
      screen.container.querySelector('input[data-pair-machine-name]'),
      'the machine field',
    ) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Studio\u200Bbox');
    await interact(() => field.dispatchEvent(new Event('input', { bubbles: true })));
    expect(screen.container.querySelector('[data-pair-machine-name-problem]')?.textContent).toContain('invisible');
    const confirm = buttonNamed(screen.container, 'Pair this device');
    expect(confirm.disabled).toBe(true);
    await interact(() => confirm.click());
    expect(sent).toEqual([]);
    expect(screen.container.querySelector('input[data-pair-machine-name]')).not.toBeNull();
    await screen.unmount();
  });

  it('will not pair a device with no name', async () => {
    const sent: string[] = [];
    const screen = await screenWith({
      arrival: PREFILLED,
      defaultName: () => 'Firefox on Linux · 2345',
      onPair: async (_seed, name) => {
        sent.push(name);
      },
    });

    await setField(screen.container, '   ');
    const confirm = buttonNamed(screen.container, 'Pair this device');
    await interact(() => confirm.click());

    expect(confirm.disabled).toBe(true);
    expect(sent).toEqual([]);
    await screen.unmount();
  });

  it('names a browser by itself when nobody passes a name', async () => {
    const screen = await screenWith({ arrival: PREFILLED });
    expect(screen.container.querySelector('[data-pair-device-label]')?.textContent).toMatch(/ · [2-9A-Z]{4}\./u);
    await screen.unmount();
  });
});

describe('PairingScreen pasted link', () => {
  const FAKE_LINK =
    'https://pwa.example.test/pair#v1;url=https%3A%2F%2Fdaemon.example.test;code=7F3K-Q2ND;fp=fy_daemon_ddddddddddddddddddddddddddddddddddddddddddd';

  it('is never put in the markup while typed, and is masked and unnamed', async () => {
    const screen = await screenWith({ scanHost: null });
    await typeLink(screen.container, FAKE_LINK);
    const input = must(
      screen.container.querySelector('input[aria-label="Pairing link"]'),
      'the paste field',
    ) as HTMLInputElement;
    expect(input.value).toBe(FAKE_LINK);
    expect(input.type).toBe('password');
    expect(input.hasAttribute('name')).toBe(false);
    expect(input.getAttribute('value')).toBeNull();
    expect(screen.container.innerHTML).not.toContain('7F3K-Q2ND');
    // Typing is still what turns the button on.
    expect(buttonNamed(screen.container, 'Use this link').disabled).toBe(false);
    await screen.unmount();
  });

  it('still pairs with the typed link, and empties the field when it is used', async () => {
    const seen: PairingSeed[] = [];
    const screen = await screenWith({
      scanHost: null,
      onPair: async seed => {
        seen.push(seed);
      },
    });
    const input = must(
      screen.container.querySelector('input[aria-label="Pairing link"]'),
      'the paste field',
    ) as HTMLInputElement;
    await typeLink(screen.container, FAKE_LINK);
    await submitForm(screen.container);
    expect(input.value).toBe('');
    expect(screen.container.innerHTML).not.toContain('7F3K-Q2ND');
    await interact(() => buttonNamed(screen.container, 'Pair this device').click());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.code).toBe('7F3K-Q2ND');
    await screen.unmount();
  });
});

describe('PairingScreen uploaded QR image', () => {
  const FAKE_UPLOAD_LINK =
    'https://pwa.example.test/pair#v1;url=https%3A%2F%2Fuploaded.example.test;code=FAKE-2222;fp=fy_daemon_ddddddddddddddddddddddddddddddddddddddddddd';
  const FAKE_PASTED_LINK =
    'https://pwa.example.test/pair#v1;url=https%3A%2F%2Fpasted.example.test;code=FAKE-3333;fp=fy_daemon_ddddddddddddddddddddddddddddddddddddddddddd';

  const chooseImage = async (container: HTMLElement): Promise<void> => {
    const input = must(container.querySelector('input[data-pair-upload]'), 'the upload input') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['pixels'], 'code.png', { type: 'image/png' })],
    });
    await interact(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  };

  it('does not switch the confirm screen when a slow upload finishes after another link was pasted', async () => {
    let finish: (text: string) => void = () => {};
    const screen = await screenWith({
      readImage: async () => await new Promise<string>(resolve => (finish = resolve)),
    });

    await chooseImage(screen.container);
    await interact(() => wayNamed(screen.container, 'Paste a link').click());
    await typeLink(screen.container, FAKE_PASTED_LINK);
    await submitForm(screen.container);
    expect(screen.container.textContent).toContain('pasted.example.test');

    await interact(() => finish(FAKE_UPLOAD_LINK));

    expect(screen.container.textContent).toContain('Pair this device?');
    expect(screen.container.textContent).toContain('pasted.example.test');
    expect(screen.container.textContent).not.toContain('uploaded.example.test');
    await screen.unmount();
  });

  it('keeps a half-typed link when a slow upload finishes after Paste was chosen again, field already open', async () => {
    for (const scanHost of [idleHost, null]) {
      let finish: (text: string) => void = () => {};
      const screen = await screenWith({
        scanHost,
        readImage: async () => await new Promise<string>(resolve => (finish = resolve)),
      });
      // With a camera the field is opened first; without one it is open from the start.
      if (scanHost !== null) await interact(() => wayNamed(screen.container, 'Paste a link').click());
      expect(screen.container.querySelector('input[aria-label="Pairing link"]')).not.toBeNull();

      await chooseImage(screen.container);
      await interact(() => wayNamed(screen.container, 'Paste a link').click());
      await typeLink(screen.container, FAKE_PASTED_LINK);
      await interact(() => finish(FAKE_UPLOAD_LINK));

      expect(screen.container.textContent).not.toContain('Pair this device?');
      const field = must(screen.container.querySelector('input[aria-label="Pairing link"]'), 'the paste field');
      expect((field as HTMLInputElement).value).toBe(FAKE_PASTED_LINK);
      await screen.unmount();
    }
  });

  it('keeps a link being typed when a slow upload finishes, even with no second choice of Paste', async () => {
    let finish: (text: string) => void = () => {};
    const screen = await screenWith({
      scanHost: null,
      readImage: async () => await new Promise<string>(resolve => (finish = resolve)),
    });

    await chooseImage(screen.container);
    await typeLink(screen.container, FAKE_PASTED_LINK);
    await interact(() => finish(FAKE_UPLOAD_LINK));

    expect(screen.container.textContent).not.toContain('Pair this device?');
    expect(
      (must(screen.container.querySelector('input[aria-label="Pairing link"]'), 'the field') as HTMLInputElement).value,
    ).toBe(FAKE_PASTED_LINK);
    await screen.unmount();
  });

  it('confirms the uploaded link when nothing else was chosen meanwhile', async () => {
    const screen = await screenWith({ readImage: async () => FAKE_UPLOAD_LINK });

    await chooseImage(screen.container);

    expect(screen.container.textContent).toContain('Pair this device?');
    expect(screen.container.textContent).toContain('uploaded.example.test');
    await screen.unmount();
  });

  it('shows the error for an unreadable image under StrictMode', async () => {
    const screen = await mount(
      <StrictMode>
        <PairingScreen
          connections={[]}
          selectedDaemonId={null}
          scanHost={idleHost}
          readImage={async () => {
            throw new Error('not an image');
          }}
          onPair={async () => {}}
          onRemove={() => {}}
          onSelect={() => {}}
        />
      </StrictMode>,
    );

    await chooseImage(screen.container);

    expect(must(screen.container.querySelector('[data-pair-upload-problem]'), 'the problem').textContent).toBe(
      'That image could not be read.',
    );
    expect(wayOff(wayNamed(screen.container, 'Upload a QR image'))).toBe(false);
    await screen.unmount();
  });

  it('never writes a pairing code to the console, whichever way it was read', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
      spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const uploaded = await screenWith({ readImage: async () => FAKE_UPLOAD_LINK });
      await chooseImage(uploaded.container);
      await uploaded.unmount();

      const scanned = await screenWith({ scanHost: scanningHost(FAKE_UPLOAD_LINK) });
      await interact(() => wayNamed(scanned.container, 'Scan QR code').click());
      await scanned.unmount();

      const pasted = await screenWith({ scanHost: null });
      await typeLink(pasted.container, FAKE_PASTED_LINK);
      await submitForm(pasted.container);
      await pasted.unmount();

      const printed = spies.flatMap(spy => spy.mock.calls.map(call => call.map(String).join(' '))).join('\n');
      expect(printed).not.toContain('FAKE-2222');
      expect(printed).not.toContain('FAKE-3333');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('PairingScreen never shows the loopback address of a relayed daemon', () => {
  const LOOPBACK_SEED: PairingSeed = {
    daemonUrl: 'http://127.0.0.1:7617',
    daemonId: 'fy_daemon_ddddddddddddddddddddddddddddddddddddddddddd',
    code: 'single-use',
  };
  const loopbackArrival: PairingArrival = { kind: 'seed', seed: LOOPBACK_SEED };

  it('confirms with "through the relay" and no address, and keeps the fingerprint behind Details', async () => {
    const screen = await screenWith({ arrival: loopbackArrival, sameMachine: false });

    // Another device is not "this computer": the line names the target and says how it is reached, nothing more.
    const line = must(screen.container.querySelector('[data-daemon-path]'), 'the machine line');
    expect(line.textContent).toBe('Connecting to the machine through the relay. Details');
    expect(screen.container.textContent).not.toContain('this computer');
    expect(screen.container.textContent).not.toContain('127.0.0.1');
    expect(screen.container.textContent).not.toContain('7617');
    // ONE line, and a small "Details" link on its end: the fingerprint is in the page but hidden until the link is pressed.
    const details = must(screen.container.querySelector('[data-pair-details]'), 'the Details block');
    const fingerprint = must(details.querySelector<HTMLElement>('[data-pair-fingerprint]'), 'the fingerprint');
    const toggle = must(details.querySelector('button'), 'the Details link');
    expect(toggle.textContent).toBe('Details');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(fingerprint.hidden).toBe(true);
    expect(fingerprint.textContent).toContain(LOOPBACK_SEED.daemonId);
    await interact(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(fingerprint.hidden).toBe(false);
    await screen.unmount();
  });

  it("says it is direct, with the address, when the page runs on the daemon's own machine", async () => {
    const screen = await screenWith({ arrival: loopbackArrival, sameMachine: true });

    // On the daemon's own machine the line is the direct one, with its address: never the relay wording.
    const line = must(screen.container.querySelector('[data-daemon-path]'), 'the machine line');
    expect(line.textContent).toBe('Pairing directly with 127.0.0.1:7617. Details');
    expect(screen.container.textContent).not.toContain('Connecting to the machine');
    expect(screen.container.textContent).not.toContain('through the relay');
    await screen.unmount();
  });

  it('names the machine and the relay once paired, with no address', async () => {
    const screen = await screenWith({
      arrival: loopbackArrival,
      sameMachine: false,
      onPair: async () => ({ machine: 'studio', via: 'relay' }),
    });
    await interact(() => buttonNamed(screen.container, 'Pair this device').click());

    expect(screen.container.textContent).toContain('Paired with studio, through the relay.');
    expect(screen.container.textContent).not.toContain('127.0.0.1');
    await screen.unmount();
  });

  it('lists a loopback daemon by its name alone: no address and no path word', async () => {
    const relayed = daemonConnection({
      daemonId: 'relayed',
      baseUrl: 'http://127.0.0.1:7617',
      deviceId: 'relayed-secret',
      daemonName: 'studio',
    });
    for (const sameMachine of [false, true]) {
      const screen = await screenWith({
        connections: [{ ...relayed, pairedAt: 1, lastSelectedAt: 1 }],
        selectedDaemonId: relayed.daemonId,
        sameMachine,
      });

      expect(screen.container.textContent).toContain('studio');
      expect(screen.container.textContent).not.toContain('127.0.0.1');
      expect(screen.container.textContent).not.toContain('7617');
      expect(screen.container.textContent).not.toContain('direct');
      expect(screen.container.textContent).not.toContain('through the relay');
      await screen.unmount();
    }
  });

  it('lists a non-loopback daemon by its name and address, with no path word', async () => {
    const remote = daemonConnection({
      daemonId: 'remote',
      baseUrl: 'https://box.example.test',
      deviceId: 'remote-secret',
      daemonName: 'lab',
    });
    const screen = await screenWith({
      connections: [{ ...remote, pairedAt: 1, lastSelectedAt: 1 }],
      selectedDaemonId: remote.daemonId,
      sameMachine: false,
    });

    expect(screen.container.textContent).toContain('lab');
    expect(screen.container.textContent).toContain('https://box.example.test');
    expect(screen.container.textContent).not.toContain('direct');
    expect(screen.container.textContent).not.toContain('through the relay');
    await screen.unmount();
  });

  it('lists an unnamed loopback daemon by a plain stand-in, never its address', async () => {
    const unnamed = daemonConnection({
      daemonId: 'unnamed',
      baseUrl: 'http://127.0.0.1:7618',
      deviceId: 'unnamed-secret',
    });
    const screen = await screenWith({
      connections: [{ ...unnamed, pairedAt: 1, lastSelectedAt: 1 }],
      selectedDaemonId: unnamed.daemonId,
      sameMachine: false,
    });

    expect(screen.container.textContent).toContain('This machine');
    expect(screen.container.textContent).not.toContain('127.0.0.1');
    await screen.unmount();
  });
});
