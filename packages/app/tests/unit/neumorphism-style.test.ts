/**
 * THE NEUMORPHISM CASCADE, read from the stylesheet: the two rules that decide how a pressed button and a raised card
 * look. The real pixels are measured by the theme matrix (`tests/integration/theme-matrix.visual.test.ts`, which reads a
 * raised card's edge against the page on every palette and mode); this pins the cascade facts behind them.
 */
import { describe, expect, it } from 'bun:test';
import { readStyleFile } from '../../src/testing/theme-css.ts';

const css = readStyleFile('style/neumorphism.css');
const rule = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  expect(at).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};

describe('neumorphism: a held button is pressed IN, not hovered', () => {
  it('lifts on hover only while the button is not pressed', () => {
    expect(rule("[data-swatch][data-style='neumorphism'] .kt-btn:hover:not(:disabled, :active)")).toContain(
      '--shadow-md',
    );
  });

  it('takes the inset shadow while pressed, at a specificity that outranks the hover lift', () => {
    expect(rule("[data-swatch][data-style='neumorphism'] .kt-btn:active:not(:disabled)")).toContain('--shadow-active');
  });
});

describe('neumorphism: a raised card keeps a real edge', () => {
  it('draws the card border from the palette ink, not the weak --border', () => {
    const body = rule("[data-swatch][data-style='neumorphism'] .kt-panel");
    expect(body).toContain('border-color');
    expect(body).toContain('var(--fg)');
    expect(body).not.toContain('var(--border)');
  });
});
