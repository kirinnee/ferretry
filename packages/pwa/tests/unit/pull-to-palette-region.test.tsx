import { describe, expect, it } from 'bun:test';
import { PALETTE_PULL_THRESHOLD_PX, PULL_TO_PALETTE_ATTR } from '../../src/hooks/use-pull-to-palette.ts';
import { PullToPaletteRegion } from '../../src/shell/pull-to-palette-region.tsx';
import { interact, mount, must } from '../support/dom.ts';

const touch = (type: string, y: number, count = 1): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({ clientY: y })) });
  return event;
};

describe('PullToPaletteRegion', () => {
  it('shows release feedback and opens from an opted-in top scroller', async () => {
    let opened = 0;
    const view = await mount(
      <PullToPaletteRegion className="relative" enabled onOpen={() => opened++}>
        <div {...{ [PULL_TO_PALETTE_ATTR]: '' }} data-scroller="" />
      </PullToPaletteRegion>,
    );
    const scroller = must(view.container.querySelector<HTMLElement>('[data-scroller]'), 'pull scroller');
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 });

    await interact(() => scroller.dispatchEvent(touch('touchstart', 100)));
    await interact(() => scroller.dispatchEvent(touch('touchmove', 100 + PALETTE_PULL_THRESHOLD_PX)));

    const indicator = must(
      view.container.querySelector<HTMLElement>('[data-pull-to-palette-indicator]'),
      'pull indicator',
    );
    expect(indicator.dataset.pullToPaletteIndicator).toBe('armed');
    expect(indicator.textContent).toContain('Release to find');
    expect(indicator.style.opacity).toBe('1');
    expect(indicator.getAttribute('role')).toBe('status');
    expect(indicator.getAttribute('aria-live')).toBe('polite');
    expect(indicator.getAttribute('aria-hidden')).toBe('false');

    await interact(() => scroller.dispatchEvent(touch('touchend', 0, 0)));
    expect(opened).toBe(1);
    expect(indicator.style.opacity).toBe('0');
    expect(indicator.getAttribute('aria-hidden')).toBe('true');
    await view.unmount();
  });

  it('stays inert when touch navigation is disabled', async () => {
    let opened = 0;
    const view = await mount(
      <PullToPaletteRegion className="relative" enabled={false} onOpen={() => opened++}>
        <div {...{ [PULL_TO_PALETTE_ATTR]: '' }} data-scroller="" />
      </PullToPaletteRegion>,
    );
    const scroller = must(view.container.querySelector<HTMLElement>('[data-scroller]'), 'pull scroller');
    await interact(() => scroller.dispatchEvent(touch('touchstart', 0)));
    await interact(() => scroller.dispatchEvent(touch('touchmove', PALETTE_PULL_THRESHOLD_PX)));
    await interact(() => scroller.dispatchEvent(touch('touchend', 0, 0)));

    expect(opened).toBe(0);
    expect(view.container.querySelector<HTMLElement>('[data-pull-to-palette-indicator]')?.style.opacity).toBe('0');
    await view.unmount();
  });
});
