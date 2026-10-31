import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, '../../../src/features/agenda/agenda-item-card.css'), 'utf8');

const rule = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

describe('a picture or chart in the card', () => {
  test('is capped at its natural size, never stretched to the card, and a sized diagram is left alone', () => {
    const start = css.indexOf('.fy-card .fy-render :is(');
    expect(start).toBeGreaterThanOrEqual(0);
    const capped = css.slice(start, css.indexOf('}', start));
    expect(capped).toContain('.fy-render-image:not([data-fy-render-sized=');
    expect(capped).toContain('.fy-render-chart');
    expect(capped).toContain('max-width: min(100%, 480px)');
  });
});

describe('the premise and context blocks on the agenda card', () => {
  test('stack the label above its text instead of a label column beside it', () => {
    const row = rule('.fy-card__sit-row');
    expect(row).toContain('flex-direction: column');
    expect(row).not.toContain('grid-template-columns');
  });

  test('are separate rounded blocks with a gap, not one grey panel', () => {
    expect(rule('.fy-card__situation')).toContain('gap:');
    expect(rule('.fy-card__sit-row')).toContain('border-radius');
    expect(rule('.fy-card__sit-row')).toContain('background: var(--fy-sit-bg)');
  });

  test('tint premise and context apart, from the theme tokens, with the label in the stronger shade', () => {
    const premise = rule(".fy-card__sit-row[data-agenda-section='premise']");
    const context = rule(".fy-card__sit-row[data-agenda-section='context']");
    expect(premise).toContain('--fy-sit-bg: var(--accent-soft)');
    expect(premise).toContain('--fy-sit-ink: var(--accent-strong)');
    expect(context).toContain('--fy-sit-bg: var(--warn-bg)');
    expect(context).toContain('--fy-sit-ink: var(--warn)');
    expect(rule('.fy-card .fy-card__sit-label')).toContain('color: var(--fy-sit-ink)');
  });

  test('draw no left accent bar', () => {
    const block = css.slice(css.indexOf('.fy-card__situation {'), css.indexOf('.fy-card .fy-card__points {'));
    expect(block).not.toMatch(/border-left|box-shadow:\s*inset/u);
  });
});
