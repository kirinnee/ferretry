import { describe, expect, it } from 'bun:test';
import { PAIRING_SCREEN_SELECTOR } from '@ferretry/protocol';
import type { PairingCodeMintResponse, PairingId } from '@ferretry/protocol';
import { AddDeviceCard } from '../../../src/features/settings/add-device-settings.tsx';
import { PairingScreen } from '../../../src/features/pairing/pairing-screen.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { holdPairingScreenMarker } from '../../../src/lib/pairing-screen-marker.ts';
import { interact, mount, must } from '../../support/dom.ts';

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
  expiresAt: '2026-08-03T12:02:00.000Z',
  daemonId: DAEMON_ID,
  daemonName: 'workstation',
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

describe('the pairing-screen marker', () => {
  it('should stay while any holder remains, and be gone when the last lets go', () => {
    // Arrange, Act
    const first = holdPairingScreenMarker();
    const second = holdPairingScreenMarker();

    // Assert
    expect(markers()).toBeGreaterThan(0);
    first();
    first();
    expect(markers()).toBeGreaterThan(0);
    second();
    expect(markers()).toBe(0);
  });

  it('should be set while the Add a device panel shows a live code, and cleared when the code is cleared', async () => {
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

      // Act — Done
      await panel.render(cardWith());

      // Assert
      expect(panel.container.querySelector('[data-pair-code]')).toBeNull();
      expect(markers()).toBe(0);
    } finally {
      await panel.unmount();
    }
  });

  it('should be cleared when the code runs out, and when the panel goes away', async () => {
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

  it('should be set while the pair screen holds a pasted link, and cleared with it', async () => {
    // Arrange
    const screen = await mount(
      <PairingScreen
        connections={[]}
        selectedDaemonId={null}
        scanHost={{ supported: true, scan: async () => await new Promise<string>(() => {}) }}
        onPair={async () => {}}
        onRemove={() => {}}
        onSelect={() => {}}
      />,
    );
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
    } finally {
      await screen.unmount();
    }
    expect(markers()).toBe(0);
  });
});
