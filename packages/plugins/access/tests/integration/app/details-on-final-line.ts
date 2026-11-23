/**
 * The pair screens' "Details" link sits on the END of the one friendly line (`LineWithDetails`). "Inline" means the link is on the
 * line's FINAL TEXT LINE: a check that only compares the link with the whole paragraph passes when Details has wrapped onto a
 * line of its own, because that line is still inside the paragraph. This measures the link against the box of the last text
 * line before it, and proves the measure can fail by forcing the link onto its own line and measuring again.
 */
import { expect } from 'bun:test';
import type { Page } from 'playwright-core';

interface Measure {
  /** The last text line's box (the text before the link; the trailing full stop on a one-line sentence). */
  readonly last: { readonly top: number; readonly bottom: number };
  readonly link: { readonly top: number; readonly bottom: number };
  readonly onFinalLine: boolean;
}

const measure = async (tab: Page, lineSelector: string, forceOwnLine: boolean): Promise<Measure> =>
  await tab.evaluate(
    ({ selector, force }) => {
      const line = document.querySelector<HTMLElement>(selector);
      const link = line?.querySelector<HTMLElement>('button');
      if (line === null || line === undefined || link === null || link === undefined)
        throw new Error(`no line with a Details link at ${selector}`);
      const before = link.style.display;
      if (force) link.style.display = 'block';
      try {
        const range = document.createRange();
        range.setStart(line, 0);
        range.setEndBefore(link);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
        const last = rects.at(-1);
        if (last === undefined) throw new Error(`no text before the Details link at ${selector}`);
        const box = link.getBoundingClientRect();
        const middle = box.top + box.height / 2;
        return {
          last: { top: last.top, bottom: last.bottom },
          link: { top: box.top, bottom: box.bottom },
          onFinalLine: middle >= last.top - 1 && middle <= last.bottom + 1,
        };
      } finally {
        link.style.display = before;
      }
    },
    { selector: lineSelector, force: forceOwnLine },
  );

/** Asserts "Details" shares the final text line of `lineSelector`, and that this check would fail were it on its own line. */
export const expectDetailsOnFinalLine = async (tab: Page, lineSelector: string, what: string): Promise<void> => {
  const real = await measure(tab, lineSelector, false);
  expect(real.onFinalLine, `${what}: Details is on the final text line (${JSON.stringify(real)})`).toBe(true);
  const wrapped = await measure(tab, lineSelector, true);
  expect(
    wrapped.onFinalLine,
    `${what}: the measure fails when Details sits on its own line (${JSON.stringify(wrapped)})`,
  ).toBe(false);
};
