/**
 * THE APPEARANCE PAGE'S ORDER AND GROUPS (C59 O6): three groups in the order a person decides them, Style, then Colour (the
 * palette and light/dark together), then Size and motion (text size and motion together), and a live sample that stands for
 * the motion pick (`data-moving`) under BOTH switches the screen may not move for. The sample's size and sweep are measured in a
 * real browser in `appearance-step.visual.test.ts`; here the structure and the one motion answer are pinned.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { type DeviceTheme, PALETTES, STYLES } from '@ferretry/app';
import { AppearanceChoices } from '../../../app/features/setup-flow/appearance-page.tsx';

ensureDom();

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  delete document.documentElement.dataset.motion;
});

const calls: string[] = [];
const theme = {
  preference: { style: 'studio', palette: 'studio', keepPalette: false, mode: 'system', textScale: 'default' },
  resolved: 'light',
  styles: STYLES,
  palettes: PALETTES,
  setStyle: (id: string) => calls.push(`style:${id}`),
  setPalette: (id: string) => calls.push(`palette:${id}`),
  setMode: (id: string) => calls.push(`mode:${id}`),
  setKeepPalette: () => undefined,
  setTextScale: (id: string) => calls.push(`text:${id}`),
} as unknown as DeviceTheme;

const mountPage = async (motion: 'system' | 'reduced' = 'system') =>
  await mount(
    <AppearanceChoices theme={theme} motion={motion} setMotion={id => calls.push(`motion:${id}`)} step={undefined} />,
  );

const labels = (root: Element): string[] =>
  [...root.querySelectorAll('[role="radiogroup"]')].map(group => group.getAttribute('aria-label') ?? '');

describe('the Appearance page order', () => {
  it('has three groups: Style, then Colour, then Size and motion', async () => {
    view = await mountPage();
    const page = must(view.container.querySelector('[data-appearance-step]'), 'the page');
    const groups = [...page.querySelectorAll('[data-appearance-group]')];
    expect(groups.map(group => group.getAttribute('data-appearance-group'))).toEqual(['style', 'colour', 'comfort']);
    expect(groups.map(group => group.querySelector('h2')?.textContent)).toEqual(['Style', 'Colour', 'Size and motion']);
  });

  it('puts the palette and light/dark together in Colour, and text size and motion together in Size and motion', async () => {
    view = await mountPage();
    const [style, colour, comfort] = [...view.container.querySelectorAll('[data-appearance-group]')] as [
      Element,
      Element,
      Element,
    ];
    expect(labels(style)).toEqual(['Style']);
    expect(labels(colour)).toEqual(['Palette', 'Light or dark']);
    expect(labels(comfort)).toEqual(['Text size', 'Motion']);
    // The whole page reads in that order, top to bottom.
    expect(labels(view.container)).toEqual(['Style', 'Palette', 'Light or dark', 'Text size', 'Motion']);
  });

  it('offers every palette in the catalogue by the name the one map gives it, and every style', async () => {
    view = await mountPage();
    const names = (label: string): string[] =>
      [...must(view?.container.querySelector(`[aria-label="${label}"]`), label).querySelectorAll('.fy-cc__title')].map(
        title => title.textContent ?? '',
      );
    expect(names('Palette')).toEqual(PALETTES.map(palette => palette.label));
    expect(names('Style')).toEqual(STYLES.map(style => style.label));
  });

  it('a pick reaches the device store through its own setter', async () => {
    view = await mountPage();
    calls.length = 0;
    for (const [label, choice] of [
      ['Style', 'neo'],
      ['Palette', 'aurora'],
      ['Light or dark', 'dark'],
      ['Text size', 'larger'],
      ['Motion', 'reduced'],
    ] as const) {
      const card = must(
        view.container.querySelector(`[aria-label="${label}"] [data-choice="${choice}"]`),
        `${label} ${choice}`,
      );
      await interact(() => (card as HTMLElement).click());
    }
    expect(calls).toEqual(['style:neo', 'palette:aurora', 'mode:dark', 'text:larger', 'motion:reduced']);
  });
});

describe('the live sample shows size and motion too', () => {
  it('carries real words on its button and input (so a text size reads on them) and a motion strip with a busy mark', async () => {
    view = await mountPage();
    const demo = document.querySelector('[data-appearance-demo]');
    const root = demo ?? view.container;
    expect(root.querySelector('.fy-ad__button')?.textContent).toBe('Send');
    expect(root.querySelector('.fy-ad__input')?.textContent).toBe('Message');
    expect(root.querySelector('[data-appearance-demo-motion] svg[data-spinner]')).not.toBeNull();
    expect(root.querySelector('[data-appearance-demo-motion] .fy-ad__run i')).not.toBeNull();
  });

  it('moves while the screen may move, and stands still under the motion pick', async () => {
    view = await mountPage();
    const moving = () => document.querySelector('[data-appearance-demo]')?.getAttribute('data-moving');
    expect(moving()).toBe('true');
    // The pick is written on the root as the shell does; the sample follows it live.
    await interact(() => {
      document.documentElement.dataset.motion = 'reduced';
    });
    await interact(async () => await new Promise(done => setTimeout(done, 20)));
    expect(moving()).toBe('false');
  });
});
