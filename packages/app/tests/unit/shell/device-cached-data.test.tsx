import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { interact, type Mounted, must } from '../../support/dom.ts';
import { bootApp, settle } from './frame-fixtures.tsx';

/**
 * SETTINGS › THIS DEVICE › CACHED DATA (S-0458, v4 `clear-cached-data.tsx`): clears this device's copy only, asks once
 * inline, and says when it is done. Today the copy is where each page was scrolled (`ScrollMemory`).
 */
let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const boot = async (): Promise<HTMLElement> => {
  const app = await bootApp({ surfaces: [], machines: [], path: '/settings' });
  view = app.view;
  return app.view.container as HTMLElement;
};
const row = (page: HTMLElement): HTMLElement => must(page.querySelector('[data-setting-row="Cached data"]'), 'the row');
const button = (scope: HTMLElement, name: string): HTMLButtonElement =>
  must(
    [...scope.querySelectorAll('button')].find(candidate => (candidate.textContent ?? '').trim() === name) as
      | HTMLButtonElement
      | undefined,
    `the ${name} button`,
  );

describe('Settings › This device › Cached data', () => {
  test('S-0458 is a row of its own, in words a person reads', async () => {
    const page = await boot();
    expect(row(page).textContent).toContain('Cached data');
    expect(row(page).querySelector('button[aria-label="Clear cached data"]')).not.toBeNull();
  });

  test('S-0458 asks once, inline, and clears only after the answer is yes', async () => {
    const clear = spyOn(ScrollMemory.prototype, 'clear');
    try {
      const page = await boot();
      await interact(() =>
        row(page).querySelector<HTMLButtonElement>('button[aria-label="Clear cached data"]')?.click(),
      );
      expect(clear).not.toHaveBeenCalled();
      expect(row(page).textContent).toContain('Clear this device’s cached data?');
      await interact(() => button(row(page), 'Keep it').click());
      expect(clear).not.toHaveBeenCalled();
      await interact(() =>
        row(page).querySelector<HTMLButtonElement>('button[aria-label="Clear cached data"]')?.click(),
      );
      await interact(() => button(row(page), 'Clear').click());
      await settle();
      expect(clear).toHaveBeenCalledTimes(1);
      expect(row(page).textContent).toContain('Cleared');
    } finally {
      clear.mockRestore();
    }
  });
});
