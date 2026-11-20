import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOADING_DELAY_MS,
  LOADING_FADE_MS,
  LOADING_GATE_CLASS,
  loadingGateStyle,
} from '../../../src/ui/loading-gate.ts';

/** THE ONE THRESHOLD: the owner's 300 ms lives in `loading-gate.ts`, and the stylesheet's fallbacks say the same number. */
const css = readFileSync(join(import.meta.dir, '../../../src/ui/loading.css'), 'utf8');

describe('the loader threshold', () => {
  test('is 300 ms', () => {
    expect(LOADING_DELAY_MS).toBe(300);
  });

  test('the style carries the default threshold and any override', () => {
    const style = (delayMs?: number): Record<string, unknown> => ({ ...loadingGateStyle(delayMs) });
    expect(style()).toEqual({ '--loading-delay': '300ms', '--loading-fade': `${LOADING_FADE_MS}ms` });
    expect(style(120)['--loading-delay']).toBe('120ms');
  });

  test('every stylesheet fallback for --loading-delay is the same threshold', () => {
    const fallbacks = [...css.matchAll(/var\(--loading-delay,\s*(\d+)ms\)/g)].map(match => Number(match[1]));
    expect(fallbacks.length).toBeGreaterThan(3);
    expect(new Set(fallbacks)).toEqual(new Set([LOADING_DELAY_MS]));
  });

  test('the gate class is drawn by the stylesheet', () => {
    expect(css).toContain(`.${LOADING_GATE_CLASS} {`);
  });
});

describe('the minimum display time', () => {
  test('a ghost of a loader that was shown is drawn at once, over the gate and the reduced-motion restatement', () => {
    expect(css).toContain('.fy-loading-ghost');
    expect(css).toMatch(
      /\.fy-loading-ghost(\.fy-loading-ghost){4,}\s*{[^}]*animation: none !important;[^}]*opacity: 1 !important;/,
    );
  });
});
