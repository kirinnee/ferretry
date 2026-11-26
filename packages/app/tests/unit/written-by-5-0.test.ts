/**
 * Records a 5.0 build itself wrote to this browser, as the exact old value: the reads that keep them must not be
 * removed by accident. Each fixture is synthetic and names the commit that wrote it.
 *
 * - `9ea2a4b14c` stored the theme as `{ family, mode, textScale }`, and `457c300f58` retired palette ids and made
 *   `contrast` a palette: both readers map on read and never rewrite.
 * - `0bfbb8cd6a` let `fy layout set` store `right` / `top` / `bar`; a device record can hold them.
 * - `2ba271d947` (E60) shipped `/d/<daemon>/inbox` as the Agenda's address.
 */
import { describe, expect, test } from 'bun:test';
import { DeviceLayoutStore, storedOverrides } from '../../src/layout/device-layout.ts';
import { DEFAULT_LAYOUT, resolveLayout } from '../../src/layout/layout.ts';
import type { ScreenRef } from '../../src/layout/engine.ts';
import { routeTable } from '../../src/router/routes.ts';
import { APP_STORAGE } from '../../src/storage/names.ts';
import { memoryStore } from '../../src/storage/records.ts';
import { THEME_PREFERENCES_KEY, ThemePreferenceStore } from '../../src/theme/preferences.ts';

const themeOf = (value: unknown) =>
  new ThemePreferenceStore(memoryStore({ [THEME_PREFERENCES_KEY]: JSON.stringify({ format: 1, value }) })).snapshot();

describe('a theme record a 5.0 build wrote', () => {
  test('a family-only record (before 9ea2a4b14c) reads as that family’s style and palette', () => {
    expect(themeOf({ family: 'mission', mode: 'dark', textScale: 'default' })).toMatchObject({
      style: 'mission',
      palette: 'mission',
      mode: 'dark',
    });
  });

  test('a retired palette id (before 457c300f58) reads as the palette it became', () => {
    expect(themeOf({ style: 'studio', palette: 'blueprint', mode: 'light', textScale: 'default' })).toMatchObject({
      style: 'studio',
      palette: 'mission',
    });
    expect(themeOf({ family: 'phosphor', mode: 'dark', textScale: 'default' })).toMatchObject({ palette: 'hacker' });
  });

  test('the retired contrast style keeps High contrast, as a palette on Studio', () => {
    expect(themeOf({ style: 'contrast', palette: 'neo', mode: 'dark', textScale: 'default' })).toMatchObject({
      style: 'studio',
      palette: 'contrast',
    });
  });
});

describe('a device layout record a 5.0 build wrote', () => {
  test('a stamped record that names right / top / bar is kept and draws the side bar with its places docked', () => {
    const storage = memoryStore({
      [APP_STORAGE.layout]: JSON.stringify({
        format: 1,
        value: storedOverrides({ nav: { side: 'top', style: 'bar' } }),
      }),
    });
    const overrides = new DeviceLayoutStore(storage).snapshot();
    expect(overrides).toEqual({ nav: { side: 'top', style: 'bar' } });
    expect(
      resolveLayout({ ...DEFAULT_LAYOUT, ...{ nav: { ...DEFAULT_LAYOUT.nav, ...overrides.nav } } }, 'wide').nav,
    ).toMatchObject({
      side: 'left',
      style: 'dock',
    });
    const right = new DeviceLayoutStore(
      memoryStore({
        [APP_STORAGE.layout]: JSON.stringify({ format: 1, value: storedOverrides({ nav: { side: 'right' } }) }),
      }),
    );
    expect(right.snapshot()).toEqual({ nav: { side: 'right' } });
  });
});

describe('the Inbox address E60 shipped', () => {
  const agenda: ScreenRef = { plugin: 'agenda', id: 'agenda', path: 'agenda', label: 'Agenda' };

  test('/d/<daemon>/inbox opens the Agenda', () => {
    expect(routeTable([agenda]).parse('/d/d1/inbox')).toEqual({
      kind: 'screen',
      daemon: 'd1',
      screen: agenda,
      params: {},
    });
  });
});
