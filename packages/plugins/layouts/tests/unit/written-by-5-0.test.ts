/**
 * Files a 5.0 build itself wrote under `config/`, as the exact old value: the reads that keep them must not be removed
 * by accident. Each fixture is synthetic and names the commit that wrote it.
 *
 * - `0bfbb8cd6a` made a custom theme require `base` (a family id), and accepted the old axis ids on `style` / `palette`.
 * - `0bfbb8cd6a` let `fy layout set` store `right` / `top` / `bar`, and `fy layout save` copied them into a named layout.
 */
import { describe, expect, test } from 'bun:test';
import { LayoutSchema, NavSideSchema, ThemeSchema } from '../../contract/index.ts';
import { normalizeNav } from '../../daemon/lib/overrides.ts';

const tokens = { light: { accent: '#336699' }, dark: {} };

describe('a custom theme item a 5.0 build wrote', () => {
  test('`base` is accepted (and not applied); the valid tokens beside it are kept', () => {
    const item = ThemeSchema.parse({ id: 'dusk', label: 'Dusk', base: 'mission', ...tokens });
    expect(item.light).toEqual({ accent: '#336699' });
  });

  test('a retired palette id reads as the palette it became', () => {
    expect(
      ThemeSchema.parse({ id: 'dusk', label: 'Dusk', base: 'blueprint', palette: 'blueprint', ...tokens }),
    ).toMatchObject({
      palette: 'mission',
    });
  });

  test('the retired contrast style reads as Studio in the High contrast palette', () => {
    expect(ThemeSchema.parse({ id: 'dusk', label: 'Dusk', style: 'contrast', ...tokens })).toMatchObject({
      style: 'studio',
      palette: 'contrast',
    });
  });
});

describe('a layout a 5.0 build wrote with the old nav words', () => {
  test('right, top and bar are accepted', () => {
    expect(NavSideSchema.options).toEqual(expect.arrayContaining(['left', 'right', 'top', 'bottom']));
    const layout = LayoutSchema.parse({ id: 'old', nav: { side: 'top', style: 'bar', items: ['agenda'] } });
    expect(layout.nav).toMatchObject({ side: 'top', style: 'bar' });
  });

  test('saving a copy writes the words the shell draws', () => {
    const copy = normalizeNav(
      LayoutSchema.parse({ id: 'old', nav: { side: 'right', style: 'bar', items: ['agenda'] } }),
    );
    expect(copy.nav).toMatchObject({ side: 'left', style: 'dock' });
  });
});
