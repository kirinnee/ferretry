/**
 * THE COMPOSER IN A REAL BROWSER — formatting, Vim keys and the two send buttons, in Chromium, with
 * the app's whole stylesheet.
 *
 * WHY THIS TIER. The defect this file guards was invisible to the unit tier: the Markdown editor
 * style was a textarea under a colour-only paint layer, so `# Title` and `**bold**` changed colour
 * and nothing else, and no happy-dom test could see that a heading was not bigger. Here every claim is
 * a computed style or a measured box in a real engine, and every send is the exact markdown string
 * the agent would receive (`window.__sent`).
 *
 * WHAT IS REAL. The shipped `Composer` and `LiveMarkdownEditor`, the real stylesheet graph through
 * Tailwind (built by `scripts/build-composer-integration-fixture.ts` in a CHILD process — a
 * component-graph build inside the runner is what wedged the integration tier before), real keyboard
 * input. Not real: the app shell and the daemon, which change nothing about the composer.
 *
 * IT IS ALSO THE EVIDENCE DRIVER. Set `COMPOSER_EVIDENCE_DIR` to an absolute directory outside the
 * repository and the last journey writes the screenshots the PR links: each editor style with
 * formatted content, the Vim indicator, and the two buttons, at desktop and phone, in studio and neo, light and dark.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { THEME_FAMILIES } from '../../src/lib/theme-preferences.ts';
import { sharedChromium } from './support/chromium.ts';
import { type ComposerSceneServer, serveComposerScene } from './support/composer-scene.ts';

const evidenceDir = process.env.COMPOSER_EVIDENCE_DIR ?? null;

const DESKTOP = { viewport: { width: 1_280, height: 720 } } as const;
/** A real phone context: a 390px desktop is not the journey a phone reader takes. */
const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
} as const;

let browser: Browser;
let server: ComposerSceneServer;

beforeAll(async () => {
  server = await serveComposerScene();
  browser = await sharedChromium();
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

interface Scene {
  readonly context: BrowserContext;
  readonly page: Page;
  close(): Promise<void>;
}

const open = async (parameters: Record<string, string>, options: { readonly phone?: boolean } = {}): Promise<Scene> => {
  const context = await browser.newContext(options.phone === true ? PHONE : DESKTOP);
  const page = await context.newPage();
  // Nothing leaves the loopback origin: an attachment upload must fail here, never reach a daemon.
  await page.route(/^(?!http:\/\/127\.0\.0\.1:)/u, route => route.abort());
  await page.route(/\/v1\//u, route => route.abort());
  const query = new URLSearchParams({ ...parameters, ...(options.phone === true ? { compact: '1' } : {}) });
  await page.goto(`${server.url}?${query.toString()}`);
  await page.waitForSelector('[data-composer-send]');
  return { context, page, close: () => context.close() };
};

const EDITOR = '[data-live-editor]';

/** The draft as the composer holds it: the live editor's lines, or the textarea's value. */
const draftOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.fy-composer textarea');
    if (textarea !== null) return textarea.value;
    const editor = document.querySelector('[data-live-editor]');
    return Array.from(editor?.children ?? [], line => line.textContent ?? '').join('\n');
  });

const sentOf = (page: Page): Promise<readonly { readonly message: string; readonly now: boolean }[]> =>
  page.evaluate(() => (window as unknown as { __sent: { message: string; now: boolean }[] }).__sent);

const vimMode = (page: Page): Promise<string | null> =>
  page.locator('[data-composer-vim-mode]').getAttribute('data-composer-vim-mode');

const press = async (page: Page, ...keys: readonly string[]): Promise<void> => {
  for (const key of keys) await page.keyboard.press(key);
};

describe('the composer in a real browser', () => {
  test('Markdown, Notion-style: headings, lists, quotes, marks and code format as they are typed', async () => {
    const scene = await open({ editor: 'on', theme: 'studio-light' });
    const { page } = scene;
    try {
      await page.locator(EDITOR).click();
      await page.keyboard.type('# Release notes');
      await press(page, 'Shift+Enter');
      await page.keyboard.type('Ship **bold** and *slanted* with `code` and ~~gone~~.');
      await press(page, 'Shift+Enter');
      // Enter on a list item continues the list; Enter on an empty item ends it, leaving the line.
      await page.keyboard.type('- first');
      await press(page, 'Enter');
      await page.keyboard.type('second');
      await press(page, 'Enter', 'Enter');
      await page.keyboard.type('1. one');
      await press(page, 'Enter');
      await page.keyboard.type('two');
      await press(page, 'Enter', 'Enter');
      await page.keyboard.type('> quoted');
      await press(page, 'Shift+Enter');
      await page.keyboard.type('```');
      await press(page, 'Shift+Enter');
      // Enter inside a fence is a new code line, never a send.
      await page.keyboard.type('const a = 1;');
      await press(page, 'Enter');
      await page.keyboard.type('```');

      const looks = await page.evaluate(() => {
        const editor = document.querySelector('[data-live-editor]') as HTMLElement;
        const style = (selector: string) => getComputedStyle(editor.querySelector(selector) as Element);
        const before = (selector: string) => getComputedStyle(editor.querySelector(selector) as Element, '::before');
        return {
          heading: Number.parseFloat(style('[data-block="h1"]').fontSize),
          body: Number.parseFloat(style('[data-block="p"]').fontSize),
          headingWeight: Number(style('[data-block="h1"]').fontWeight),
          bold: Number(style('[data-md="strong"]:not([data-md-mark])').fontWeight),
          italic: style('[data-md="em"]:not([data-md-mark])').fontStyle,
          code: style('[data-md="code"]:not([data-md-mark])').fontFamily,
          strike: style('[data-md="strike"]:not([data-md-mark])').textDecorationLine,
          markerColour: style('[data-md-mark]').color,
          textColour: style('[data-block="p"]').color,
          bullet: before('[data-md-marker="bullet"]').content,
          bulletInk: style('[data-md-marker="bullet"]').color,
          quote: style('[data-block="quote"]').borderLeftWidth,
          heavyStroke: getComputedStyle(editor).getPropertyValue('--stroke-heavy').trim(),
          codeLine: style('[data-block="code"]').fontFamily,
          codeBackground: style('[data-block="code"]').backgroundColor,
        };
      });
      expect(looks.heading).toBeGreaterThan(looks.body * 1.3);
      expect(looks.headingWeight).toBeGreaterThanOrEqual(700);
      expect(looks.bold).toBeGreaterThanOrEqual(700);
      expect(looks.italic).toBe('italic');
      expect(looks.code).toMatch(/mono/iu);
      expect(looks.strike).toBe('line-through');
      expect(looks.markerColour).not.toBe(looks.textColour);
      expect(looks.bullet).toBe('"•"');
      expect(looks.bulletInk).toBe('rgba(0, 0, 0, 0)');
      // The quote rule is the theme's heavy stroke, so it is thicker in Neo than in Studio.
      expect(looks.quote).toBe(looks.heavyStroke);
      expect(Number.parseFloat(looks.quote)).toBeGreaterThan(1);
      expect(looks.codeLine).toMatch(/mono/iu);
      expect(looks.codeBackground).not.toBe('rgba(0, 0, 0, 0)');

      const markdown = [
        '# Release notes',
        'Ship **bold** and *slanted* with `code` and ~~gone~~.',
        '- first',
        '- second',
        '1. one',
        '2. two',
        '> quoted',
        '```',
        'const a = 1;',
        '```',
      ].join('\n');
      expect(await draftOf(page)).toBe(markdown);
      expect(await sentOf(page)).toEqual([]);
      await press(page, 'Control+Enter');
      await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 1);
      expect(await sentOf(page)).toEqual([{ message: markdown, now: false }]);
      expect(await draftOf(page)).toBe('');
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('Rich text: markers hide off the caret’s line, and the toolbar and shortcuts really format', async () => {
    const scene = await open({ editor: 'rich', theme: 'neo-light' });
    const { page } = scene;
    try {
      await page.locator(EDITOR).click();
      await page.keyboard.type('# Plan');
      await press(page, 'Shift+Enter');
      await page.keyboard.type('make this loud');
      // The heading's `# ` is hidden now the caret has left its line; the heading is still big.
      const heading = page.locator('[data-block="h1"] [data-md-marker]');
      expect(await heading.evaluate(node => getComputedStyle(node).display)).toBe('none');
      for (let index = 0; index < 4; index += 1) await press(page, 'Shift+ArrowLeft');
      await press(page, 'Control+b');
      expect(await draftOf(page)).toBe('# Plan\nmake this **loud**');
      await press(page, 'ArrowUp');
      // On the heading's own line its marker is back, so it can be edited.
      // The reveal follows `selectionchange`, which the browser delivers asynchronously.
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('[data-block="h1"] [data-md-marker]') as Element).display !== 'none',
      );
      await press(page, 'ArrowDown');
      await page.getByRole('button', { name: 'Bulleted list' }).click();
      expect(await draftOf(page)).toBe('# Plan\n- make this **loud**');
      expect(await page.locator(EDITOR).evaluate(node => node === document.activeElement)).toBe(true);
      await press(page, 'End');
      await page.getByRole('button', { name: 'Italic' }).click();
      await page.keyboard.type('soft');
      const weight = await page
        .locator('[data-md="strong"]:not([data-md-mark])')
        .evaluate(node => Number(getComputedStyle(node).fontWeight));
      expect(weight).toBeGreaterThanOrEqual(700);
      await press(page, 'Control+Enter');
      await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 1);
      expect((await sentOf(page))[0]?.message).toBe('# Plan\n- make this **loud***soft*');
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('Plain text stays a plain box and sends exactly what was typed', async () => {
    const scene = await open({ editor: 'off', theme: 'studio-dark' });
    const { page } = scene;
    try {
      expect(await page.locator(EDITOR).count()).toBe(0);
      await page.locator('.fy-composer textarea').click();
      await page.keyboard.type('# not a heading **raw**');
      await press(page, 'Enter');
      await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 1);
      expect(await sentOf(page)).toEqual([{ message: '# not a heading **raw**', now: false }]);
    } finally {
      await scene.close();
    }
  }, 60_000);

  for (const editor of ['on', 'rich', 'off'] as const) {
    test(`Vim keys are a real modal editor in the ${editor} editor style`, async () => {
      const scene = await open({ editor, theme: 'studio-light', vim: '1' });
      const { page } = scene;
      try {
        await page.locator(editor === 'off' ? '.fy-composer textarea' : EDITOR).click();
        expect(await vimMode(page)).toBe('insert');
        expect(await page.locator('[data-composer-vim-mode]').textContent()).toBe('-- INSERT --');
        await page.keyboard.type('hello world');
        await press(page, 'Escape');
        expect(await vimMode(page)).toBe('normal');
        expect(await page.locator('[data-composer-vim-mode]').textContent()).toBe('-- NORMAL --');
        // Letters are commands now, never text.
        await press(page, '0', 'w', 'x');
        expect(await draftOf(page)).toBe('hello orld');
        await press(page, 'u');
        expect(await draftOf(page)).toBe('hello world');
        await press(page, 'd', 'w');
        expect(await draftOf(page)).toBe('hello ');
        await press(page, 'u', '$', 'a');
        expect(await vimMode(page)).toBe('insert');
        await page.keyboard.type('!');
        await press(page, 'Escape');
        // Enter in normal mode moves; it never sends.
        await press(page, 'Enter');
        expect(await sentOf(page)).toEqual([]);
        await press(page, 'o');
        await page.keyboard.type('next line');
        await press(page, 'Escape', 'k', 'd', 'd');
        expect(await draftOf(page)).toBe('next line');
        await press(page, 'p');
        expect(await draftOf(page)).toBe('next line\nhello world!');
        await press(page, 'g', 'g', 'e', 'x');
        expect(await draftOf(page)).toBe('nex line\nhello world!');
        await press(page, 'G', 'l', 'x', 'h', 'x');
        expect(await draftOf(page)).toBe('nex line\nllo world!');
        await press(page, 'u', 'u', 'k', 'j', 'b', 'I');
        await page.keyboard.type('> ');
        await press(page, 'Escape', 'A');
        await page.keyboard.type('?');
        expect(await draftOf(page)).toBe('nex line\n> hello world!?');
        await press(page, 'Escape', 'O');
        await page.keyboard.type('top');
        // In insert mode the send key is the configured one again.
        await press(page, 'Enter');
        await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 1);
        expect(await sentOf(page)).toEqual([{ message: 'nex line\ntop\n> hello world!?', now: false }]);
        expect(await vimMode(page)).toBe('insert');
      } finally {
        await scene.close();
      }
    }, 60_000);
  }

  test('Send queues, Interrupt & send sends now, and only shows while the agent works; no hint line', async () => {
    const scene = await open({ editor: 'on', theme: 'studio-light', busy: '1' });
    const { page } = scene;
    try {
      const send = page.locator('[data-composer-send]');
      const interrupt = page.locator('[data-composer-interrupt]');
      expect(await send.getAttribute('title')).toMatch(/queued for the agent's next turn \(↵ or (⌘|Ctrl\+)↵\)/u);
      expect(await interrupt.getAttribute('title')).toMatch(/^Interrupt & send — .*\((⌘|Ctrl\+)⇧↵\)$/u);
      const [sendBox, interruptBox] = [await send.boundingBox(), await interrupt.boundingBox()];
      // Side by side: one row, Interrupt & send first.
      expect(Math.abs((sendBox?.y ?? 0) - (interruptBox?.y ?? 99))).toBeLessThan(2);
      expect((interruptBox?.x ?? 0) + (interruptBox?.width ?? 0)).toBeLessThanOrEqual(sendBox?.x ?? 0);
      expect(await page.locator('.fy-composer').textContent()).not.toContain('drop files here');
      await page.locator(EDITOR).click();
      await page.keyboard.type('queue me');
      await send.click();
      await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 1);
      await page.locator(EDITOR).click();
      await page.keyboard.type('stop and do this');
      await interrupt.click();
      await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 2);
      expect(await sentOf(page)).toEqual([
        { message: 'queue me', now: false },
        { message: 'stop and do this', now: true },
      ]);
      await page.locator(EDITOR).click();
      await page.keyboard.type('shortcut');
      await press(page, 'Control+Shift+Enter');
      await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 3);
      expect((await sentOf(page))[2]).toEqual({ message: 'shortcut', now: true });
    } finally {
      await scene.close();
    }
    const idle = await open({ editor: 'on', theme: 'studio-light' });
    try {
      expect(await idle.page.locator('[data-composer-interrupt]').count()).toBe(0);
    } finally {
      await idle.close();
    }
  }, 60_000);

  test('a phone field keeps its exact box when Interrupt & send appears, with attach and mic on the left', async () => {
    const measure = async (busy: boolean) => {
      const scene = await open(
        { editor: 'on', theme: 'studio-light', ...(busy ? { busy: '1' } : {}) },
        { phone: true },
      );
      try {
        return await scene.page.evaluate(() => {
          const box = (selector: string) => {
            const rect = (document.querySelector(selector) as Element).getBoundingClientRect();
            return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          };
          return {
            field: box('.fy-composer-input-layer'),
            row: box('.fy-composer-row'),
            send: box('[data-composer-send]'),
            attach: box('[data-composer-attach]'),
          };
        });
      } finally {
        await scene.close();
      }
    };
    const [idle, working] = [await measure(false), await measure(true)];
    // The owner's "stable box": nothing about the field or the row moves as a turn starts.
    expect(working.field).toEqual(idle.field);
    expect(working.row).toEqual(idle.row);
    expect(working.send).toEqual(idle.send);
    // kteam's layout: attach left of the field, Send right of it.
    expect(idle.attach.left + idle.attach.width).toBeLessThanOrEqual(idle.field.left + 0.5);
    expect(idle.send.left).toBeGreaterThanOrEqual(idle.field.left + idle.field.width - 0.5);
  }, 60_000);

  test("the composer takes the theme's own input and button tokens, so Neo's frame is not Studio's", async () => {
    const scene = await open({ editor: 'on', theme: 'studio-light', busy: '1' }, { phone: true });
    const read = async (theme: string) => {
      await scene.page.evaluate(next => document.documentElement.setAttribute('data-theme', next), theme);
      return await scene.page.evaluate(() => {
        // A token resolved by the engine itself: a probe styled with it, read back.
        const resolve = (property: string, token: string) => {
          const probe = document.createElement('div');
          probe.style.setProperty('border-style', 'solid');
          probe.style.setProperty(property, `var(${token})`);
          document.body.append(probe);
          const value = getComputedStyle(probe).getPropertyValue(property);
          probe.remove();
          return value;
        };
        const style = (selector: string) => getComputedStyle(document.querySelector(selector) as Element);
        const row = style('.fy-composer-row');
        const send = style('[data-composer-send]');
        const interrupt = style('[data-composer-interrupt]');
        return {
          rowRadius: row.borderTopLeftRadius,
          rowStroke: row.borderTopWidth,
          sendRadius: send.borderTopLeftRadius,
          sendShadow: send.boxShadow,
          interruptStroke: interrupt.borderTopWidth,
          radiusInput: resolve('border-top-left-radius', '--radius-input'),
          radiusControl: resolve('border-top-left-radius', '--radius-control'),
          strokeControl: resolve('border-top-width', '--stroke-control'),
          shadowControl: resolve('box-shadow', '--shadow-control'),
        };
      });
    };
    let studio: Awaited<ReturnType<typeof read>>;
    let neo: Awaited<ReturnType<typeof read>>;
    try {
      studio = await read('studio-light');
      neo = await read('neo-light');
    } finally {
      await scene.close();
    }
    for (const [name, measured] of [
      ['studio', studio],
      ['neo', neo],
    ] as const) {
      expect({ name, radius: measured.rowRadius }).toEqual({ name, radius: measured.radiusInput });
      expect({ name, stroke: measured.rowStroke }).toEqual({ name, stroke: measured.strokeControl });
      expect({ name, radius: measured.sendRadius }).toEqual({ name, radius: measured.radiusControl });
      expect({ name, shadow: measured.sendShadow }).toEqual({ name, shadow: measured.shadowControl });
      expect({ name, stroke: measured.interruptStroke }).toEqual({ name, stroke: measured.strokeControl });
    }
    // Contrasting families really do draw different boxes: the guard would catch a pinned value.
    expect(neo.rowStroke === studio.rowStroke && neo.rowRadius === studio.rowRadius).toBe(false);
  }, 60_000);

  test('a dropped file still becomes an attachment', async () => {
    const scene = await open({ editor: 'on', theme: 'studio-light' });
    const { page } = scene;
    try {
      await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
        const form = document.querySelector('.fy-composer') as HTMLElement;
        form.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        form.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      await page.waitForSelector('text=notes.txt');
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('every theme formats, keeps its margins and gives a phone 44px targets for both buttons', async () => {
    const draft = '# Heading\n- **bold** item';
    for (const phone of [false, true]) {
      // ONE page per viewport: `theme` is only the `data-theme` attribute the scene stamps at load, so
      // stamping it again re-resolves every token without paying a reload per theme.
      const scene = await open({ editor: 'on', theme: 'studio-light', busy: '1', draft }, { phone });
      const { page } = scene;
      await page.waitForSelector('[data-composer-interrupt]');
      try {
        for (const { id } of THEME_FAMILIES)
          for (const mode of ['light', 'dark']) {
            await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), `${id}-${mode}`);
            const measured = await page.evaluate(() => {
              const box = (selector: string) => (document.querySelector(selector) as Element).getBoundingClientRect();
              const size = (selector: string) =>
                Number.parseFloat(getComputedStyle(document.querySelector(selector) as Element).fontSize);
              const row = box('.fy-composer-row');
              const rowStyle = getComputedStyle(document.querySelector('.fy-composer-row') as Element);
              return {
                padX: Number.parseFloat(rowStyle.paddingLeft),
                padY: Number.parseFloat(rowStyle.paddingTop),
                borderX: Number.parseFloat(rowStyle.borderLeftWidth),
                send: box('[data-composer-send]'),
                interrupt: box('[data-composer-interrupt]'),
                row,
                editor: box('[data-live-editor]'),
                overflow: document.documentElement.scrollWidth - window.innerWidth,
                heading: size('[data-block="h1"]'),
                body: size('[data-block="bullet"]'),
                bold: Number(
                  getComputedStyle(document.querySelector('[data-md="strong"]:not([data-md-mark])') as Element)
                    .fontWeight,
                ),
              };
            });
            const label = `${id}-${mode} ${phone ? 'phone' : 'desktop'}`;
            expect({ label, wider: measured.overflow > 0 }).toEqual({ label, wider: false });
            expect({ label, heading: measured.heading > measured.body }).toEqual({ label, heading: true });
            expect({ label, bold: measured.bold >= 600 }).toEqual({ label, bold: true });
            // The controls keep real breathing room from the frame: at least 8px of padding past the border's
            // own thickness on the sides (the theme's control padding plus its stroke, so Neo's thick frame
            // gets more than Studio's hairline), and a comfortable inset above and below.
            expect({ label, side: measured.padX >= measured.borderX + 8 }).toEqual({ label, side: true });
            expect({ label, vertical: measured.padY >= measured.borderX + 4 }).toEqual({ label, vertical: true });
            // The buttons and the editor sit inside the row, never on its border.
            for (const inner of [measured.send, measured.interrupt, measured.editor]) {
              expect({ label, inside: inner.left >= measured.row.left && inner.right <= measured.row.right }).toEqual({
                label,
                inside: true,
              });
            }
            if (phone)
              for (const button of [measured.send, measured.interrupt])
                expect({ label, target: button.width >= 44 && button.height >= 44 }).toEqual({ label, target: true });
          }
      } finally {
        await scene.close();
      }
    }
  }, 120_000);

  test('evidence: each editor style, the Vim indicator and the two buttons, studio and neo in both modes, desktop and phone', async () => {
    if (evidenceDir === null) return;
    await mkdir(evidenceDir, { recursive: true });
    const sample = [
      '# Release notes',
      '## What changed',
      'The composer now **formats as you type** — *italic*, `inline code` and ~~struck~~ text.',
      '- headings are bigger',
      '- [x] lists get bullets',
      '1. numbered, too',
      '> quotes get a rule',
      '```ts',
      'const sent = markdown;',
      '```',
    ].join('\n');
    for (const theme of ['studio-light', 'studio-dark', 'neo-light', 'neo-dark'])
      for (const phone of [false, true]) {
        const device = phone ? 'phone' : 'desktop';
        for (const [name, parameters] of [
          ['markdown', { editor: 'on', draft: sample }],
          ['rich', { editor: 'rich', draft: sample }],
          ['plain', { editor: 'off', draft: sample }],
          ['vim-normal', { editor: 'on', vim: '1', draft: '# Vim\nhello **world**' }],
        ] as const) {
          const scene = await open({ ...parameters, theme, busy: '1' }, { phone });
          try {
            const field = scene.page.locator(parameters.editor === 'off' ? '.fy-composer textarea' : EDITOR);
            await field.click();
            // The top of the draft, where the headings are; the Vim shot keeps the caret on the last line.
            await press(scene.page, name === 'vim-normal' ? 'Control+End' : 'Control+Home');
            if (name === 'vim-normal') await press(scene.page, 'Escape');
            await scene.page.waitForTimeout(50);
            await scene.page
              .locator('.fy-composer')
              .screenshot({ path: join(evidenceDir, `composer-${name}-${theme}-${device}.png`) });
          } finally {
            await scene.close();
          }
        }
      }
  }, 180_000);
});

/**
 * A software keyboard, faked the way the phone audit does: `visualViewport.height` shrinks while the
 * layout viewport stays, which is what iOS reports. The app's own viewport hook reads it and stamps
 * `data-keyboard="open"`; nothing here sets that attribute by hand.
 */
const FAKE_KEYBOARD = `(() => {
  const real = window.visualViewport; if (!real) return;
  const target = new EventTarget(); let override = null;
  for (const n of ['width', 'offsetTop', 'offsetLeft', 'pageTop', 'pageLeft', 'scale'])
    Object.defineProperty(target, n, { get: () => real[n], configurable: true });
  Object.defineProperty(target, 'height', { get: () => override ?? real.height, configurable: true });
  real.addEventListener('resize', () => target.dispatchEvent(new Event('resize')));
  Object.defineProperty(window, 'visualViewport', { get: () => target, configurable: true });
  window.__setVisualViewportHeight = next => { override = next; target.dispatchEvent(new Event('resize')); };
})();`;

/** The visible height above a phone keyboard, measured in the phone audit (portrait). */
const KEYBOARD_VISIBLE_PX = 430;

const openWithKeyboard = async (theme: string, editor = 'on'): Promise<Scene> => {
  const context = await browser.newContext(PHONE);
  await context.addInitScript(FAKE_KEYBOARD);
  const page = await context.newPage();
  await page.route(/^(?!http:\/\/127\.0\.0\.1:)/u, route => route.abort());
  await page.route(/\/v1\//u, route => route.abort());
  const query = new URLSearchParams({ editor, theme, busy: '1', compact: '1', layout: 'chat' });
  await page.goto(`${server.url}?${query.toString()}`);
  await page.waitForSelector('[data-composer-send]');
  await page.locator(EDITOR).click();
  await page.evaluate(
    height => (window as unknown as { __setVisualViewportHeight(h: number): void }).__setVisualViewportHeight(height),
    KEYBOARD_VISIBLE_PX,
  );
  await page.waitForSelector('html[data-keyboard="open"]');
  return { context, page, close: () => context.close() };
};

describe('the composer on a phone with the keyboard up', () => {
  test('stays compact so the turn being answered stays readable, and the @ list fits the screen', async () => {
    const scene = await openWithKeyboard('studio-light');
    const { page } = scene;
    try {
      for (let line = 0; line < 9; line += 1) {
        await page.keyboard.type(`line ${line} of a long reply`);
        await press(page, 'Shift+Enter');
      }
      const measured = await page.evaluate(() => {
        const box = (selector: string) => (document.querySelector(selector) as Element).getBoundingClientRect();
        return {
          transcript: box('[data-scene-transcript]').height,
          composer: box('.fy-composer').height,
          editor: box('[data-live-editor]').height,
          bottom: box('.fy-composer').bottom,
          status: getComputedStyle(document.querySelector('[data-composer-status-chrome]') as Element).display,
        };
      });
      // The phone composer is a writing surface now (its controls stack beside the field), so the
      // keyboard-up ceiling is six 24px lines rather than four 22px ones — still small enough that the
      // turn being answered keeps more than half the visible viewport.
      expect(measured.editor).toBeLessThanOrEqual(144 + 1);
      expect(measured.composer).toBeLessThanOrEqual(175);
      expect(measured.transcript).toBeGreaterThanOrEqual(KEYBOARD_VISIBLE_PX * 0.55);
      expect(measured.bottom).toBeLessThanOrEqual(KEYBOARD_VISIBLE_PX);
      expect(measured.status).toBe('none');

      await page.keyboard.type('@');
      const popover = page.locator('.fy-ac-pop');
      await popover.waitFor();
      const rect = await popover.boundingBox();
      expect(rect?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((rect?.x ?? 0) + (rect?.width ?? 999)).toBeLessThanOrEqual(PHONE.viewport.width);
      expect(rect?.y ?? -1).toBeGreaterThanOrEqual(0);
      // No keys a touch screen does not have.
      expect(await popover.textContent()).not.toMatch(/esc|↑↓|⇥/u);

      // The keyboard going away brings the readouts back.
      await page.evaluate(() =>
        (window as unknown as { __setVisualViewportHeight(h: number | null): void }).__setVisualViewportHeight(null),
      );
      await page.waitForSelector('html:not([data-keyboard])');
      expect(await page.locator('[data-composer-status-chrome]').evaluate(node => getComputedStyle(node).display)).toBe(
        'contents',
      );
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('evidence: keyboard up, a long draft and the @ list, three themes', async () => {
    if (evidenceDir === null) return;
    await mkdir(evidenceDir, { recursive: true });
    for (const theme of ['studio-light', 'studio-dark', 'neo-light', 'neo-dark'])
      for (const editor of ['on', 'rich']) {
        const scene = await openWithKeyboard(theme, editor);
        try {
          const { page } = scene;
          await page.keyboard.type('# Reply');
          await press(page, 'Shift+Enter');
          await page.keyboard.type('- **first** point');
          await press(page, 'Enter');
          await page.keyboard.type('second point');
          const clip = { x: 0, y: 0, width: PHONE.viewport.width, height: KEYBOARD_VISIBLE_PX };
          await page.screenshot({ clip, path: join(evidenceDir, `keyboard-${editor}-${theme}-phone.png`) });
          if (editor === 'on') {
            await press(page, 'Shift+Enter');
            await page.keyboard.type('ask @');
            await page.locator('.fy-ac-pop').waitFor();
            await page.screenshot({ clip, path: join(evidenceDir, `keyboard-at-${theme}-phone.png`) });
          }
        } finally {
          await scene.close();
        }
      }
  }, 180_000);
});
