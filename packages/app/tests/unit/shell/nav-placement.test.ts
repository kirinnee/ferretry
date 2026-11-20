import { describe, expect, test } from 'bun:test';
import { navPlacement } from '../../../src/shell/drawer-nav.tsx';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { DEFAULT_LAYOUT } from '../../../src/layout/layout.ts';
import { deviceLayoutSource } from '../../../src/shell/command-sources.ts';
import { memoryStore } from '../../../src/storage/records.ts';

describe('r11 S1: where the drawer draws its places', () => {
  test('docked at the foot by default; a list at the top for list and rail; none when a bottom bar has them', () => {
    expect(navPlacement({ side: 'left', style: 'dock' })).toBe('dock');
    expect(navPlacement({ side: 'left', style: 'list' })).toBe('list');
    expect(navPlacement({ side: 'left', style: 'rail' })).toBe('list');
    expect(navPlacement({ side: 'bottom', style: 'dock' })).toBe('none');
  });
});

describe('r11 S1: the command bar sets the navigation form on this device', () => {
  const entries = (layouts: DeviceLayoutStore) => deviceLayoutSource(DEFAULT_LAYOUT, layouts)({} as never);

  test('one entry per form, each applying every key the form is, together', async () => {
    const layouts = new DeviceLayoutStore(memoryStore());
    const all = await entries(layouts);
    const ids = all.map(entry => entry.id).filter(id => id.startsWith('layout-nav-'));
    expect(ids).toEqual(['layout-nav-dock-icons', 'layout-nav-dock-words', 'layout-nav-list', 'layout-nav-bottom']);
    await all.find(entry => entry.id === 'layout-nav-dock-words')?.run();
    expect(layouts.snapshot()).toEqual({ nav: { side: 'left', style: 'dock', labels: 'words' } });
    await all.find(entry => entry.id === 'layout-nav-bottom')?.run();
    expect(layouts.snapshot()).toMatchObject({ nav: { side: 'bottom' } });
  });
});
