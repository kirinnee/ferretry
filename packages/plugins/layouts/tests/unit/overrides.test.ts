import { describe, expect, test } from 'bun:test';
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, DEFAULT_THEME, LayoutSelectionSchema } from '../../contract/index.ts';
import { applyOverrides, resolveCurrent, setPaths } from '../../daemon/lib/overrides.ts';

describe('fy layout set: one change, checked whole', () => {
  test('nav.side right moves the sidebar and keeps every other key of the layout', () => {
    const result = setPaths(DEFAULT_LAYOUT, {}, [{ path: 'nav.side', value: 'right' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overrides).toEqual({ nav: { side: 'right' } });
    const laid = applyOverrides(DEFAULT_LAYOUT, result.overrides);
    expect(laid.ok && laid.layout.nav).toEqual({ ...DEFAULT_LAYOUT.nav, side: 'right' });
    expect(laid.ok && laid.layout.density).toBe('comfortable');
  });

  test('nav.items takes a comma list, in order, or an array', () => {
    const fromText = setPaths(DEFAULT_LAYOUT, {}, [{ path: 'nav.items', value: 'agenda, board' }]);
    const fromArray = setPaths(DEFAULT_LAYOUT, {}, [{ path: 'nav.items', value: ['agenda', 'board'] }]);
    expect(fromText.ok && fromText.overrides.nav?.items).toEqual(['agenda', 'board']);
    expect(fromArray.ok && fromArray.overrides.nav?.items).toEqual(['agenda', 'board']);
  });

  test('a slot name with a dot is one key: panels.ferret.side', () => {
    const result = setPaths(DEFAULT_LAYOUT, {}, [{ path: 'panels.ferret.side', value: 'queue' }]);
    expect(result.ok && result.overrides.panels).toEqual({ 'ferret.side': ['queue'] });
  });

  test('composer.tools and phone paths land where the layout keeps them', () => {
    const result = setPaths(DEFAULT_LAYOUT, {}, [
      { path: 'composer.tools', value: 'mic' },
      { path: 'phone.nav.side', value: 'top' },
    ]);
    expect(result.ok && result.overrides).toEqual({ 'composer.tools': ['mic'], phone: { nav: { side: 'top' } } });
  });

  test('changes pile onto the overrides already made without touching them', () => {
    const before = { nav: { side: 'right' as const } };
    const result = setPaths(DEFAULT_LAYOUT, before, [{ path: 'density', value: 'compact' }]);
    expect(result.ok && result.overrides).toEqual({ nav: { side: 'right' }, density: 'compact' });
    expect(before).toEqual({ nav: { side: 'right' } });
  });

  test('a path that is not a layout setting is refused with the ones that are', () => {
    const result = setPaths(DEFAULT_LAYOUT, {}, [{ path: 'nav.colour', value: 'red' }]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]?.message).toContain('nav.side');
  });

  test('a word outside the allowed ones is refused, and nothing is half applied', () => {
    const result = setPaths(DEFAULT_LAYOUT, {}, [
      { path: 'density', value: 'compact' },
      { path: 'nav.side', value: 'diagonal' },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.some(issue => issue.path === 'nav.side')).toBe(true);
  });

  test('a view name that is not a name is refused; a name that is not installed is the app’s check', () => {
    expect(setPaths(DEFAULT_LAYOUT, {}, [{ path: 'top', value: 'Not A Name' }]).ok).toBe(false);
    expect(setPaths(DEFAULT_LAYOUT, {}, [{ path: 'top', value: 'search' }]).ok).toBe(true);
  });

  test('a list given to a one-word path, and a number given to a list, are refused', () => {
    expect(setPaths(DEFAULT_LAYOUT, {}, [{ path: 'nav.side', value: ['left'] }]).ok).toBe(false);
    expect(setPaths(DEFAULT_LAYOUT, {}, [{ path: 'top', value: 3 }]).ok).toBe(false);
  });
});

describe('the current layout', () => {
  const layouts = new Map([
    [DEFAULT_LAYOUT.id, DEFAULT_LAYOUT],
    [COMPACT_LAYOUT.id, COMPACT_LAYOUT],
  ]);
  const themes = new Map([[DEFAULT_THEME.id, DEFAULT_THEME]]);
  const selection = (value: unknown) => LayoutSelectionSchema.parse(value);

  test('with nothing chosen it is the built-in default and theme', () => {
    expect(resolveCurrent(selection({}), layouts, themes)).toEqual({ layout: DEFAULT_LAYOUT, theme: DEFAULT_THEME });
  });

  test('the chosen layout wins, with the owner’s overrides over it', () => {
    const current = resolveCurrent(
      selection({ layout: 'compact', overrides: { nav: { side: 'right' } } }),
      layouts,
      themes,
    );
    expect(current.layout.id).toBe('compact');
    expect(current.layout.nav.side).toBe('right');
    expect(current.layout.density).toBe('compact');
  });

  test('a layout that is gone falls back to the default instead of breaking the app', () => {
    expect(resolveCurrent(selection({ layout: 'removed' }), layouts, themes).layout.id).toBe('default');
    expect(resolveCurrent(selection({ theme: 'removed' }), layouts, themes).theme.id).toBe('default');
  });

  test('overrides that no longer fit the layout are dropped, the layout itself stays', () => {
    const broken = {
      layout: 'compact',
      overrides: { nav: { items: Array.from({ length: 30 }, (_, i) => `item-${i}`) } },
    };
    // The schema bounds the list, so build the selection by hand the way a hand edit past the schema would arrive.
    const current = resolveCurrent(
      { ...selection({ layout: 'compact' }), overrides: broken.overrides as never },
      layouts,
      themes,
    );
    expect(current.layout).toEqual(COMPACT_LAYOUT);
  });
});
