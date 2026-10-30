/**
 * The context ring: how a share of the window becomes a tone, a fill and the words behind them, and what
 * the ring does when tapped or while the harness compacts.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { ContextRing } from '../../src/components/context-ring.tsx';
import { contextReadout } from '../../src/lib/context-ring.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const AT = '2026-10-30T08:00:00.000Z';
const context = (usedTokens: number, windowTokens: number, percent: number) => ({
  usedTokens,
  windowTokens,
  percent,
  at: AT,
});

describe('contextReadout', () => {
  it.each([
    { used: 118_000, window: 1_000_000, percent: 11.8, tone: 'ok', text: '118k of 1M tokens (12%)' },
    { used: 140_000, window: 200_000, percent: 70, tone: 'warn', text: '140k of 200k tokens (70%)' },
    { used: 188_800, window: 200_000, percent: 89.4, tone: 'warn', text: '188k of 200k tokens (89%)' },
    { used: 190_000, window: 200_000, percent: 90, tone: 'err', text: '190k of 200k tokens (90%)' },
    { used: 950, window: 272_000, percent: 0.3, tone: 'ok', text: '950 of 272k tokens (0%)' },
  ])('should read $text as $tone', ({ used, window, percent, tone, text }) => {
    expect(contextReadout(context(used, window, percent))).toEqual({ tone, fill: percent, text });
  });

  it('should keep the fill inside the ring', () => {
    expect(contextReadout(context(1, 1, 130)).fill).toBe(100);
    expect(contextReadout(context(1, 1, -4)).fill).toBe(0);
  });
});

describe('ContextRing', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  const ringOf = (container: HTMLElement) => must(container.querySelector('[data-context-ring]'), 'the ring');
  const fillOf = (container: HTMLElement) => must(container.querySelector('.fy-context-ring__fill'), 'the arc');

  it('should be a labelled image with the tone and the words, and no button, when nothing opens', async () => {
    mounted = await mount(<ContextRing context={context(118_000, 1_000_000, 11.8)} />);
    const ring = ringOf(mounted.container);
    expect(ring.tagName).toBe('SPAN');
    expect(ring.getAttribute('role')).toBe('img');
    expect(ring.getAttribute('aria-label')).toBe('118k of 1M tokens (12%)');
    expect(ring.getAttribute('title')).toBe('118k of 1M tokens (12%)');
    expect(ring.getAttribute('data-tone')).toBe('ok');
    expect(ring.hasAttribute('data-compacting')).toBe(false);
  });

  it('should fill the arc to the share used', async () => {
    mounted = await mount(<ContextRing context={context(100_000, 200_000, 50)} />);
    const [drawn, whole] = (fillOf(mounted.container).getAttribute('stroke-dasharray') ?? '').split(' ').map(Number);
    expect((drawn ?? 0) / (whole ?? 1)).toBeCloseTo(0.5, 5);
  });

  it('should carry the red tone from 90%', async () => {
    mounted = await mount(<ContextRing context={context(190_000, 200_000, 95)} />);
    expect(ringOf(mounted.container).getAttribute('data-tone')).toBe('err');
  });

  it('should be a button that opens, and say so, when the host gives it somewhere to go', async () => {
    const opened: string[] = [];
    mounted = await mount(<ContextRing context={context(150_000, 200_000, 75)} onOpen={() => opened.push('open')} />);
    const ring = ringOf(mounted.container);
    expect(ring.tagName).toBe('BUTTON');
    expect(ring.getAttribute('aria-label')).toBe('150k of 200k tokens (75%). Open usage');
    expect(ring.getAttribute('data-tone')).toBe('warn');
    await interact(() => (ring as HTMLButtonElement).click());
    expect(opened).toEqual(['open']);
  });

  it('should say it is compacting, and show a short arc, instead of a size about to be wrong', async () => {
    mounted = await mount(<ContextRing compacting context={context(190_000, 200_000, 95)} />);
    const ring = ringOf(mounted.container);
    expect(ring.getAttribute('title')).toBe('Compacting context…');
    expect(ring.hasAttribute('data-compacting')).toBe(true);
    const [drawn, whole] = (fillOf(mounted.container).getAttribute('stroke-dasharray') ?? '').split(' ').map(Number);
    expect((drawn ?? 0) / (whole ?? 1)).toBeCloseTo(0.25, 5);
  });
});
