/**
 * THE CLAUDE SEGMENT'S FIRST-RUN PAGES in a real browser over fixed fake data (`fixtures/onboarding-scene.tsx`): r11 O4's
 * proof of the owner's lines (items 3, 5: options stacked, the demo on the right, fewer words, no page buttons, fixed-width
 * footer buttons) and of the one security rule of the permission page: ONLY Next writes, and it writes `permissionMode` only.
 *
 * The ASSERT, on computed geometry, the DOM and the fake daemon (never a snapshot):
 *   1280 — on every page with cards: the cards share x and width and stack (y increases); the demo sits right of them
 *   (> 32 px gap) and its top is within 8 px of the first card's; the page text, card titles left out, is <= 160 characters;
 *   Back/Next are 136 px wide. Permission: no button in the page body; Skip + Next -> exactly one PUT whose YAML differs
 *   from the original in the `permissionMode` line alone; Auto (= saved) + Next -> no PUT; arrow keys -> no PUT; a refused
 *   write keeps the page, shows the reason, and the next Next writes once.
 *   390 — the demo is above the first card and <= 140 px tall; no sideways scroll; the footer buttons are inside the screen.
 *   Every page (the four above, the five import kind pages, the sign-in page) in both widths and both modes: the footer is
 *   Back, Later, Next, in that order, all the same width (136 px at 1280; equal thirds inside the screen at 390). The kind
 *   pages keep their checklist and draw the demo right of it (above it at 390). The sign-in slot draws no harness chooser
 *   (the detector is itself proved on a scene that draws one). From a saved Auto, picking Skip shows its warning and only
 *   Next sends one exact YAML change; an untouched saved Auto sends none. A read that becomes unreadable after a refused
 *   write drops the hidden pick; a file with a change held for the owner is never written.
 *
 * Set `FY_O4_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_O4_SHOTS_DIR ?? '';
const ORIGINAL = 'binary: /fake/bin/claude\npermissionMode: skip\nhostHistory: true\n';
const AUTO_ORIGINAL = 'binary: /fake/bin/claude\npermissionMode: auto\nhostHistory: true\n';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-o4-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/onboarding-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the onboarding scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;
const CARD_PAGES = ['import-choice', 'permission'] as const;
const KIND_PAGES = ['kind-settings', 'kind-model-set', 'kind-instructions', 'kind-skills', 'kind-mcp'] as const;
const DEMO_PAGES = [...CARD_PAGES, 'conversations', 'installed', ...KIND_PAGES] as const;
const FOOTER = ['Back', 'Later', 'Next'] as const;

type Tab = Awaited<ReturnType<Awaited<ReturnType<typeof sharedChromium>>['newPage']>>;
interface Fake {
  puts: { path: string; text: string }[];
  gets: number;
  advanced: boolean;
}

async function open(
  viewport: { readonly width: number; readonly height: number; readonly phone: boolean },
  theme: string,
  query: string,
) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=${theme}${query}`);
  await tab.locator('[data-onboarding-step]').waitFor({ state: 'visible' });
  return { tab, close: () => context.close() };
}

const fakeOf = (tab: Tab) => tab.evaluate(() => (window as unknown as { __fake: Fake }).__fake);
const lineDiff = (before: string, after: string): string[] =>
  after.split('\n').filter((line, index) => line !== before.split('\n')[index]);

describe('the Claude pages: stacked cards, the demo on the right, few words', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      for (const page of DEMO_PAGES)
        it(`${page}: layout at ${viewport.name}, ${theme}`, async () => {
          const { tab, close } = await open(viewport, theme, `&page=${page}`);
          try {
            await tab.waitForTimeout(1_800);
            const geometry = await tab.evaluate(() => {
              const rect = (el: Element) => el.getBoundingClientRect();
              const cards = [...document.querySelectorAll('[data-choice]')].map(el => rect(el));
              const demoEl = document.querySelector('[data-step-demo]') as Element;
              const demo = rect(demoEl);
              const body = document.querySelector('.cc-step') as HTMLElement;
              const titles = [...body.querySelectorAll('.fy-cc__title')].map(el => (el as HTMLElement).innerText);
              // A kind page keeps its checklist (the kit's list, whatever it holds): its WORDS are the lines it writes itself.
              const checklist = body.querySelector('input[type="checkbox"]') !== null;
              let text = (
                checklist
                  ? [...body.querySelectorAll('.cc-step__line')].map(el => (el as HTMLElement).innerText).join(' ')
                  : body.innerText
              ).replace(/\s+/g, ' ');
              for (const title of titles) text = text.replace(title, '');
              // The install command is data the installer sent, not words the page wrote.
              const command = body.querySelector('[data-install-command]')?.textContent?.replace(/\s+/g, ' ').trim();
              if (command !== undefined && command !== '') text = text.replace(command, '');
              return {
                cards: cards.map(c => ({ x: c.x, y: c.y, w: c.width, right: c.right, bottom: c.bottom })),
                demo: {
                  x: demo.x,
                  y: demo.y,
                  w: demo.width,
                  h: demo.height,
                  bottom: demo.bottom,
                  drawn: demo.height > 0,
                  /** What the demo draws past its box (the frame clips it at 140px on a phone): 0 when nothing is cut off. */
                  clipped: Math.max(0, (demoEl as HTMLElement).scrollHeight - (demoEl as HTMLElement).clientHeight),
                },
                step: { x: rect(body).x, y: rect(body).y, right: rect(body).right },
                checklist,
                buttons: [...document.querySelectorAll('[data-step-footer] button')].map(b => ({
                  label: (b as HTMLElement).innerText.trim(),
                  w: rect(b).width,
                  h: rect(b).height,
                  right: rect(b).right,
                })),
                text: text.trim(),
                scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                viewport: window.innerWidth,
              };
            });
            const { cards, demo, buttons } = geometry;
            expect(buttons.map(b => b.label)).toEqual([...FOOTER]);
            expect(Math.max(...buttons.map(b => b.w)) - Math.min(...buttons.map(b => b.w))).toBeLessThanOrEqual(1);
            if (page.startsWith('kind-')) expect(geometry.checklist, 'the kind page keeps its checklist').toBe(true);
            console.log(
              `O4 ${page} ${viewport.name} ${theme}: text ${String(geometry.text.length)} chars; cards ${String(cards.length)}; demo x ${String(Math.round(demo.x))} y ${String(Math.round(demo.y))} h ${String(Math.round(demo.h))}; first card right ${String(Math.round(cards[0]?.right ?? 0))} y ${String(Math.round(cards[0]?.y ?? 0))}; footer widths ${buttons.map(b => String(Math.round(b.w))).join('/')}`,
            );
            expect(demo.drawn, 'the demo is drawn in the frame’s demo column').toBe(true);
            expect(geometry.scrollX).toBeLessThanOrEqual(0);
            for (const button of buttons) expect(button.right).toBeLessThanOrEqual(geometry.viewport);
            expect(geometry.text.length, `page text: ${geometry.text}`).toBeLessThanOrEqual(160);
            for (const card of cards) {
              expect(Math.abs(card.x - (cards[0]?.x ?? 0))).toBeLessThanOrEqual(1);
              expect(Math.abs(card.w - (cards[0]?.w ?? 0))).toBeLessThanOrEqual(1);
            }
            for (let i = 1; i < cards.length; i += 1) expect(cards[i]?.y ?? 0).toBeGreaterThan(cards[i - 1]?.y ?? 0);
            if (!viewport.phone) {
              if (cards.length > 0) {
                expect(demo.x).toBeGreaterThan((cards[0]?.right ?? 0) + 32);
                expect(Math.abs(demo.y - (cards[0]?.y ?? 0))).toBeLessThanOrEqual(8);
              } else if (page.startsWith('kind-') || page === 'conversations') {
                expect(demo.x, 'the demo is right of the checklist').toBeGreaterThan(geometry.step.right + 16);
                expect(Math.abs(demo.y - geometry.step.y)).toBeLessThanOrEqual(8);
              }
              for (const button of buttons) expect(Math.abs(button.w - 136)).toBeLessThanOrEqual(1);
            } else {
              expect(demo.h).toBeLessThanOrEqual(140);
              expect(demo.clipped, 'nothing of the demo is cut off by the 140px limit').toBe(0);
              if (cards.length > 0) expect(demo.bottom).toBeLessThanOrEqual((cards[0]?.y ?? 0) + 1);
              else if (page.startsWith('kind-') || page === 'conversations')
                expect(demo.bottom).toBeLessThanOrEqual(geometry.step.y + 1);
              // The three footer buttons share the row inside the screen (equal thirds).
              expect(Math.min(...buttons.map(b => b.w))).toBeGreaterThan(80);
            }
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${page}-${viewport.name}-${theme}.png`) });
          } finally {
            await close();
          }
        });
});

/**
 * r11-1c C1: the Settings import page, the whole page frame (the flow's `.fy-sf-slot` content) with the kit's checklist cards in it.
 * "Page text" = the same count the gate makes on the real slot: the frame's innerText minus the card titles (group headings,
 * card labels) and nothing else but the page title, the footer buttons (outside the slot) and the demo (an aria-hidden
 * picture, outside the slot). The scanned key NAMES are counted. At most 160 characters at both widths; the same count is
 * asserted on the real flow's `.fy-sf-slot` in packages/app onboarding-e2e. The Environment-keys card's Vault paragraph
 * (190) was the main cost; it is one short line now, and the old sentences stay on it as its hover text. The strict count
 * (card titles out, title/footer/demo counted too) is logged for reference.
 */
describe('the Settings import page: the page text reads short', () => {
  for (const viewport of VIEWPORTS)
    it(`kind-settings: page text <= 160 characters at ${viewport.name}`, async () => {
      const { tab, close } = await open(viewport, 'studio-light', '&page=kind-settings');
      try {
        await tab.waitForTimeout(1_200);
        const { text, strict, hasKeysCard, vaultLine } = await tab.evaluate(() => {
          const page = document.querySelector('[data-step-page]') as HTMLElement;
          const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
          const without = (from: string, parts: readonly Element[]) => {
            let words = from;
            for (const part of parts) {
              const own = flat((part as HTMLElement).innerText);
              if (own !== '') words = words.replace(own, '');
            }
            return flat(words);
          };
          const titles = [...page.querySelectorAll('h4, .text-row')];
          const chrome = [...page.querySelectorAll('.fy-spf__title, [data-step-footer], [data-step-demo]')];
          return {
            text: without(flat(page.innerText), [...titles, ...chrome]),
            strict: without(flat(page.innerText), titles),
            hasKeysCard: page.querySelector('[data-found-locked]') !== null,
            vaultLine: (page.querySelector('[data-found-vault]') as HTMLElement | null)?.innerText ?? '',
          };
        });
        console.log(
          `C1 kind-settings ${viewport.name}: page text ${String(text.length)} chars (strict, demo/title/footer/keys counted: ${String(strict.length)}): ${text}`,
        );
        expect(hasKeysCard, 'the scene draws the Environment-keys card').toBe(true);
        expect(vaultLine.length, 'the Vault sentence is one short line').toBeLessThanOrEqual(40);
        expect(text.length, `page text: ${text}`).toBeLessThanOrEqual(160);
      } finally {
        await close();
      }
    });
});

describe('the permission page: only Next writes, and only permissionMode', () => {
  it('has no button of its own in the page body (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission');
    try {
      expect(await tab.locator('[data-step-page] .fy-spf__body button').count()).toBe(0);
      expect(await tab.locator('[data-permission-confirm]').count()).toBe(0);
      const text = await tab.evaluate(() => document.body.innerText);
      for (const old of ['Use Skip permissions', 'Keep Auto mode', 'Press “Use', 'Nothing is saved until'])
        expect(text).not.toContain(old);
    } finally {
      await close();
    }
  });

  for (const theme of THEMES)
    it(`Skip is selected: one line names the real flag; Auto + Next writes ONE put changing permissionMode only (${theme})`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], theme, '&page=permission');
      try {
        // Saved mode is skip (the scene's file): the warning is visible and names the flag.
        const warning = tab.locator('[data-permission-consequence="skip"]');
        await warning.waitFor({ state: 'visible' });
        expect(await warning.innerText()).toContain('--dangerously-skip-permissions');
        expect(await warning.innerText()).toContain('deleting files');
        // An arrow key moves the focus and writes nothing; Enter selects the focused card and still writes nothing.
        await tab.locator('input[type="radio"]:checked').focus();
        await tab.keyboard.press('ArrowUp');
        await tab.waitForTimeout(300);
        expect((await fakeOf(tab)).puts.length).toBe(0);
        await tab.keyboard.press('Enter');
        await tab.waitForTimeout(300);
        expect((await fakeOf(tab)).puts.length).toBe(0);
        expect(await tab.locator('input[value="auto"]').isChecked()).toBe(true);
        expect(await tab.locator('[data-permission-consequence="skip"]').count()).toBe(0);
        // Clicking back to Skip shows the warning again and still writes nothing.
        await tab.locator('[data-choice="skip"]').click();
        await warning.waitFor({ state: 'visible' });
        await tab.locator('[data-choice="auto"]').click();
        expect((await fakeOf(tab)).puts.length).toBe(0);
        await tab.locator('[data-step-next]').click();
        await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
        const { puts } = await fakeOf(tab);
        expect(puts.length).toBe(1);
        expect(puts[0]?.path).toBe('harness-claude-code.yaml');
        expect(lineDiff(ORIGINAL, puts[0]?.text ?? '')).toEqual(['permissionMode: auto']);
      } finally {
        await close();
      }
    });

  it('the saved mode + Next writes nothing (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission');
    try {
      await tab.locator('[data-choice="skip"]').waitFor({ state: 'visible' });
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect((await fakeOf(tab)).puts.length).toBe(0);
    } finally {
      await close();
    }
  });

  it('a pick and back to the saved card writes nothing (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission');
    try {
      await tab.locator('[data-choice="auto"]').click();
      await tab.locator('[data-choice="skip"]').click();
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect((await fakeOf(tab)).puts.length).toBe(0);
    } finally {
      await close();
    }
  });

  it('a refused write keeps the page, says why, and the next Next writes once (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission&save=fail');
    try {
      await tab.locator('[data-choice="auto"]').click();
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-flow-commit-error]').innerText()).toContain('refused');
      expect(await tab.locator('[data-choice-cards]').isVisible()).toBe(true);
      expect((await fakeOf(tab)).puts.length).toBe(0);
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect((await fakeOf(tab)).puts.length).toBe(1);
    } finally {
      await close();
    }
  });
});

describe('the conversations page: no choice, Next writes nothing', () => {
  it('draws one sentence and a generic demo, no card and no button; Next goes on without a write (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=conversations');
    try {
      expect(await tab.locator('[data-step-page] .fy-spf__body button').count()).toBe(0);
      expect(await tab.locator('[data-choice], input[type="radio"]').count()).toBe(0);
      expect(await tab.locator('[data-conversations-one-way]').count()).toBe(1);
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect((await fakeOf(tab)).puts.length).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('the installed page', () => {
  it('draws the command and one Install button, the demo on the right, no confirm paragraph (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=installed');
    try {
      await tab.locator('[data-install-command]').waitFor({ state: 'visible' });
      expect(await tab.getByRole('button', { name: 'Install Claude Code' }).count()).toBe(1);
      expect(await tab.locator('[data-step-demo] [data-demo="installed"]').count()).toBe(1);
    } finally {
      await close();
    }
  });
});

/** What a harness chooser looks like on a page: a radio or a choice card, or a button that names BOTH harnesses' tools. */
const chooserIn = (tab: Tab) =>
  tab.evaluate(() => {
    const body = document.querySelector('.cc-step') as HTMLElement;
    const text = body.innerText;
    return {
      choices: body.querySelectorAll('[role="radio"], input[type="radio"], [data-choice]').length,
      codex: /codex/i.test(text),
      buttons: body.querySelectorAll('button').length,
    };
  });

describe('the sign-in page: the slot draws no harness chooser', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`sign-in: one locked panel, no chooser, the footer is Back/Later/Next at ${viewport.name}, ${theme}`, async () => {
        const { tab, close } = await open(viewport, theme, '&page=sign-in');
        try {
          const found = await chooserIn(tab);
          console.log(
            `O4 sign-in ${viewport.name} ${theme}: choices ${String(found.choices)}; buttons ${String(found.buttons)}`,
          );
          expect(found.choices, 'no harness chooser in the slot').toBe(0);
          expect(found.codex, 'the page never names Codex').toBe(false);
          expect(found.buttons).toBe(1);
          const footer = await tab.evaluate(() =>
            [...document.querySelectorAll('[data-step-footer] button')].map(b => ({
              label: (b as HTMLElement).innerText.trim(),
              w: b.getBoundingClientRect().width,
              right: b.getBoundingClientRect().right,
            })),
          );
          expect(footer.map(b => b.label)).toEqual([...FOOTER]);
          const widths = footer.map(b => b.w);
          expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
          if (!viewport.phone) for (const w of widths) expect(Math.abs(w - 136)).toBeLessThanOrEqual(1);
          for (const b of footer) expect(b.right).toBeLessThanOrEqual(viewport.width);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `sign-in-${viewport.name}-${theme}.png`) });
        } finally {
          await close();
        }
      });

  // O10 Q2: the REAL page holds Next with a refusing save, never `busy()`, which would lock the whole footer.
  for (const viewport of [{ name: '1440', width: 1_440, height: 900, phone: false }, VIEWPORTS[1]] as const)
    for (const theme of THEMES)
      it(`sign-in (real page): Back and Later stay enabled, Next says why it stays, at ${viewport.name}, ${theme}`, async () => {
        const { tab, close } = await open(viewport, theme, '&page=sign-in&signin=real');
        try {
          await tab.waitForTimeout(600);
          const state = () =>
            tab.evaluate(() => ({
              buttons: [...document.querySelectorAll('[data-step-footer] button')].map(b => ({
                label: (b as HTMLElement).innerText.trim(),
                disabled: (b as HTMLButtonElement).disabled,
              })),
              note: document.querySelector('[data-flow-commit-error]')?.textContent ?? '',
            }));
          const before = await state();
          expect(before.buttons).toEqual([
            { label: 'Back', disabled: false },
            { label: 'Later', disabled: false },
            { label: 'Next', disabled: false },
          ]);
          await tab.getByRole('button', { name: 'Next' }).click();
          await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
          const after = await state();
          expect(after.note).toBe('Sign in to Claude to continue, or press Later.');
          expect(after.buttons.map(b => b.disabled)).toEqual([false, false, false]);
          expect(await tab.locator('[data-next-page]').count()).toBe(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `sign-in-real-${viewport.name}-${theme}.png`) });
        } finally {
          await close();
        }
      });

  it('catches a scene whose slot draws a harness chooser (the detector works)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=sign-in&signin=chooser');
    try {
      const found = await chooserIn(tab);
      expect(found.choices).toBeGreaterThan(0);
      expect(found.codex).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('the permission page from a saved Auto', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`Skip shows its warning; only Next writes ONE put, permissionMode: skip (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, '&page=permission-auto');
        try {
          await tab.locator('[data-choice="auto"]').waitFor({ state: 'visible' });
          expect(await tab.locator('input[value="auto"]').isChecked()).toBe(true);
          expect(await tab.locator('[data-permission-consequence]').count()).toBe(0);
          await tab.locator('[data-choice="skip"]').click();
          const warning = tab.locator('[data-permission-consequence="skip"]');
          await warning.waitFor({ state: 'visible' });
          const said = await warning.innerText();
          expect(said).toContain('--dangerously-skip-permissions');
          expect(said).toContain('deleting files');
          // Nothing is sent by the pick itself, nor by moving the focus.
          await tab.keyboard.press('ArrowUp');
          await tab.waitForTimeout(300);
          expect((await fakeOf(tab)).puts.length).toBe(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `permission-skip-from-auto-${viewport.name}-${theme}.png`) });
          await tab.locator('[data-choice="skip"]').click();
          await tab.locator('[data-step-next]').click();
          await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
          const { puts } = await fakeOf(tab);
          expect(puts.length).toBe(1);
          expect(lineDiff(AUTO_ORIGINAL, puts[0]?.text ?? '')).toEqual(['permissionMode: skip']);
        } finally {
          await close();
        }
      });

  it('an untouched saved Auto + Next writes nothing (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission-auto');
    try {
      await tab.locator('[data-choice="auto"]').waitFor({ state: 'visible' });
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect((await fakeOf(tab)).puts.length).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('a read that stops being readable, and a file with a held change', () => {
  it('after a refused write the withheld re-read drops the hidden pick: a later Next writes nothing (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission&save=fail&reread=withheld');
    try {
      await tab.locator('[data-choice="auto"]').click();
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-flow-commit-error]').innerText()).toContain('refused');
      // The next Next reads the file afresh: it is withheld now, the cards go, and so does the pick.
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-mode-unknown]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-choice]').count()).toBe(0);
      const reads = (await fakeOf(tab)).gets;
      // The file reads again (the scene serves it): the hidden Auto pick must NOT be written by the next Next.
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      const after = await fakeOf(tab);
      console.log(
        `O4 stale commit: reads ${String(reads)} -> ${String(after.gets)}; puts ${String(after.puts.length)}`,
      );
      expect(after.puts.length, 'the hidden pick was never written').toBe(0);
      expect(after.gets).toBe(reads);
    } finally {
      await close();
    }
  });

  it('a held change: the waiting line replaces the cards, Next re-reads and writes nothing while it is held (1280 and 390)', async () => {
    for (const viewport of VIEWPORTS) {
      const { tab, close } = await open(viewport, 'studio-light', '&page=permission&read=pending');
      try {
        await tab.locator('[data-config-waiting]').waitFor({ state: 'visible' });
        expect(await tab.locator('[data-config-waiting]').innerText()).toContain('waiting for your OK');
        expect(await tab.locator('[data-choice]').count()).toBe(0);
        await tab.locator('[data-step-next]').click();
        await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
        expect(await tab.locator('[data-flow-commit-error]').innerText()).toContain('waiting for your OK');
        const fake = await fakeOf(tab);
        console.log(`O4 held ${viewport.name}: reads ${String(fake.gets)}, puts ${String(fake.puts.length)}`);
        expect(fake.gets, 'Next read the file again').toBe(2);
        expect(fake.puts.length).toBe(0);
        expect(fake.advanced, 'the page stays while it is held').toBe(false);
      } finally {
        await close();
      }
    }
  });

  it('a held change the owner then confirms: Next re-reads, the cards appear, and one pick + Next writes exactly one PUT (1280 and 390)', async () => {
    for (const viewport of VIEWPORTS) {
      const { tab, close } = await open(viewport, 'studio-light', '&page=permission-auto&read=pending-once');
      try {
        await tab.locator('[data-config-waiting]').waitFor({ state: 'visible' });
        await tab.locator('[data-step-next]').click();
        await tab.locator('[data-choice]').first().waitFor({ state: 'visible' });
        expect(await tab.locator('[data-config-waiting]').count()).toBe(0);
        const mid = await fakeOf(tab);
        console.log(
          `O4 held-then-confirmed ${viewport.name}: reads ${String(mid.gets)}, puts ${String(mid.puts.length)}`,
        );
        expect(mid.gets, 'Next re-read the file').toBe(2);
        expect(mid.puts.length, 'nothing written by that Next').toBe(0);
        expect(mid.advanced).toBe(false);
        await tab.locator('[data-choice="skip"]').click();
        await tab.locator('[data-step-next]').click();
        await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
        const end = await fakeOf(tab);
        expect(end.puts.length, 'the pick writes once').toBe(1);
        expect(lineDiff(AUTO_ORIGINAL, end.puts[0]?.text ?? '')).toEqual(['permissionMode: skip']);
      } finally {
        await close();
      }
    }
  });
});

describe('the demos say what they show', () => {
  it('the install demo types the command the page shows, not a version check (1280, 390)', async () => {
    for (const viewport of VIEWPORTS) {
      const { tab, close } = await open(viewport, 'studio-light', '&page=installed');
      try {
        await tab.locator('[data-install-command]').waitFor({ state: 'visible' });
        const shown = (await tab.locator('[data-install-command]').innerText()).trim();
        const typed = (await tab.locator('[data-demo-command]').textContent())?.trim();
        expect(typed).toBe(shown);
        expect(typed).not.toContain('--version');
        // Once typed, every glyph of the command lies inside the box the reveal clips to (a long one wraps, never cut).
        await tab.waitForTimeout(1_600);
        const fit = await tab.evaluate(() => {
          const cmd = document.querySelector('[data-demo-command]') as HTMLElement;
          const box = cmd.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(cmd);
          const text = range.getBoundingClientRect();
          const term = (cmd.closest('[data-demo="installed"]') as HTMLElement).getBoundingClientRect();
          return {
            below: text.bottom - box.bottom,
            right: text.right - box.right,
            inside: text.right <= term.right && text.left >= term.left,
            lines: Math.round(box.height / Number.parseFloat(getComputedStyle(cmd).lineHeight)),
          };
        });
        console.log(`O4 install demo ${String(viewport.width)}: command lines ${String(fit.lines)}`);
        expect(fit.below).toBeLessThanOrEqual(1);
        expect(fit.right).toBeLessThanOrEqual(1);
        expect(fit.inside).toBe(true);
        if (viewport.phone) expect(fit.lines, 'a long command wraps on a phone').toBeGreaterThanOrEqual(2);
      } finally {
        await close();
      }
    }
  });

  it('Choose what to import labels its two ticked items as an example; the other answers do not (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=import-choice');
    try {
      await tab.locator('[data-choice="choose"]').click();
      await tab.locator('[data-demo="import-choose"] [data-demo-example]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-demo-example]').innerText()).toContain('example');
      await tab.locator('[data-choice="everything"]').click();
      await tab.locator('[data-demo="import-everything"]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-demo-example]').count()).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('C59 O5 item 6 / O11 R5 S-25: the sign-in page (heading and block) sits in the vertical middle of a desktop page', () => {
  for (const theme of THEMES)
    it(`the free room above and below the block is the same, desktop only (1280, ${theme}); a phone keeps it at the top`, async () => {
      const measure = async (viewport: (typeof VIEWPORTS)[number]) => {
        const { tab, close } = await open(viewport, theme, '&page=sign-in');
        try {
          await tab.waitForTimeout(300);
          return await tab.evaluate(() => {
            const head = document.querySelector('.fy-spf__head') as HTMLElement;
            const main = document.querySelector('.fy-spf__main') as HTMLElement;
            const page = document.querySelector('.fy-spf__page') as HTMLElement;
            const progress = document.querySelector('.fy-sp-progress');
            const style = getComputedStyle(page);
            const gap = Number.parseFloat(style.rowGap);
            // O11 R5 (S-25): the heading AND the block are centred together, in the room under the progress bar.
            const top =
              progress === null
                ? page.getBoundingClientRect().top + Number.parseFloat(style.paddingTop)
                : progress.getBoundingClientRect().bottom + gap;
            const above = head.getBoundingClientRect().top - top;
            const below =
              page.getBoundingClientRect().bottom -
              Number.parseFloat(style.paddingBottom) -
              main.getBoundingClientRect().bottom;
            return { above, below };
          });
        } finally {
          await close();
        }
      };
      const desktop = await measure(VIEWPORTS[0]);
      const phone = await measure(VIEWPORTS[1]);
      console.log(
        `O5 sign-in centring ${theme}: desktop above ${String(desktop.above)} below ${String(desktop.below)}; phone above ${String(phone.above)} below ${String(phone.below)}`,
      );
      expect(desktop.above).toBeGreaterThan(8);
      expect(Math.abs(desktop.above - desktop.below)).toBeLessThanOrEqual(2);
      // A phone keeps the heading at the top (the block under it).
      expect(phone.above).toBeLessThanOrEqual(1);
    });
});

describe('audit row: Install is as wide as the command it runs', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`the Install button and the command share a width (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, '&page=installed');
        try {
          await tab.locator('[data-install-run]').waitFor({ state: 'visible' });
          const facts = await tab.evaluate(() => {
            const w = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
            return {
              button: { left: w('[data-install-run]').left, w: w('[data-install-run]').width },
              command: { left: w('[data-install-command]').left, w: w('[data-install-command]').width },
            };
          });
          console.log(
            `O5 install ${viewport.name} ${theme}: button ${String(facts.button.w)} command ${String(facts.command.w)}`,
          );
          expect(Math.abs(facts.button.w - facts.command.w)).toBeLessThanOrEqual(1);
          expect(Math.abs(facts.button.left - facts.command.left)).toBeLessThanOrEqual(1);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `install-${viewport.name}-${theme}.png`) });
        } finally {
          await close();
        }
      });
});
