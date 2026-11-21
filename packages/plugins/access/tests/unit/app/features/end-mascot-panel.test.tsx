/**
 * r11-1b G1: the `end-mascot` panel Access places in Onboarding's `onboarding.end` slot (the picture on "You're set up") is the
 * REAL cheering ferret, the same component the Connected screen draws (whose hover and tap are asserted in
 * `mascot-offer.visual.test.ts`), not an icon; the manifest places it in that slot, and the app half has a view for it.
 */
import { describe, expect, it } from 'bun:test';
import { EndMascotPanel } from '../../../../app/features/onboarding/end-mascot-panel.tsx';
import manifest from '../../../../manifest.ts';
import { mount, must } from '../../../support/app/dom.ts';

describe('the end-mascot panel', () => {
  it('draws the cheering ferret, decorative', async () => {
    const screen = await mount(<EndMascotPanel />);
    try {
      const ferret = must(screen.container.querySelector('svg.fy-ferret'), 'the ferret drawing');
      expect(ferret.getAttribute('data-pose')).toBe('cheer');
      expect(ferret.getAttribute('aria-hidden')).toBe('true');
      expect(screen.container.querySelector('[data-mascot-wave]'), 'it has the arm that waves').not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('is placed in the onboarding.end slot by the manifest', () => {
    const placed = (manifest.ui?.panels ?? []).filter(panel => panel.slot === 'onboarding.end');
    expect(placed.map(panel => panel.id)).toEqual(['end-mascot']);
  });
});
