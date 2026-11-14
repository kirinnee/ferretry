import { describe, expect, it } from 'bun:test';
import { PAIRING_EPOCH_SELECTOR, PAIRING_SCREEN_SELECTOR } from '@ferretry/protocol';
import { useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { usePairingScreenMarker } from '../../../src/lib/pairing-screen-marker.ts';
import '../../support/dom.ts';

/**
 * The marker must never be missing while a code is in the document (docs/pairing.md, "Never show it to an agent"). These
 * tests render WITHOUT `act`, so passive effects are not flushed for them: only what React does inside the commit itself
 * is there. The code is the repo's fixed fake, never a minted one.
 */
const FAKE_CODE = '7F3K-Q2ND';

const markers = (): number => document.head.querySelectorAll(PAIRING_SCREEN_SELECTOR).length;
const epoch = (): number => Number(document.head.querySelector(PAIRING_EPOCH_SELECTOR)?.getAttribute('content') ?? 0);

/** What the document looks like at the end of the commit's layout phase: before the browser could paint or answer. */
interface Seen {
  readonly code: boolean;
  readonly markers: number;
  readonly order: readonly string[];
}

function Screen({ shown }: { shown: boolean }) {
  usePairingScreenMarker(shown);
  return shown ? <span data-pair-code="">{FAKE_CODE}</span> : null;
}

/** The screen, then the probe as its SIBLING: its layout effect runs after the screen's, in the same commit. */
function Card({ shown, seen, observer }: { shown: boolean; seen: Seen[]; observer: MutationObserver }) {
  return (
    <>
      <Screen shown={shown} />
      <Probe seen={seen} observer={observer} />
    </>
  );
}

/** Runs after the card's own layout effects, in the same commit. */
function Probe({ seen, observer }: { seen: Seen[]; observer: MutationObserver }) {
  useLayoutEffect(() => {
    const order = observer
      .takeRecords()
      .flatMap(record => [
        ...[...record.addedNodes].map(node => `+${kind(node)}`),
        ...[...record.removedNodes].map(node => `-${kind(node)}`),
      ]);
    seen.push({ code: document.querySelector('[data-pair-code]') !== null, markers: markers(), order });
  });
  return null;
}

const kind = (node: Node): string => {
  if (!(node instanceof Element)) return 'other';
  if (node.matches('[data-pair-code]')) return 'code';
  if (node.matches(PAIRING_SCREEN_SELECTOR)) return 'marker';
  if (node.matches(PAIRING_EPOCH_SELECTOR)) return 'epoch';
  return 'other';
};

const withRoot = async (run: (root: ReturnType<typeof createRoot>, observer: MutationObserver) => Promise<void>) => {
  const env = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };
  const before = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const observer = new MutationObserver(() => undefined);
  observer.observe(document, { childList: true, subtree: true });
  try {
    await run(root, observer);
  } finally {
    flushSync(() => root.unmount());
    observer.disconnect();
    container.remove();
    for (const meta of document.head.querySelectorAll('meta[name^="ferretry-pairing"]')) meta.remove();
    env.IS_REACT_ACT_ENVIRONMENT = before;
  }
};

describe('the pairing-screen marker at the commit', () => {
  it('should already be in the document when the code is, before any passive effect could run', async () => {
    await withRoot(async (root, observer) => {
      // Arrange
      const seen: Seen[] = [];

      // Act
      flushSync(() => root.render(<Card shown={true} seen={seen} observer={observer} />));

      // Assert — the commit's own layout phase, not a later task
      const last = seen.at(-1);
      expect(last?.code).toBe(true);
      expect(last?.markers).toBe(1);
    });
  });

  it('should count up each time a code is shown, and never take the count away', async () => {
    await withRoot(async (root, observer) => {
      // Arrange
      const seen: Seen[] = [];

      // Act
      flushSync(() => root.render(<Card shown={true} seen={seen} observer={observer} />));
      const first = epoch();
      flushSync(() => root.render(<Card shown={false} seen={seen} observer={observer} />));
      const afterGone = epoch();
      flushSync(() => root.render(<Card shown={true} seen={seen} observer={observer} />));

      // Assert
      expect(first).toBe(1);
      expect(afterGone).toBe(1);
      expect(epoch()).toBe(2);
    });
  });

  it('should leave the marker in the document until the code is gone from it, never the other way round', async () => {
    await withRoot(async (root, observer) => {
      // Arrange
      const seen: Seen[] = [];
      flushSync(() => root.render(<Card shown={true} seen={seen} observer={observer} />));

      // Act
      flushSync(() => root.render(<Card shown={false} seen={seen} observer={observer} />));

      // Assert — in this commit's mutations the code leaves first; the marker is gone only after that
      const order = seen.at(-1)?.order ?? [];
      const codeGone = order.indexOf('-code');
      const markerGone = order.indexOf('-marker');
      expect(codeGone).toBeGreaterThanOrEqual(0);
      expect(markerGone === -1 || markerGone > codeGone).toBe(true);
    });
  });

  it('should leave the marker until the code is gone when the whole screen unmounts', async () => {
    await withRoot(async (root, observer) => {
      // Arrange
      const seen: Seen[] = [];
      flushSync(() => root.render(<Card shown={true} seen={seen} observer={observer} />));
      observer.takeRecords();

      // Act
      flushSync(() => root.unmount());
      const order = observer
        .takeRecords()
        .flatMap(record => [
          ...[...record.addedNodes].map(node => `+${kind(node)}`),
          ...[...record.removedNodes].map(node => `-${kind(node)}`),
        ]);

      // Assert — code first; the marker is gone in this commit only after it, or a moment later
      const codeGone = order.indexOf('-code');
      const markerGone = order.indexOf('-marker');
      expect(codeGone).toBeGreaterThanOrEqual(0);
      expect(markerGone === -1 || markerGone > codeGone).toBe(true);
      await Promise.resolve();
      expect(markers()).toBe(0);
    });
  });
});
