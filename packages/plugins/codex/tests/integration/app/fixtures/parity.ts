/**
 * What a Codex first-run page must show to be the same page as Claude Code's, measured in the real browser. The expected
 * words and buttons are Claude Code's own (`claude-code/app/features/onboarding/*`), with Claude's name swapped for Codex's;
 * the shared pieces are the import kit's (`@ferretry/plugin-runtimes/import-kit`: `.ob-step`, `.ob-demo`, `.ob-actions`,
 * `.ob-field`), so a page that drops back to its own markup (no demo box, other buttons, bare fields) fails here.
 */
import { expect } from 'bun:test';
import type { Page } from 'playwright-core';

export interface PageFacts {
  /** The page body is the kit's frame (`.ob-step`), and its lines are the kit's. */
  readonly frame: boolean;
  readonly lines: number;
  /** The demo box, when there is one: its kind, whether the kit's own CSS drew it, and what it says. */
  readonly demo: {
    readonly kind: string;
    readonly drawn: boolean;
    readonly animated: boolean;
    readonly text: string;
    readonly height: number;
  } | null;
  /** The labels of every button inside the page body, in order. */
  readonly buttons: readonly string[];
  /** Whether those buttons sit in the kit's actions row. */
  readonly buttonsInRow: boolean;
  readonly field: boolean;
  readonly cards: number;
}

/** Reads what the page body shows. */
export const factsOf = async (tab: Page): Promise<PageFacts> =>
  await tab.evaluate(() => {
    const body = document.querySelector('[data-codex-step]');
    const demo = body?.querySelector<HTMLElement>('[data-demo]') ?? null;
    const buttons = [...(body?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const rect = demo?.getBoundingClientRect();
    const style = demo === null ? null : getComputedStyle(demo);
    const typed = demo?.querySelector('.ob-type, .ob-ask, .ob-run');
    return {
      frame: body?.classList.contains('ob-step') ?? false,
      lines: body?.querySelectorAll(':scope > .ob-step__line, :scope > * > .ob-step__line').length ?? 0,
      demo:
        demo === null || rect === undefined || style === null
          ? null
          : {
              kind: demo.dataset.demo ?? '',
              drawn: style.borderTopWidth !== '0px' && style.backgroundColor !== 'rgba(0, 0, 0, 0)',
              animated: typed == null ? false : getComputedStyle(typed).animationName !== 'none',
              text: demo.innerText.replace(/\s+/gu, ' ').trim(),
              height: rect.height,
            },
      buttons: buttons.map(button => (button.textContent ?? '').trim()),
      buttonsInRow: buttons.every(button => button.closest('.ob-actions, [data-action-row]') !== null),
      field: body?.querySelector('.ob-field input.ob-input') != null,
      cards: body?.querySelectorAll('[data-choice]').length ?? 0,
    };
  });

/** Claude Code's run page, said once: what a Codex run page must match. The other Codex pages are proved by their own owner-line asserts. */
export const SAME_AS_CLAUDE = {
  // Claude: the one "Import" action, the runtime name field, the count line and what Next does (import-run-page.tsx).
  // Leaving the import is the flow footer's Later / Next, so the page draws no second "skip" button.
  importRun: { buttons: ['Import'] },
} as const;

/** The page body is the kit's frame, and its buttons are the kit's row. */
export const expectKitFrame = (facts: PageFacts, page: string): void => {
  expect(facts.frame, `${page}: the page body is the import kit's frame`).toBe(true);
  expect(facts.lines, `${page}: the page says its words in the kit's lines`).toBeGreaterThanOrEqual(1);
  if (facts.buttons.length > 0) expect(facts.buttonsInRow, `${page}: its buttons are the kit's row`).toBe(true);
};
