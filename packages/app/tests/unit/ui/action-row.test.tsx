import { afterEach, describe, expect, it } from 'bun:test';
import { ActionRow } from '../../../src/ui/action-row.tsx';
import { mount } from '../../support/dom.ts';

/** Keyboard order is visual order: primary first while stacked (a phone), secondary first in a row (a desktop). */
const setStacked = (stacked: boolean | undefined): void => {
  (window as unknown as { matchMedia: unknown }).matchMedia =
    stacked === undefined
      ? undefined
      : () => ({ matches: stacked, addEventListener: () => {}, removeEventListener: () => {} });
};

const names = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('[data-action-row] > button')).map(button => button.textContent ?? '');

const row = (
  <ActionRow
    secondary={
      <button type="button" className="kt-btn">
        Not now
      </button>
    }
    primary={
      <button type="button" className="kt-btn">
        Pair this device
      </button>
    }
  />
);

describe('ActionRow', () => {
  afterEach(() => setStacked(undefined));

  it('writes the primary first while stacked, so Tab reaches the top button first', async () => {
    setStacked(true);
    const mounted = await mount(row);
    expect(names(mounted.container)).toEqual(['Pair this device', 'Not now']);
    await mounted.unmount();
  });

  it('writes the secondary first in a row, so Tab goes left to right', async () => {
    setStacked(false);
    const mounted = await mount(row);
    expect(names(mounted.container)).toEqual(['Not now', 'Pair this device']);
    await mounted.unmount();
  });

  it('is the row (secondary first) where there is no matchMedia', async () => {
    setStacked(undefined);
    const mounted = await mount(row);
    expect(names(mounted.container)).toEqual(['Not now', 'Pair this device']);
    await mounted.unmount();
  });

  it('a lone primary stays one child, marked as the start-less row', async () => {
    setStacked(false);
    const mounted = await mount(
      <ActionRow
        primary={
          <button type="button" className="kt-btn">
            Continue
          </button>
        }
      />,
    );
    expect(names(mounted.container)).toEqual(['Continue']);
    expect(mounted.container.querySelector('.fy-action-row--start')).toBeNull();
    await mounted.unmount();
  });
});
