import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deviceControls } from '../../../src/compose/device-controls.ts';
import { PALETTES, STYLES } from '../../../src/theme/catalog.ts';
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

  test('Style is one card per style, each drawn in its own style and the palette in force', async () => {
    await boot();
    const cards = [...page().querySelectorAll('[role="radiogroup"][aria-label="Style"] [data-choice]')];
    expect(cards.map(card => card.getAttribute('data-choice'))).toEqual(STYLES.map(style => style.id));
    for (const card of cards) {
      const id = card.getAttribute('data-choice');
      const scene = card.querySelector('[data-swatch]');
      expect(scene?.getAttribute('data-style')).toBe(id);
      expect(scene?.getAttribute('data-palette')).toBe(document.documentElement.dataset.palette ?? 'studio');
    }
  });

  test('Palette is one chip per palette, each holding its light and its dark half in the style in force', async () => {
    await boot();
    const chips = [...page().querySelectorAll('[data-palette-chips] [data-palette-chip]')];
    expect(chips.map(chip => chip.getAttribute('data-palette-chip'))).toEqual(PALETTES.map(palette => palette.id));
    for (const chip of chips) {
      const id = chip.getAttribute('data-palette-chip');
      const halves = [...chip.querySelectorAll('[data-swatch]')];
      expect(halves.map(half => half.getAttribute('data-mode'))).toEqual(['light', 'dark']);
      expect(halves.map(half => half.getAttribute('data-palette'))).toEqual([id, id]);
      expect(halves.map(half => half.getAttribute('data-style'))).toEqual(['studio', 'studio']);
    }
  });

  test('picking a style brings its default palette, and picking a palette changes only the palette', async () => {
    await boot();
    const root = document.documentElement;
    const geist = page().querySelector<HTMLInputElement>('[data-choice="geist"] input');
    await interact(() => geist?.click());
    await settle();
    expect(geist?.checked).toBe(true);
    expect(root.dataset.style).toBe('geist');
    expect(root.dataset.palette).toBe('geist');
    const hacker = page().querySelector<HTMLInputElement>('[data-palette-chip="hacker"] input');
    await interact(() => hacker?.click());
    await settle();
    expect(hacker?.checked).toBe(true);
    expect(root.dataset.palette).toBe('hacker');
    expect(root.dataset.style).toBe('geist');
    // The chips now show their palettes in the style that is in force.
    const half = page().querySelector('[data-palette-chip="neo"] [data-swatch]');
    expect(half?.getAttribute('data-style')).toBe('geist');
  });

  test('one specimen shows every detail of the look, and it follows a pick', async () => {
    await boot();
    const specimens = page().querySelectorAll('[data-specimen]');
    expect(specimens).toHaveLength(1);
    const sections = [...(specimens[0]?.querySelectorAll('[data-spec-section]') ?? [])].map(node =>
      node.getAttribute('data-spec-section'),
    );
    expect(sections).toEqual(['Type', 'Buttons', 'Input', 'Panel', 'Shape', 'Spacing', 'Select', 'Rows']);
    const states = [...(specimens[0]?.querySelectorAll('.kt-btn[data-spec-state]') ?? [])].map(node =>
      node.getAttribute('data-spec-state'),
    );
    expect(states).toEqual(['rest', 'hover', 'press']);
    expect(specimens[0]?.querySelector('.kt-input[data-spec-state="focus"]')).not.toBeNull();
    expect(specimens[0]?.getAttribute('data-spec-replays')).toBe('0');
    await interact(() => page().querySelector<HTMLInputElement>('[data-choice="neo"] input')?.click());
    await settle();
    expect(page().querySelector('[data-specimen]')?.getAttribute('data-spec-style')).toBe('neo');
    expect(page().querySelector('[data-specimen]')?.getAttribute('data-spec-replays')).toBe('1');
  });

  test('with motion reduced the specimen never replays', async () => {
    await boot();
    await interact(() =>
      page()
        .querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="Motion"] input[value="reduced"]')
        ?.click(),
    );
    await settle();
    await interact(() => page().querySelector<HTMLInputElement>('[data-choice="neo"] input')?.click());
    await settle();
    expect(page().querySelector('[data-specimen]')?.getAttribute('data-spec-replays')).toBe('0');
    expect(page().querySelector('[data-spec-play]')).toBeNull();
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

describe('Settings › This device › the layout line', () => {
  test('names the layout in use as a quiet line under the groups, not bare page text', async () => {
    await boot();
    const line = page().querySelector('[data-layout-in-use]');
    expect(line?.textContent).toContain('Layout in use: default');
  });
});
