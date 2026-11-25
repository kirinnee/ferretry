/**
 * "CONTINUE A PAST CONVERSATION" ON THE NEW FERRET PAGE, in a real browser (O8-12). The REAL New ferret page with the REAL
 * Conversation panel in its slot (`fixtures/new-ferret-continue-scene.tsx`), over the rows the REAL conversation index made from
 * synthetic transcripts held in memory (no real ~/.claude or ~/.codex is read).
 *
 * The owner's line: "when starting a new ferret, offer to continue a conversation; mix it together; no Conversations tab".
 * As computed DOM, at 1440 and 390, light and dark:
 *  - the offer is on the New ferret page itself, closed until opened, with the fresh form still below it (one page, one flow);
 *  - opened, it lists the conversations newest first with title, folder, harness and age, and an empty daemon says so;
 *  - picking one fills the Folder box, limits the runtime field to its harness, keeps the auto|interactive choice, and Create
 *    POSTs a start that names that conversation id (`harnessConversation`), which the daemon resumes.
 *
 * Set `FY_O8_12_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { LinkableConversation } from '../../../contract/index.ts';
import { ConversationIndex, type IndexSource } from '../../../daemon/links/lib/conversation-index.ts';
import { claudeRecord, codexRollout, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_O8_12_SHOTS_DIR ?? '';

const LOGIN = '3b1a4a52-0000-4000-8000-0000000000a1';
const DEPLOY = '3b1a4a52-0000-4000-8000-0000000000b2';
const CODEX = '3b1a4a52-0000-4000-8000-0000000000c3';

/** Three synthetic conversations, made by the real index: two of Claude Code (one kept by a ferret) and one of Codex. */
const makeRows = async (): Promise<readonly LinkableConversation[]> => {
  const claude = new MemoryHistory();
  const codex = new MemoryHistory();
  const talk = (text: string, at: string, cwd: string) =>
    `${claudeRecord('user', text, at, cwd)}\n${claudeRecord('assistant', 'ok', at, cwd)}\n`;
  claude.set(
    `projects/-work-app/${LOGIN}.jsonl`,
    `${talk('please look at the login test', '2026-10-12T09:00:00.000Z', '/work/app')}${JSON.stringify({ type: 'ai-title', aiTitle: 'Fix flaky login test' })}\n`,
  );
  claude.set(
    `projects/-work-ops/${DEPLOY}.jsonl`,
    talk('can you look at why the deploy script fails on mac?', '2026-10-10T09:00:00.000Z', '/work/ops'),
  );
  codex.set(
    `sessions/2026/10/11/rollout-2026-10-11T09-00-00-${CODEX}.jsonl`,
    codexRollout(CODEX, '/work/api', 'add pagination to the orders endpoint', '2026-10-11T09:00:00.000Z'),
  );
  const sources: IndexSource[] = [
    { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: claude },
    { harness: 'codex', parser: 'codex', kind: 'computer', label: 'owner', files: codex },
  ];
  const index = new ConversationIndex({
    sqlite: () => memorySqlite(),
    sources: async () => sources,
    ferretNames: async () => new Map(),
    parsers: PARSERS,
    nowMs: () => 0,
  });
  await index.refresh();
  return index.query().conversations.map(found => found.row);
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let rowsJson = '[]';
/** The same rows, two of them named alike: a long shared start and only the end tells them apart (L200b). */
let similarRowsJson = '[]';
const SIMILAR_START = 'Refactor the checkout service so every payment retry reuses its idempotency key and logs why';
const SIMILAR_ENDS = [' (staging rollout)', ' (production rollout)'] as const;
let rowIds: readonly string[] = [];

beforeAll(async () => {
  const rows = await makeRows();
  rowsJson = JSON.stringify(rows);
  similarRowsJson = JSON.stringify(
    rows.map(row =>
      row.id === LOGIN
        ? { ...row, name: SIMILAR_START + SIMILAR_ENDS[0] }
        : row.id === DEPLOY
          ? { ...row, name: SIMILAR_START + SIMILAR_ENDS[1] }
          : row,
    ),
  );
  rowIds = rows.map(row => row.id);
  directory = await mkdtemp(join(tmpdir(), 'ferretry-new-ferret-continue-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/new-ferret-continue-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/rows.json')
        return new Response(new URL(request.url).searchParams.has('similar') ? similarRowsJson : rowsJson, {
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1440', width: 1_440, height: 1_000, phone: false },
  { name: '390', width: 390, height: 900, phone: true },
] as const;
type Variant = (typeof VARIANTS)[number];

const SWITCH = '[data-new-ferret-switch]';
const NEW_CHOICE = `${SWITCH} [role="radio"]:nth-child(1)`;
const CONTINUE_CHOICE = `${SWITCH} [role="radio"]:nth-child(2)`;

interface Recorded {
  route: string;
  body: unknown;
}

const withPage = async (
  variant: Variant,
  scheme: 'light' | 'dark',
  query: string,
  run: (tab: Page) => Promise<void>,
): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    colorScheme: scheme,
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
  });
  try {
    const origin = server?.url.origin ?? '';
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    const tab = await context.newPage();
    tab.setDefaultTimeout(15_000);
    await tab.goto(`${origin}/?theme=studio-${scheme}${query}`);
    await tab.waitForSelector(SWITCH);
    await run(tab);
  } finally {
    await context.close();
  }
};

const shot = async (tab: Page, variant: Variant, scheme: string, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await tab.screenshot({ path: join(shotsDir, `${variant.name}-${scheme}-${name}.png`), fullPage: true });
};

const noSideways = async (tab: Page): Promise<void> => {
  const widths = await tab.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(widths.client);
};

describe('New ferret: continue a past conversation', () => {
  for (const variant of VARIANTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`${variant.name} ${scheme}: one page: a New | Continue switch sits above the form; New is on, Continue shows the list`, () =>
        withPage(variant, scheme, '', async tab => {
          const fresh = await tab.evaluate(
            ([switchSelector, newSelector, continueSelector]) => {
              const group = document.querySelector<HTMLElement>(switchSelector as string) as HTMLElement;
              const form = document.querySelector<HTMLElement>('#fy-new-ferret-runtime') as HTMLElement;
              const choices = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
              return {
                checked: choices.map(choice => choice.getAttribute('aria-checked')),
                groupTop: group.getBoundingClientRect().top,
                formTop: form.getBoundingClientRect().top,
                listed: document.querySelectorAll('[data-continue-row]').length,
                heights: choices.map(choice => choice.getBoundingClientRect().height),
                folded: document.querySelectorAll('[data-new-ferret-continue] [aria-expanded]').length,
                newFound: document.querySelector(newSelector as string) !== null,
                continueFound: document.querySelector(continueSelector as string) !== null,
              };
            },
            [SWITCH, NEW_CHOICE, CONTINUE_CHOICE],
          );
          // Their names are the full words at every width, whatever a phone shows of them (see the one-line test below).
          await tab.getByRole('radio', { name: 'New conversation' }).waitFor();
          await tab.getByRole('radio', { name: 'Continue a conversation' }).waitFor();
          expect(fresh.checked, 'New conversation is on to begin with').toEqual(['true', 'false']);
          expect(fresh.groupTop, 'the switch sits above the form, on the same page').toBeLessThan(fresh.formTop);
          expect(fresh.listed, 'New: no list').toBe(0);
          expect(fresh.folded, 'no folded disclosure any more').toBe(0);
          for (const height of fresh.heights) expect(height, 'a finger-sized target').toBeGreaterThanOrEqual(44);
          await shot(tab, variant, scheme, 'new');

          await tab.click(CONTINUE_CHOICE);
          await tab.waitForSelector('[data-continue-row]');
          expect(await tab.getAttribute(CONTINUE_CHOICE, 'aria-checked')).toBe('true');
          const open = await tab.evaluate(() => ({
            ids: [...document.querySelectorAll('[data-continue-row]')].map(row =>
              row.getAttribute('data-continue-row'),
            ),
            text: document.querySelector('[data-continue-conversation]')?.textContent ?? '',
            formStillThere: document.querySelector('#fy-new-ferret-prompt') !== null,
          }));
          // Newest first: the login test (Oct 12), the Codex orders thread (Oct 11), the deploy script (Oct 10).
          expect(open.ids).toEqual([LOGIN, CODEX, DEPLOY]);
          expect(open.text).toContain('Fix flaky login test');
          expect(open.text).toContain('Codex');
          expect(open.text).toContain('Claude');
          expect(open.formStillThere, 'the fresh form is still on the same page').toBe(true);
          await noSideways(tab);
          await shot(tab, variant, scheme, 'continue');
          await tab.click(NEW_CHOICE);
          expect(await tab.evaluate(() => document.querySelector('[data-continue-row]') !== null)).toBe(false);
        }));

      it(`${variant.name} ${scheme}: each choice of the switch is ONE line, and a phone shows New | Continue`, () =>
        withPage(variant, scheme, '', async tab => {
          const seen = await tab.evaluate(selector => {
            const group = document.querySelector<HTMLElement>(selector) as HTMLElement;
            return [...group.querySelectorAll<HTMLElement>('[role="radio"]')].map(choice => {
              // The visible words only: the screen-reader-only spelling is clipped to a pixel and aria-hidden ones are shown.
              const shown = [...choice.querySelectorAll<HTMLElement>('span')].filter(
                part => part.getBoundingClientRect().width > 2 && getComputedStyle(part).display !== 'none',
              );
              // A clipped phrase keeps its text box at full size, so only what a reader sees is measured.
              const range = document.createRange();
              const tops = new Set<number>();
              for (const part of shown) {
                range.selectNodeContents(part);
                for (const box of range.getClientRects()) if (box.width > 2) tops.add(Math.round(box.top));
              }
              return { visible: shown.map(part => part.textContent).join(' ') || choice.textContent, lines: tops.size };
            });
          }, SWITCH);
          for (const choice of seen) expect(choice.lines, `"${choice.visible}" wraps`).toBe(1);
          expect(seen.map(choice => choice.visible)).toEqual(
            variant.phone ? ['New', 'Continue'] : ['New conversation', 'Continue a conversation'],
          );
          expect(await tab.getByRole('radio', { name: 'New conversation' }).count()).toBe(1);
          expect(await tab.getByRole('radio', { name: 'Continue a conversation' }).count()).toBe(1);
          await shot(tab, variant, scheme, 'switch');
        }));

      it(`${variant.name} ${scheme}: an empty daemon says so inside the open offer`, () =>
        withPage(variant, scheme, '&empty=1', async tab => {
          await tab.click(CONTINUE_CHOICE);
          await tab.waitForSelector('[data-continue-empty]');
          expect(await tab.textContent('[data-continue-empty]')).toBe('No past conversations yet.');
          await noSideways(tab);
          await shot(tab, variant, scheme, 'empty');
        }));

      it(`${variant.name} ${scheme}: picking a conversation fills the form, and Create resumes THAT conversation`, () =>
        withPage(variant, scheme, '', async tab => {
          await tab.click(CONTINUE_CHOICE);
          await tab.waitForSelector(`[data-continue-row="${LOGIN}"]`);
          await tab.click(`[data-continue-row="${LOGIN}"]`);
          await tab.waitForSelector('[data-continue-action]');
          await tab.click('[data-continue-action]');
          await tab.waitForSelector('[data-new-ferret-picked]');
          const picked = await tab.evaluate(() => ({
            chip: document.querySelector('[data-new-ferret-picked]')?.textContent ?? '',
            listOpen: document.querySelector('[data-continue-row]') !== null,
            folder: document.querySelector<HTMLInputElement>('#fy-new-ferret-folder')?.value,
            harness: (window as unknown as { __harness?: string }).__harness,
            modeButtons: [...document.querySelectorAll('[aria-label="Ferret mode"] button')].map(
              button => button.textContent,
            ),
          }));
          expect(picked.chip).toContain('Fix flaky login test');
          expect(picked.listOpen, 'the list folds away once a conversation is picked').toBe(false);
          expect(picked.folder, 'the folder comes from the conversation').toBe('/work/app');
          expect(picked.harness, 'the runtime field is limited to the conversation’s harness').toBe('claude-code');
          expect(picked.modeButtons, 'the auto|interactive choice is still there').toEqual(['auto', 'interactive']);
          await noSideways(tab);
          await shot(tab, variant, scheme, 'picked');

          await tab.fill('#fy-new-ferret-runtime', 'claude-default');
          await tab.fill('#fy-new-ferret-prompt', 'Carry on with the fix');
          await tab.getByRole('button', { name: 'Create ferret' }).click();
          await tab.waitForFunction(() => window.location.pathname !== '/d/fake/new');
          const starts = await tab.evaluate(() =>
            (window as unknown as { __calls: Recorded[] }).__calls.filter(call => call.route === 'POST /v1/ferrets'),
          );
          expect(starts).toHaveLength(1);
          expect(starts[0]?.body).toMatchObject({
            runtime: 'claude-default',
            folder: '/work/app',
            mode: 'auto',
            prompt: 'Carry on with the fix',
            harnessConversation: LOGIN,
            harness: 'claude-code',
          });
          // The fake daemon is honest: it resumes a conversation only when its index holds it for that harness, and the
          // ferret it answers with is the resumed one (`resumed-1`), never a fresh one (`fresh-1`).
          expect(
            await tab.evaluate(() => (window as unknown as { __resumed?: string }).__resumed),
            'the daemon resumed the ORIGINAL conversation',
          ).toBe(LOGIN);
          expect(await tab.evaluate(() => window.location.pathname), 'it opens the resumed ferret’s chat').toBe(
            '/d/fake/ferrets/resumed-1/chat',
          );
        }));
    }

  // L200b: a title that ends in an ellipsis hides the one part that tells two alike conversations apart.
  for (const scheme of ['light', 'dark'] as const)
    it(`390 ${scheme}: two alike titles both show their ending on a phone (they wrap; the age stays compact)`, () =>
      withPage(VARIANTS[1], scheme, '&similar=1', async tab => {
        await tab.click(CONTINUE_CHOICE);
        await tab.waitForSelector('[data-continue-row]');
        const titles = await tab.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-continue-row] .fy-convo-title')].map(title => {
            const age = title.parentElement?.querySelector<HTMLElement>('.fy-convo-age')?.getBoundingClientRect();
            const line = Number.parseFloat(getComputedStyle(title).lineHeight);
            return {
              text: title.textContent ?? '',
              clippedAcross: title.scrollWidth > title.clientWidth + 1,
              clippedDown: title.scrollHeight > title.clientHeight + 1,
              lines: Math.round(title.getBoundingClientRect().height / (Number.isFinite(line) ? line : 20)),
              ageWidth: age?.width ?? 0,
            };
          }),
        );
        const alike = titles.filter(title => title.text.startsWith(SIMILAR_START));
        expect(alike, 'both alike titles are listed').toHaveLength(2);
        for (const title of alike) {
          expect(title.clippedAcross, `"${title.text}" is cut off sideways`).toBe(false);
          expect(title.clippedDown, `"${title.text}" is cut off below`).toBe(false);
          expect(title.lines, `"${title.text}" wraps onto more than one line`).toBeGreaterThan(1);
          expect(title.ageWidth, 'the age stays compact').toBeLessThan(80);
        }
        await noSideways(tab);
        await shot(tab, VARIANTS[1], scheme, 'alike-titles');
      }));

  it('a runtime typed for the OTHER harness is refused by the daemon and says why; nothing is resumed or opened', () =>
    withPage(VARIANTS[0], 'light', '', async tab => {
      await tab.click(CONTINUE_CHOICE);
      await tab.click(`[data-continue-row="${CODEX}"]`);
      await tab.click('[data-continue-action]');
      await tab.waitForSelector('[data-new-ferret-picked]');
      // The runtime box is typed by hand, so it can name a Claude Code runtime although a Codex conversation is picked.
      await tab.fill('#fy-new-ferret-runtime', 'claude-default');
      await tab.fill('#fy-new-ferret-prompt', 'Carry on');
      await tab.getByRole('button', { name: 'Create ferret' }).click();
      await tab.waitForSelector('[role="alert"]');
      expect(await tab.textContent('[role="alert"]')).toContain('runs the claude-code harness, not codex');
      expect(await tab.evaluate(() => (window as unknown as { __resumed?: string }).__resumed)).toBeUndefined();
      expect(await tab.evaluate(() => window.location.pathname), 'no ferret was opened').toBe('/d/fake/new');
    }));

  it('`?continue=1` opens New ferret with the list already shown (the Runtimes and setup links)', () =>
    withPage(VARIANTS[0], 'light', '&continue=1', async tab => {
      await tab.waitForSelector('[data-continue-row]');
      expect(await tab.getAttribute(CONTINUE_CHOICE, 'aria-checked')).toBe('true');
    }));

  it('a Codex pick names Codex and its own conversation id; switching back to New conversation starts without one', () =>
    withPage(VARIANTS[0], 'light', '', async tab => {
      await tab.click(CONTINUE_CHOICE);
      await tab.click(`[data-continue-row="${CODEX}"]`);
      await tab.click('[data-continue-action]');
      await tab.waitForSelector('[data-new-ferret-picked]');
      expect(await tab.evaluate(() => (window as unknown as { __harness?: string }).__harness)).toBe('codex');
      await tab.click(NEW_CHOICE);
      expect(await tab.evaluate(() => (window as unknown as { __harness?: string }).__harness)).toBeUndefined();
      expect(await tab.inputValue('#fy-new-ferret-folder')).toBe('');
      expect(rowIds).toContain(CODEX);
    }));

  for (const variant of VARIANTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`${variant.name} ${scheme}: the switch is a labelled radio group with ONE Tab stop, and the arrow keys move the choice with visible focus`, () =>
        withPage(variant, scheme, '', async tab => {
          expect(await tab.getAttribute(SWITCH, 'role')).toBe('radiogroup');
          expect(await tab.getAttribute(SWITCH, 'aria-label')).toBe('New or continue');
          const stops = () =>
            tab.evaluate(
              selector =>
                [...document.querySelectorAll(`${selector} [role="radio"]`)].map(radio =>
                  radio.getAttribute('tabindex'),
                ),
              SWITCH,
            );
          expect(await stops(), 'only the chosen segment is a Tab stop').toEqual(['0', '-1']);
          // Tab into the group from the heading's back button: it lands on the chosen segment, and one more Tab leaves it.
          await tab.focus('button:has-text("← Home")');
          await tab.keyboard.press('Tab');
          expect(await tab.evaluate(() => document.activeElement?.getAttribute('data-segment'))).toBe('new');
          await tab.keyboard.press('ArrowRight');
          expect(await tab.evaluate(() => document.activeElement?.getAttribute('data-segment')), 'focus follows').toBe(
            'continue',
          );
          expect(await tab.getAttribute(CONTINUE_CHOICE, 'aria-checked'), 'ArrowRight selects Continue').toBe('true');
          await tab.waitForSelector('[data-continue-row]');
          expect(await stops()).toEqual(['-1', '0']);
          await shot(tab, variant, scheme, 'keyboard-focus');
          const ring = await tab.evaluate(selector => {
            const style = getComputedStyle(document.querySelector(selector) as Element);
            return { style: style.outlineStyle, width: style.outlineWidth };
          }, CONTINUE_CHOICE);
          expect(ring.style, 'the focused segment shows a ring').not.toBe('none');
          expect(Number.parseFloat(ring.width)).toBeGreaterThan(0);
          await tab.keyboard.press('ArrowRight');
          expect(await tab.getAttribute(NEW_CHOICE, 'aria-checked'), 'it wraps back to New').toBe('true');
          await tab.keyboard.press('ArrowLeft');
          expect(await tab.getAttribute(CONTINUE_CHOICE, 'aria-checked')).toBe('true');
          await tab.keyboard.press('Home');
          expect(await tab.getAttribute(NEW_CHOICE, 'aria-checked')).toBe('true');
          await tab.keyboard.press('Tab');
          expect(
            await tab.evaluate(selector => document.activeElement?.closest(selector) === null, SWITCH),
            'one Tab leaves the group',
          ).toBe(true);
        }));

  for (const variant of VARIANTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`${variant.name} ${scheme}: Continue with NO pick cannot start a ferret: Create is disabled and says why; a pick frees it`, () =>
        withPage(variant, scheme, '&continue=1&folder=/work/prefilled', async tab => {
          await tab.waitForSelector('[data-continue-row]');
          await tab.fill('#fy-new-ferret-runtime', 'claude-default');
          await tab.fill('#fy-new-ferret-prompt', 'Start something');
          const create = tab.getByRole('button', { name: 'Create ferret' });
          expect(await create.isDisabled(), 'Create is disabled until a conversation is picked').toBe(true);
          expect(await tab.textContent('#fy-new-ferret-create-blocker')).toBe('Pick a conversation to continue.');
          await tab.locator('#fy-new-ferret-create-blocker').scrollIntoViewIfNeeded();
          await shot(tab, variant, scheme, 'continue-no-pick');
          await create.click({ force: true }).catch(() => undefined);
          expect(
            await tab.evaluate(
              () =>
                (window as unknown as { __calls: Recorded[] }).__calls.filter(call => call.route === 'POST /v1/ferrets')
                  .length,
            ),
            'nothing was started',
          ).toBe(0);
          expect(await tab.evaluate(() => window.location.pathname)).toBe('/d/fake/new');
          await tab.click(`[data-continue-row="${LOGIN}"]`);
          await tab.click('[data-continue-action]');
          await tab.waitForSelector('[data-new-ferret-picked]');
          // The pick's harness clears a runtime chosen before it, so the runtime is named again; then Create is free.
          await tab.fill('#fy-new-ferret-runtime', 'claude-default');
          expect(await create.isDisabled(), 'a pick frees Create').toBe(false);
        }));

  it('New → Continue → New with NO pick keeps the Folder, the ?folder= prefill included', () =>
    withPage(VARIANTS[0], 'light', '&folder=/work/prefilled', async tab => {
      expect(await tab.inputValue('#fy-new-ferret-folder')).toBe('/work/prefilled');
      await tab.click(CONTINUE_CHOICE);
      await tab.waitForSelector('[data-continue-row]');
      await tab.click(NEW_CHOICE);
      expect(await tab.inputValue('#fy-new-ferret-folder'), 'the prefill survives a trip with no pick').toBe(
        '/work/prefilled',
      );
      await tab.fill('#fy-new-ferret-folder', '/work/typed');
      await tab.click(CONTINUE_CHOICE);
      await tab.click(NEW_CHOICE);
      expect(await tab.inputValue('#fy-new-ferret-folder'), 'a typed folder survives it too').toBe('/work/typed');
    }));
});
