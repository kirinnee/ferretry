import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';
import type { PairingArrival, PairingSeed } from '../../../../app/lib/pairing.ts';
import { interact, mount, must } from '../../../support/app/dom.ts';

/**
 * THE MASCOT AND THE NIGHT SKY around the pair page: what the DOM must say (poses, one primary action, focus, one
 * live region, scenery out of the accessibility tree, a hidden tab pausing the sky). What they LOOK like and what
 * actually runs under reduced motion is measured in a real browser (`tests/integration/app/pairing-scene.visual.test.ts`);
 * this file also pins the stylesheet's own rule that nothing animates outside the one gated block.
 */

const SEED: PairingSeed = {
  daemonUrl: 'http://127.0.0.1:7617',
  daemonId: 'fy_daemon_ddddddddddddddddddddddddddddddddddddddddddd',
  code: 'single-use',
};
const ARRIVAL: PairingArrival = { kind: 'seed', seed: SEED };

const screenWith = async (overrides: Partial<Parameters<typeof PairingScreen>[0]> = {}) =>
  await mount(
    <PairingScreen
      connections={[]}
      selectedDaemonId={null}
      arrival={ARRIVAL}
      sameMachine={false}
      onPair={async () => ({ machine: 'studio', via: 'relay' })}
      onRemove={() => {}}
      onSelect={() => {}}
      {...overrides}
    />,
  );

const pose = (container: HTMLElement): string | null =>
  container.querySelector('svg.fy-ferret')?.getAttribute('data-pose') ?? null;

const press = async (container: HTMLElement, text: string): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text));
  await interact(() => must(button ?? null, `a button labelled ${text}`).click());
};

describe('the pair page mascot', () => {
  it('peeks on a cold open and on a confirm, with one primary action', async () => {
    const cold = await screenWith({ arrival: { kind: 'none' } });
    expect(pose(cold.container)).toBe('peek');
    await cold.unmount();

    const confirm = await screenWith();
    expect(pose(confirm.container)).toBe('peek');
    expect(confirm.container.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(confirm.container.textContent).toContain('Pair this device');
    await confirm.unmount();
  });

  it('gets curious while the exchange is in flight, then cheers on success', async () => {
    let finish = (): void => {};
    const screen = await screenWith({
      onPair: async () =>
        await new Promise(resolve => {
          finish = () => resolve({ machine: 'studio', via: 'relay' });
        }),
    });
    await press(screen.container, 'Pair this device');
    expect(pose(screen.container)).toBe('curious');

    await interact(async () => {
      finish();
      await Promise.resolve();
    });
    expect(pose(screen.container)).toBe('cheer');
    expect(screen.container.querySelector('[data-sky][data-celebrating]')).not.toBeNull();
    expect(screen.container.querySelector('.fy-sky-streak')).not.toBeNull();
    await screen.unmount();
  });

  it('has no mascot when pairing failed, and the sky stays calm', async () => {
    const screen = await screenWith({
      onPair: async () => {
        throw new Error('Nothing reached that daemon.');
      },
    });
    await press(screen.container, 'Pair this device');
    expect(pose(screen.container)).toBeNull();
    expect(screen.container.querySelector('[data-sky]')).not.toBeNull();
    expect(screen.container.querySelector('[data-sky][data-celebrating]')).toBeNull();
    await screen.unmount();
  });

  it('is scenery: the mascot and the sky are hidden from assistive tech and nothing in them is focusable', async () => {
    const screen = await screenWith();
    expect(screen.container.querySelector('svg.fy-ferret')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.container.querySelector('[data-sky]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.container.querySelectorAll('[data-sky] button, [data-sky] a, [data-sky] [tabindex]')).toHaveLength(0);
    await screen.unmount();
  });

  it('draws neither the mascot nor the sky when embedded in a host that owns the page', async () => {
    const screen = await screenWith({ embedded: true });
    expect(screen.container.querySelector('svg.fy-ferret')).toBeNull();
    expect(screen.container.querySelector('[data-sky]')).toBeNull();
    await screen.unmount();
  });
});

describe('the success moment', () => {
  it('moves focus to the heading, keeps ONE live region for the whole arc and announces the arrival there', async () => {
    const screen = await screenWith();
    const region = must(screen.container.querySelector('[role="status"]'), 'the live region');
    expect(region.textContent).toBe('');

    await press(screen.container, 'Pair this device');

    expect(screen.container.querySelectorAll('[role="status"]')).toHaveLength(1);
    // The SAME element, now carrying words: a region mounted together with its text is often not announced.
    expect(screen.container.querySelector('[role="status"]')).toBe(region);
    expect(region.textContent).toBe('Connected. Paired with studio, through the relay.');
    const heading = must(screen.container.querySelector('#pairing-title'), 'the heading');
    expect(heading.textContent).toBe('Connected');
    expect(document.activeElement).toBe(heading);
    expect(screen.container.textContent).not.toContain('127.0.0.1');
    await screen.unmount();
  });

  it('leaves a slot under the message for a host that wants to offer one more thing', async () => {
    const without = await screenWith();
    await press(without.container, 'Pair this device');
    expect(without.container.querySelector('[data-after-paired]')).toBeNull();
    await without.unmount();

    const screen = await screenWith({
      afterPaired: (
        <button type="button" data-after-paired="">
          Add a passkey now
        </button>
      ),
    });
    expect(screen.container.querySelector('[data-after-paired]')).toBeNull();
    await press(screen.container, 'Pair this device');
    const slot = must(screen.container.querySelector('[data-after-paired]'), 'the slot');
    expect(slot.textContent).toBe('Add a passkey now');
    expect(slot.closest('main')?.querySelector('#pairing-title')).not.toBeNull();
    await screen.unmount();
  });
});

describe('the sky pauses when the tab is hidden', () => {
  const setVisibility = async (state: 'hidden' | 'visible'): Promise<void> => {
    await interact(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };

  it('marks the sky paused while hidden and running again when visible', async () => {
    const screen = await screenWith();
    const sky = must(screen.container.querySelector('[data-sky]'), 'the sky');
    expect(sky.hasAttribute('data-paused')).toBe(false);
    await setVisibility('hidden');
    expect(sky.hasAttribute('data-paused')).toBe(true);
    await setVisibility('visible');
    expect(sky.hasAttribute('data-paused')).toBe(false);
    await screen.unmount();
  });

  it('stays cheap: a dozen-odd twinkling stars and two idle shooting stars, no more', async () => {
    const screen = await screenWith();
    const stars = screen.container.querySelectorAll('.fy-sky-star').length;
    expect(stars).toBeGreaterThan(8);
    expect(stars).toBeLessThan(20);
    expect(screen.container.querySelectorAll('.fy-sky-shooter')).toHaveLength(2);
    await screen.unmount();
  });
});

describe('the stylesheet respects reduced motion', () => {
  const css = readFileSync(new URL('../../../../app/styles.css', import.meta.url), 'utf8');
  const motionBlock = (() => {
    const start = css.indexOf('@media (prefers-reduced-motion: no-preference) {');
    const end = css.indexOf('@keyframes', start);
    return { start, end };
  })();

  it('declares every animation and transition inside the no-preference block', () => {
    expect(motionBlock.start).toBeGreaterThan(0);
    const outside = css.slice(0, motionBlock.start);
    const after = css.slice(motionBlock.end);
    // `@keyframes` bodies hold no `animation:`/`transition:` of their own; the still picture holds none either.
    expect(outside).not.toMatch(/\banimation(-[a-z-]+)?\s*:/u);
    expect(outside).not.toMatch(/\btransition\s*:/u);
    expect(after).not.toMatch(/\banimation(-[a-z-]+)?\s*:/u);
  });

  it("gates every rule in that block on the app's own Motion setting too", () => {
    const block = css.slice(motionBlock.start, motionBlock.end).replace(/\/\*[\s\S]*?\*\//gu, '');
    const selectors = [...block.matchAll(/^\s{2}([^\s@}][^{]*)\{/gmu)].flatMap(match => (match[1] ?? '').split(','));
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) expect(selector.trim()).toStartWith(":root:not([data-motion='reduced'])");
  });

  it('animates only transform and opacity', () => {
    for (const keyframes of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/gu)) {
      const properties = new Set([...(keyframes[2] ?? '').matchAll(/^\s{4}([a-z-]+)\s*:/gmu)].map(match => match[1]));
      for (const property of properties) expect(['transform', 'opacity']).toContain(property ?? '');
    }
  });
});
