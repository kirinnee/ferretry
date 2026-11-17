import { describe, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';

/**
 * E9: at 390px the pill's own words are narrower than the pill while the held-replies notice shares the row, and the
 * pill clips what overflows it (`overflow: hidden`): the chevron at its far end went. The words must give way, so the
 * short form and the long form both clip themselves (`min-width: 0` + `overflow: hidden`) and the chevron never shrinks.
 */
const css = readFileSync(join(import.meta.dir, '../../../app/features/agenda/agenda-chat.css'), 'utf8');
const rule = (selector: string): string => {
  const start = css.indexOf(`\n${selector} {`);
  should(start).be.above(-1);
  return css.slice(start, css.indexOf('}', start));
};

describe('agenda line pill with the held-replies notice beside it', () => {
  test('E9 should let the short and long words give way before the chevron is clipped', () => {
    for (const selector of ['.fy-agenda-line__short', '.fy-agenda-line__words']) {
      should(rule(selector)).match(/min-width:\s*0/u);
      should(rule(selector)).match(/overflow:\s*hidden/u);
    }
    should(rule('.fy-agenda-line__chevron')).match(/flex-shrink:\s*0/u);
  });

  test('E9 should keep "Agenda · 7" whole on a phone: the pill stops shrinking and the notice beside it wraps', () => {
    should(css).match(
      /@container \(max-width: 24rem\) \{[^@]*\.fy-agenda-line \.fy-agenda-line__main \{\s*flex-shrink:\s*0/u,
    );
  });
});
