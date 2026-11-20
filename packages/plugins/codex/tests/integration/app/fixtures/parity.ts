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
      buttonsInRow: buttons.every(button => button.closest('.ob-actions') !== null),
      field: body?.querySelector('.ob-field input.ob-input') != null,
      cards: body?.querySelectorAll('[data-choice]').length ?? 0,
    };
  });

/** Claude Code's page, said once per page: what a Codex page must match. */
export const SAME_AS_CLAUDE = {
  installed: {
    demo: { kind: 'installed', text: '$ codex --version codex-cli 0.166.0' },
    // Claude: one "Install Claude Code" button while the command is runnable and nothing has failed.
    buttons: ['Install Codex'],
  },
  importChoice: { cards: 3, minLines: 1 },
  conversations: { cards: 2, minLines: 2 },
  // Claude: the pick shows "Use: …" and "Keep …" (conversations-page.tsx).
  conversationsPick: { buttons: ['Use: don’t show them', 'Keep showing them'] },
  permission: {
    cards: 2,
    minLines: 1,
    demo: { kind: 'permission-skip', text: '› rm -rf build/ ✓ ran, without asking' },
  },
  // Claude: the pick shows "Use Auto mode" and "Keep Skip permissions" (permission-page.tsx).
  permissionPick: {
    demo: { kind: 'permission-auto', text: '› rm -rf build/ Run this command? [y/N]' },
    buttons: ['Use Auto mode', 'Keep Skip permissions'],
  },
  // Claude: "Import" and "Skip the import", the runtime name field, the count line and what Next does (import-run-page.tsx).
  importRun: { buttons: ['Import', 'Skip the import'] },
} as const;

/** The kit's demo box is on the page, drawn by the kit's CSS, playing, and says what Claude's says. */
export const expectDemo = (
  facts: PageFacts,
  want: { readonly kind: string; readonly text: string },
  page: string,
): void => {
  expect(facts.demo, `${page}: a demo box, as on Claude Code's page`).not.toBeNull();
  expect(facts.demo?.kind, `${page}: the demo kind`).toBe(want.kind);
  expect(facts.demo?.drawn, `${page}: the demo box is drawn (border and surface)`).toBe(true);
  expect(facts.demo?.height ?? 0, `${page}: the demo box has its height`).toBeGreaterThanOrEqual(80);
  expect(facts.demo?.animated, `${page}: the demo plays`).toBe(true);
  expect(facts.demo?.text, `${page}: the demo says`).toBe(want.text);
};

/** The page body is the kit's frame, and its buttons are the kit's row. */
export const expectKitFrame = (facts: PageFacts, page: string): void => {
  expect(facts.frame, `${page}: the page body is the import kit's frame`).toBe(true);
  expect(facts.lines, `${page}: the page says its words in the kit's lines`).toBeGreaterThanOrEqual(1);
  if (facts.buttons.length > 0) expect(facts.buttonsInRow, `${page}: its buttons are the kit's row`).toBe(true);
};
