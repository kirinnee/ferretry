/**
 * The Appearance theme tiles in a real DOM: choosing a family by keyboard must leave the chosen tile visible
 * inside Settings' own scroller, the way the old full-width theme list did (`ThemeSettings`).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { AppearanceGroups } from '../../../../src/features/settings/appearance-groups.tsx';
import { useDensity } from '../../../../src/hooks/use-density.ts';
import { type ThemeState, useTheme } from '../../../../src/hooks/use-theme.ts';
import { DaemonControlsStore } from '../../../../src/lib/controls.ts';
import { type ThemePreferenceStorage, ThemePreferenceStore } from '../../../../src/lib/theme-preferences.ts';
import { interact, mount, must, pressKey } from '../../../support/dom.ts';

const memory = (): ThemePreferenceStorage => {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

afterEach(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

const Harness = ({
  controls,
  store,
}: {
  readonly controls: DaemonControlsStore;
  readonly store: ThemePreferenceStore;
}) => {
  const theme: ThemeState = useTheme(store);
  const densityState = useDensity(controls);
  return (
    <div data-settings-scroller="">
      <ul>
        <AppearanceGroups
          theme={theme}
          densityState={densityState}
          device={controls.snapshot().device}
          computerAvailable={false}
          controls={controls}
        />
      </ul>
    </div>
  );
};

describe('the Appearance theme tiles', () => {
  it('reveal the tile a key selected inside the Settings scroller, and leave the shell alone', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    const controls = new DaemonControlsStore({ getItem: () => null, setItem: () => undefined });
    const view = await mount(<Harness controls={controls} store={new ThemePreferenceStore(memory())} />);
    const tiles = must(document.querySelector<HTMLElement>('[data-theme-tiles]'), 'the theme tiles');
    const scroller = must(document.querySelector<HTMLElement>('[data-settings-scroller]'), 'the Settings scroller');
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;
    // Every tile sits below the visible part of the scroller, and scrolling moves it up the way a browser does.
    for (const card of document.querySelectorAll<HTMLElement>('[data-family-card]'))
      card.getBoundingClientRect = () =>
        ({ top: 500 - scroller.scrollTop, bottom: 560 - scroller.scrollTop }) as DOMRect;
    const checked = (): string | undefined =>
      [...tiles.querySelectorAll<HTMLInputElement>('input[data-family]')].find(input => input.checked)?.dataset.family;

    await interact(() => pressKey(tiles, 'End'));

    expect(checked()).not.toBe('studio');
    // The card overhangs the scroller's bottom edge by 360px, so the scroller moves by exactly that, and the recheck after the font change moves nothing more.
    expect(scroller.scrollTop).toBe(360);
    expect(document.activeElement).toBe(tiles.querySelector(`input[data-family="${checked()}"]`));
    await view.unmount();
  });
});
