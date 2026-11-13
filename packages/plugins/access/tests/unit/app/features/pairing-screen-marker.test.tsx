import { describe, expect, it } from 'bun:test';
import { InstantSchema } from '@ferretry/std';
import { PAIRING_SCREEN_SEEN_META_NAME, PAIRING_SCREEN_SELECTOR } from '@ferretry/std/pairing-screen';
import type { PairingCodeMintResponse, PairingId } from '../../../../contract/index.ts';
import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';
import { AddDeviceCard } from '../../../../app/features/settings/add-device-settings.tsx';
import { holdPairingScreenMarker } from '../../../../app/lib/pairing-screen-marker.ts';
import { daemonConnection } from '../../../../app/shell-pairing.ts';
import { interact, mount, must } from '../../../support/app/dom.ts';
// React DOM reads the DOM globals when it loads, and dom.ts is what installs them: load it after, as dom.ts does.
const { createRoot } = await import('react-dom/client');

/**
 * A screen showing a live pairing code carries ONE marker in the document head (docs/pairing.md, "Never show it to an
 * agent"): the daemon's browser refuses an agent every read of a page that has it. These tests use the repo's fixed
 * fake code and never a minted one.
 */
const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
const NOW = Date.parse('2026-08-03T12:01:00.000Z');
const FAKE_CODE = '7F3K-Q2ND';
const connection = daemonConnection({
  daemonId: DAEMON_ID,
  baseUrl: 'https://workstation.example.test',
  deviceId: 'tok',
});

const invite: PairingCodeMintResponse = {
  pairingId: `fy_pair_${'b'.repeat(22)}` as PairingId,
  code: FAKE_CODE,
  ttlSeconds: 120,
  expiresAt: InstantSchema.parse('2026-08-03T12:02:00.000Z'),
  daemonId: DAEMON_ID,
  daemonName: 'workstation',
  grants: 'full',
  daemonUrl: 'https://workstation.example.test',
  pairUrl: `https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test;code=${FAKE_CODE};fp=${DAEMON_ID}`,
  reach: 'any-device',
};

const markers = (): number => document.head.querySelectorAll(PAIRING_SCREEN_SELECTOR).length;

const cardWith = (overrides: Partial<Parameters<typeof AddDeviceCard>[0]> = {}) => (
  <AddDeviceCard
    connection={connection}
    view={{ devices: [], hostLocal: true, thisDeviceId: 'x', mayWiden: {} as never }}
    invite={null}
    nowMs={NOW}
    onMint={() => {}}
    onDiscardInvite={() => {}}
    onRevokeCode={() => {}}
    onRevokeDevice={() => {}}
    onChangeDeviceGrants={() => {}}
    {...overrides}
  />
);

const screenElement = (overrides: Partial<Parameters<typeof PairingScreen>[0]> = {}) => (
  <PairingScreen
    connections={[]}
    selectedDaemonId={null}
    scanHost={{ supported: true, scan: async () => await new Promise<string>(() => {}) }}
    onPair={async () => {}}
    onRemove={() => {}}
    onSelect={() => {}}
    {...overrides}
  />
);

describe('the pairing-screen marker', () => {
  it('should be one meta element named ferretry-pairing-screen, removed by the one function that added it', () => {
    // Arrange, Act
    const release = holdPairingScreenMarker();
    const meta = document.head.querySelector('meta[name="ferretry-pairing-screen"]');

    // Assert
    expect(meta?.getAttribute('content')).toBe('shown');
    expect(markers()).toBe(1);
    release();
    release();
    expect(markers()).toBe(0);
  });

  it('should keep each holder’s own element: two screens cannot clear each other’s marker', () => {
    // Arrange, Act
    const first = holdPairingScreenMarker();
    const second = holdPairingScreenMarker();
    first();
    first();

    // Assert
    expect(markers()).toBe(1);
    second();
    expect(markers()).toBe(0);
  });

  it('should be set while the Add a device panel shows a live code, and gone when the code is cleared', async () => {
    // Arrange
    const panel = await mount(cardWith());
    try {
      expect(markers()).toBe(0);

      // Act
      await panel.render(cardWith({ invite }));

      // Assert — the code, link and QR are on screen, and so is the marker.
      expect(panel.container.querySelector('[data-pair-code]')?.textContent).toBe(FAKE_CODE);
      expect(markers()).toBe(1);
      expect(document.head.querySelector(PAIRING_SCREEN_SELECTOR)?.getAttribute('content')).toBe('shown');

      // Act — the code is discarded
      await panel.render(cardWith());

      // Assert
      expect(panel.container.querySelector('[data-pair-code]')).toBeNull();
      expect(markers()).toBe(0);
    } finally {
      await panel.unmount();
    }
  });

  it('should be gone when the code runs out, and when the panel goes away', async () => {
    // Arrange
    const panel = await mount(cardWith({ invite }));
    expect(markers()).toBe(1);

    // Act — the code expires: nothing is shown any more
    await panel.render(cardWith({ invite, nowMs: Date.parse('2026-08-03T12:05:00.000Z') }));
    expect(markers()).toBe(0);
    await panel.render(cardWith({ invite }));
    expect(markers()).toBe(1);
    await panel.unmount();

    // Assert
    expect(markers()).toBe(0);
  });

  it('should be set while the pair screen holds a pasted link, and gone with it', async () => {
    // Arrange
    const screen = await mount(screenElement());
    try {
      expect(markers()).toBe(0);
      const reveal = [...screen.container.querySelectorAll('button')].find(button =>
        button.textContent?.includes('Paste'),
      );
      if (reveal !== undefined) await interact(() => reveal.click());
      const input = must(
        screen.container.querySelector('input[aria-label="Pairing link"]'),
        'the paste field',
      ) as HTMLInputElement;

      // Act
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, invite.pairUrl);
      await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));

      // Assert
      expect(markers()).toBe(1);

      // Act — the field is emptied
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '');
      await interact(() => input.dispatchEvent(new Event('input', { bubbles: true })));

      // Assert
      expect(markers()).toBe(0);
    } finally {
      await screen.unmount();
    }
    expect(markers()).toBe(0);
  });

  it('should be set while the pair screen holds an arriving link to confirm, and gone once it unmounts', async () => {
    // Arrange, Act
    const screen = await mount(
      screenElement({
        arrival: {
          kind: 'seed',
          seed: { daemonUrl: 'https://daemon.example.test', daemonId: 'daemon-a', code: 'FAKE-PAIR-0000' },
        },
      }),
    );

    // Assert
    expect(markers()).toBe(1);
    await screen.unmount();
    expect(markers()).toBe(0);
  });

  it('should be absent from a pair screen that holds no link', async () => {
    // Arrange, Act
    const screen = await mount(screenElement());

    // Assert
    expect(markers()).toBe(0);
    await screen.unmount();
  });

  it('should keep a sighting count that outlives the marker, one more for every code that comes on screen', () => {
    // Arrange
    const count = (): string | null | undefined =>
      document.head.querySelector(`meta[name="${PAIRING_SCREEN_SEEN_META_NAME}"]`)?.getAttribute('content');
    const before = Number(count() ?? 0);

    // Act
    const first = holdPairingScreenMarker();
    first();
    const second = holdPairingScreenMarker();
    second();

    // Assert — the marker is gone, the count is not, and it counted both
    expect(markers()).toBe(0);
    expect(Number(count())).toBe(before + 2);
  });

  it('should hold the marker in the SAME commit that puts the code in the document, before any passive effect', async () => {
    // Arrange — no `act`: it would flush passive effects and hide the interval a passive marker leaves open.
    const flags = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasActEnvironment = flags.IS_REACT_ACT_ENVIRONMENT;
    flags.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    /** Every look the observer got at the document: how many markers there were while the code was visible. */
    const looks: { readonly codeVisible: boolean; readonly markers: number }[] = [];
    const observer = new MutationObserver(() =>
      looks.push({ codeVisible: container.textContent?.includes(FAKE_CODE) === true, markers: markers() }),
    );
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    const settle = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 50));
    try {
      // Act — the code comes on screen (a mint's answer), then goes away
      root.render(cardWith({ invite }));
      await settle();
      root.render(cardWith());
      await settle();

      // Assert — the first look at the code's DOM already had the marker, and so did every look until it was gone
      const withCode = looks.filter(look => look.codeVisible);
      expect(withCode.length).toBeGreaterThan(0);
      expect(withCode.every(look => look.markers === 1)).toBe(true);
      expect(looks.some(look => !look.codeVisible && look.markers > 0)).toBe(false);
      expect(markers()).toBe(0);
    } finally {
      observer.disconnect();
      root.unmount();
      container.remove();
      flags.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
    }
  });
});
