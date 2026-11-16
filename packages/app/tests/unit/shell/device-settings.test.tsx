import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deviceControls } from '../../../src/compose/device-controls.ts';
import { THEME_FAMILIES } from '../../../src/theme/preferences.ts';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp, settle } from './frame-fixtures.tsx';

/**
 * SETTINGS › THIS DEVICE (v4 parity, triage row 45): a Motion control, the theme as a grid of tiles and human labels for
 * Mode and Text size — never the raw ids (`system`, `larger`).
 */
let view: Mounted | null = null;
beforeEach(() => {
  deviceControls().setDeviceControls({ motion: 'system' });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  delete document.documentElement.dataset.motion;
  deviceControls().setDeviceControls({ motion: 'system' });
});

const boot = async () => {
  const app = await bootApp({ surfaces: [], machines: [], path: '/settings' });
  view = app.view;
  return app;
};
const page = (): HTMLElement => view?.container as HTMLElement;
const radios = (name: string): string[] =>
  [...page().querySelectorAll(`[role="radiogroup"][aria-label="${name}"] label`)].map(label => label.textContent ?? '');

describe('Settings › This device', () => {
  test('Mode and Text size read as words people use, not raw ids', async () => {
    await boot();
    expect(radios('Colour mode')).toEqual(['Auto', 'Light', 'Dark']);
    expect(radios('Text size')).toEqual(['Default', 'Large', 'Larger']);
    expect(page().querySelector('select')).toBeNull();
  });

  test('Theme is a grid of tiles, one per family, each previewing its light and dark theme', async () => {
    await boot();
    const tiles = [...page().querySelectorAll('[data-theme-tiles] [data-family-card]')];
    expect(tiles.map(tile => tile.getAttribute('data-family-card'))).toEqual(THEME_FAMILIES.map(family => family.id));
    for (const tile of tiles) {
      const id = tile.getAttribute('data-family-card');
      expect([...tile.querySelectorAll('[data-swatch]')].map(swatch => swatch.getAttribute('data-swatch'))).toEqual([
        `${id}-light`,
        `${id}-dark`,
      ]);
    }
  });

  test('picking a tile changes the theme', async () => {
    await boot();
    const mission = page().querySelector<HTMLInputElement>('[data-family="mission"]');
    await interact(() => mission?.click());
    await settle();
    expect(mission?.checked).toBe(true);
    expect(document.documentElement.dataset.theme).toStartWith('mission-');
  });

  test('Motion offers Follow system / Reduced and Reduced stills the page', async () => {
    await boot();
    expect(radios('Motion')).toEqual(['Follow system', 'Reduced']);
    expect(document.documentElement.dataset.motion).toBeUndefined();
    await interact(() =>
      page()
        .querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="Motion"] input[value="reduced"]')
        ?.click(),
    );
    await settle();
    expect(deviceControls().snapshot().device.motion).toBe('reduced');
    expect(document.documentElement.dataset.motion).toBe('reduced');
    await interact(() =>
      page().querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="Motion"] input[value="system"]')?.click(),
    );
    await settle();
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });
});
