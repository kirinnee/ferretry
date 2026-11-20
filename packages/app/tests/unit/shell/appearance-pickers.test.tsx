/**
 * The Look pickers and the specimen, on their own: the palette chips are one radio group the arrow keys walk, every
 * preview wears the look it advertises, and the specimen draws the look it is told to (scoped) or the page's (default).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { lookAttributes, PalettePicker, StylePicker } from '../../../src/shell/appearance-pickers.tsx';
import { AppearanceSpecimen } from '../../../src/shell/appearance-specimen.tsx';
import { PALETTES, type PaletteId, STYLES, type StyleId } from '../../../src/theme/catalog.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  if (typeof document !== 'undefined') delete document.documentElement.dataset.motion;
});

const key = (name: string) => (target: Element | null) =>
  interact(() => void target?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));

describe('lookAttributes', () => {
  it('should name all three axes and mark the element as a scoped preview', () => {
    expect(lookAttributes({ style: 'neo', palette: 'hacker', mode: 'dark' })).toEqual({
      'data-swatch': 'hacker-dark',
      'data-style': 'neo',
      'data-palette': 'hacker',
      'data-mode': 'dark',
    });
  });
});

function Palettes({ log }: { readonly log: PaletteId[] }) {
  const [value, setValue] = useState<PaletteId>('studio');
  return (
    <PalettePicker
      palettes={PALETTES}
      value={value}
      style="neo"
      onChange={next => {
        log.push(next);
        setValue(next);
      }}
    />
  );
}

describe('PalettePicker', () => {
  it('should be one radiogroup with one tab stop, and the arrow keys, Home and End move AND select', async () => {
    const log: PaletteId[] = [];
    mounted = await mount(<Palettes log={log} />);
    const group = must(mounted.container.querySelector('[role="radiogroup"][aria-label="Palette"]'), 'the group');
    const stops = [...group.querySelectorAll('input')].filter(input => input.tabIndex >= 0);
    expect(stops.map(input => input.value)).toEqual(['studio']);
    await key('ArrowRight')(group);
    await key('ArrowDown')(group);
    await key('ArrowLeft')(group);
    await key('End')(group);
    await key('Home')(group);
    await key('x')(group);
    expect(log).toEqual(['geist', 'mission', 'geist', PALETTES[PALETTES.length - 1]?.id as PaletteId, 'studio']);
  });

  it('should bring the VISIBLE chip into view after a keyboard move, not only focus its hidden radio', async () => {
    mounted = await mount(<Palettes log={[]} />);
    const revealed: (string | null)[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, arg?: boolean | ScrollIntoViewOptions) {
      revealed.push(`${this.getAttribute('data-palette-chip')}:${typeof arg === 'object' ? arg.block : ''}`);
    };
    try {
      const group = must(mounted.container.querySelector('[role="radiogroup"][aria-label="Palette"]'), 'the group');
      await key('End')(group);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
    expect(revealed[0]).toBe(`${PALETTES[PALETTES.length - 1]?.id}:nearest`);
  });

  it('should draw each half of each chip in the style it was given', async () => {
    mounted = await mount(<Palettes log={[]} />);
    const halves = [...mounted.container.querySelectorAll('[data-palette-chip] [data-swatch]')];
    expect(halves).toHaveLength(PALETTES.length * 2);
    expect(new Set(halves.map(half => half.getAttribute('data-style')))).toEqual(new Set(['neo']));
  });
});

describe('StylePicker', () => {
  it('should draw each card in its own style and report a pick', async () => {
    const picks: StyleId[] = [];
    mounted = await mount(
      <StylePicker
        styles={STYLES}
        value="studio"
        palette="vintage"
        mode="dark"
        onChange={style => picks.push(style)}
      />,
    );
    const scenes = [...mounted.container.querySelectorAll('[data-swatch]')];
    expect(scenes.map(scene => scene.getAttribute('data-style'))).toEqual(STYLES.map(style => style.id));
    expect(
      new Set(scenes.map(scene => `${scene.getAttribute('data-palette')}/${scene.getAttribute('data-mode')}`)),
    ).toEqual(new Set(['vintage/dark']));
    await interact(() => mounted?.container.querySelector<HTMLInputElement>('[data-choice="geist"] input')?.click());
    expect(picks).toEqual(['geist']);
  });
});

describe('AppearanceSpecimen', () => {
  const look = { style: 'mission', palette: 'hacker', mode: 'dark' } as const;

  it('should wear the look only when scoped', async () => {
    mounted = await mount(<AppearanceSpecimen look={look} />);
    expect(must(mounted.container.querySelector('[data-specimen]'), 'it').hasAttribute('data-swatch')).toBe(false);
    await mounted.render(<AppearanceSpecimen look={look} scoped />);
    const scoped = must(mounted.container.querySelector('[data-specimen]'), 'it');
    expect(scoped.getAttribute('data-style')).toBe('mission');
    expect(scoped.getAttribute('data-palette')).toBe('hacker');
    expect(scoped.getAttribute('data-mode')).toBe('dark');
  });

  it('should replay once per change of look, never on mount', async () => {
    mounted = await mount(<AppearanceSpecimen look={look} />);
    const read = () => mounted?.container.querySelector('[data-specimen]')?.getAttribute('data-spec-replays');
    expect(read()).toBe('0');
    expect(mounted.container.querySelector('[data-spec-play]')).toBeNull();
    await mounted.render(<AppearanceSpecimen look={{ ...look, palette: 'vintage' }} />);
    expect(read()).toBe('1');
    expect(mounted.container.querySelectorAll('[data-spec-play]').length).toBeGreaterThan(0);
    await mounted.render(<AppearanceSpecimen look={{ ...look, palette: 'vintage' }} />);
    expect(read()).toBe('1');
  });

  it('should replay when only the colour-mode CHOICE changes (Auto -> Light while the system is light)', async () => {
    mounted = await mount(<AppearanceSpecimen look={{ ...look, modePreference: 'system' }} />);
    await mounted.render(<AppearanceSpecimen look={{ ...look, modePreference: 'light' }} />);
    expect(mounted.container.querySelector('[data-specimen]')?.getAttribute('data-spec-replays')).toBe('1');
  });

  it('should hold still with motion reduced', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<AppearanceSpecimen look={look} />);
    await mounted.render(<AppearanceSpecimen look={{ ...look, style: 'neo' }} />);
    expect(mounted.container.querySelector('[data-specimen]')?.getAttribute('data-spec-replays')).toBe('0');
  });
});
