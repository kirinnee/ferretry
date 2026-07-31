import { describe, expect, it } from 'bun:test';
import { SIDE_PANE_TAB_ICONS, sidePaneTabIcon } from '../../src/components/side-pane-tab-icons.ts';
import { SIDE_PANE_BUILT_IN_TABS } from '../../src/components/side-pane-tab-model.ts';

describe('side-pane tab icons', () => {
  it('resolves a glyph for every icon name a built-in tab asks for', () => {
    for (const definition of SIDE_PANE_BUILT_IN_TABS) {
      expect(sidePaneTabIcon(definition.icon)).toBeDefined();
    }
  });

  it('resolves a glyph for the three instance kinds', () => {
    for (const name of ['file', 'browser', 'terminal'] as const) {
      expect(sidePaneTabIcon(name)).toBe(SIDE_PANE_TAB_ICONS[name]);
    }
  });

  it('gives each name a distinct glyph, so two tabs never look like one another', () => {
    const glyphs = Object.values(SIDE_PANE_TAB_ICONS);

    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});
