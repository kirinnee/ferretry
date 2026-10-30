/**
 * ADD TO CHAT IN A REAL BROWSER — every entry point that delivers into the composer, in every editor
 * style, with Vim off, in insert mode and in normal mode, into an empty draft and into a draft whose
 * caret sits mid-sentence.
 *
 * WHY THIS TIER. Every entry point delivers through one registry (`lib/quote.ts`) into the composer's
 * one insertion API, and the defect this file guards lived in the half no happy-dom test reaches: the
 * live editor (Markdown and Rich text) is a `contenteditable` document whose caret is a DOM range,
 * and the delivery placed that caret BEFORE the new draft had rendered. The draft landed, focus
 * landed, and the caret stayed where the OLD draft ended — at offset 0 of an empty draft — so the
 * reader's next word went in front of the reference and welded onto it. Only a real engine with real
 * focus and real key input shows that.
 *
 * WHAT IS REAL. The shipped `Composer`, the shipped entry points — the transcript's "Quote in
 * composer" menu, the terminal list's Add to chat and the skills surface's "Use in chat" — inside a reference surface that
 * proves the tokens they add, the app's whole stylesheet, real mouse and keyboard input. Every claim
 * about what is sent is the exact message the agent would receive (`window.__sent`).
 *
 * THE CONTRACT IT HOLDS, per case:
 *   - the delivery APPENDS to the draft (`composeReferenceDraft` / `composeQuotedDraft` /
 *     `appendSkillInvocation`) — the reader's sentence is never split, wherever its caret was;
 *   - the reference reads as a chip that is a link (the proof gate answered), and as a reference run
 *     inside the live editor; a quote reads as a quote block there;
 *   - focus is in the composer, in INSERT mode when Vim is on, with the caret after what was added,
 *     so the next word typed follows it;
 *   - the message sent is exactly the expected markdown plus that word.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { type ComposerSceneServer, serveComposerScene } from './support/composer-scene.ts';

let browser: Browser;
let server: ComposerSceneServer;

beforeAll(async () => {
  server = await serveComposerScene();
  browser = await sharedChromium();
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

const STYLES = [
  { editor: 'on', name: 'Markdown' },
  { editor: 'rich', name: 'Rich text' },
  { editor: 'off', name: 'Plain' },
] as const;
const VIM = ['off', 'insert', 'normal'] as const;
const DRAFT = 'hello world';
/** Where a "caret in the middle" sits: `hello|world`. */
const MIDDLE = 5;
const QUOTED = 'The build passed on the second try.';

interface EntryPoint {
  readonly name: string;
  /** The token a reference entry adds; a quote adds a block instead. */
  readonly token: string | null;
  /** The draft after the delivery, from the draft before it. */
  readonly expected: (draft: string) => string;
  deliver(page: Page): Promise<void>;
}

/** Selects the transcript's assistant text, right-clicks it and picks the quote menu item. */
const quote = async (page: Page): Promise<void> => {
  const box = await page.evaluate(text => {
    const transcript = document.querySelector('[data-scene-entries] .fy-transcript');
    const walker = document.createTreeWalker(transcript as Node, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(text);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return null;
  }, QUOTED);
  if (box === null) throw new Error('the transcript does not show the turn to quote');
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Quote in composer' }).click();
};

const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    name: "the transcript's Quote in composer",
    token: null,
    expected: draft => (draft === '' ? `> ${QUOTED}\n\n` : `${draft}\n\n> ${QUOTED}\n\n`),
    deliver: quote,
  },
  {
    name: "a terminal's Add to chat",
    token: '%terminal:dev',
    expected: draft => (draft === '' ? '%terminal:dev ' : `${draft} %terminal:dev `),
    deliver: page => page.locator('[data-surface-key="dev"]').getByRole('button', { name: 'Add to chat' }).click(),
  },
  {
    name: "a skill's Use in chat",
    token: '/summary',
    expected: draft => (draft === '' ? '/summary ' : `${draft} /summary `),
    deliver: page => page.getByRole('button', { name: 'Use /summary in chat' }).click(),
  },
];

const FIELD = '.fy-composer [data-live-editor], .fy-composer textarea';

/** The draft as the composer holds it: the live editor's lines, or the textarea's value. */
const draftOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.fy-composer textarea');
    if (textarea !== null) return textarea.value;
    const editor = document.querySelector('.fy-composer [data-live-editor]');
    return Array.from(editor?.children ?? [], line => line.textContent ?? '').join('\n');
  });

const sentOf = (page: Page): Promise<readonly { readonly message: string }[]> =>
  page.evaluate(() => (window as unknown as { __sent: { message: string }[] }).__sent);

const focusedOnField = (page: Page): Promise<boolean> =>
  page.evaluate(selector => document.activeElement?.matches(selector) ?? false, FIELD);

const open = async (editor: string, vim: (typeof VIM)[number], draft: string): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 1_280, height: 900 } });
  const page = await context.newPage();
  // Nothing leaves the loopback origin: no entry point may reach a daemon here.
  await page.route(/^(?!http:\/\/127\.0\.0\.1:)/u, route => route.abort());
  await page.route(/\/v1\//u, route => route.abort());
  const query = new URLSearchParams({ editor, entries: '1', draft, ...(vim === 'off' ? {} : { vim: '1' }) });
  await page.goto(`${server.url}?${query.toString()}`);
  await page.waitForSelector('[data-composer-send]');
  // Every entry point is ready: the terminal listing and the skills catalog have answered.
  await page.locator('[data-surface-key="dev"]').waitFor();
  await page.getByRole('button', { name: 'Use /summary in chat' }).waitFor();
  return page;
};

/** Puts the caret where the case asks, then the Vim mode, the way a reader would get there. */
const arrange = async (page: Page, editor: string, vim: (typeof VIM)[number], draft: string): Promise<void> => {
  await page.locator(FIELD).click();
  if (draft !== '') {
    await page.keyboard.press('End');
    for (let step = draft.length; step > MIDDLE; step -= 1) await page.keyboard.press('ArrowLeft');
  }
  if (vim === 'normal') {
    await page.keyboard.press('Escape');
    expect(await page.locator('[data-composer-vim-mode]').getAttribute('data-composer-vim-mode')).toBe('normal');
  }
  // The arrangement really is mid-sentence: typing nothing yet, the caret is inside the draft.
  if (draft !== '' && editor === 'off') {
    const caret = await page.evaluate(() => document.querySelector('textarea')?.selectionStart ?? -1);
    expect(caret).toBeLessThanOrEqual(MIDDLE);
  }
};

describe('Add to chat and quote, in a real browser', () => {
  for (const style of STYLES) {
    for (const vim of VIM) {
      for (const draft of ['', DRAFT]) {
        for (const entry of ENTRY_POINTS) {
          const where = draft === '' ? 'an empty draft' : 'a draft with the caret mid-sentence';
          test(`${style.name}, Vim ${vim}: ${entry.name} into ${where}`, async () => {
            const page = await open(style.editor, vim, draft);
            try {
              await arrange(page, style.editor, vim, draft);
              const expected = entry.expected(draft);

              await entry.deliver(page);

              // Lands appended, exactly, never splitting the reader's sentence.
              expect(await draftOf(page)).toBe(expected);
              // Focus is back in the composer, ready to type.
              expect(await focusedOnField(page)).toBe(true);
              if (vim !== 'off')
                expect(await page.locator('[data-composer-vim-mode]').getAttribute('data-composer-vim-mode')).toBe(
                  'insert',
                );
              if (entry.token !== null) {
                // The chip is a LINK: the shared proof gate answered for the token that landed.
                const chip = page.locator(`[data-composer-reference="${entry.token}"]`);
                expect(await chip.count()).toBe(1);
                expect(await chip.locator('a').count()).toBe(1);
                if (style.editor !== 'off')
                  expect(await page.locator('.fy-composer [data-md="reference"]').allTextContents()).toEqual([
                    entry.token,
                  ]);
              } else if (style.editor !== 'off') {
                expect(await page.locator('.fy-composer [data-block="quote"]').count()).toBe(1);
              }

              // The caret is after what was added: the next word follows it, it does not weld onto it.
              await page.keyboard.type('ok');
              expect(await draftOf(page)).toBe(`${expected}ok`);
              await page.keyboard.press('Enter');
              await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length > 0);
              expect((await sentOf(page)).map(sent => sent.message)).toEqual([`${expected}ok`]);
            } finally {
              await page.context().close();
            }
          }, 30_000);
        }
      }
    }
  }
});
