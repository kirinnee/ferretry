/**
 * "CONTINUE A PAST CONVERSATION" ON THE NEW FERRET PAGE, in a real browser (O8-12). The REAL New ferret page with the REAL
 * Conversation panel in its slot (`fixtures/new-ferret-continue-scene.tsx`), over the rows the REAL conversation index made from
 * synthetic transcripts held in memory (no real ~/.claude or ~/.codex is read).
 *
 * The owner's line: "when starting a new ferret, offer to continue a conversation; mix it together; no Conversations tab".
 * As computed DOM, at 1280 and 390, light and dark:
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
let rowIds: readonly string[] = [];

beforeAll(async () => {
  const rows = await makeRows();
  rowsJson = JSON.stringify(rows);
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
      if (path === '/rows.json') return new Response(rowsJson, { headers: { 'content-type': 'application/json' } });
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
  { name: '1280', width: 1_280, height: 1_000, phone: false },
  { name: '390', width: 390, height: 900, phone: true },
] as const;
type Variant = (typeof VARIANTS)[number];

const DISCLOSURE = '[data-new-ferret-continue] button[aria-expanded]';

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
    await tab.waitForSelector(DISCLOSURE);
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
      it(`${variant.name} ${scheme}: one page: the offer is closed above the fresh form, and opens to the list`, () =>
        withPage(variant, scheme, '', async tab => {
          const closed = await tab.evaluate(selector => {
            const button = document.querySelector<HTMLElement>(selector) as HTMLElement;
            const form = document.querySelector<HTMLElement>('#fy-new-ferret-runtime') as HTMLElement;
            return {
              expanded: button.getAttribute('aria-expanded'),
              label: button.textContent ?? '',
              buttonTop: button.getBoundingClientRect().top,
              formTop: form.getBoundingClientRect().top,
              listed: document.querySelectorAll('[data-continue-row]').length,
              height: button.getBoundingClientRect().height,
            };
          }, DISCLOSURE);
          expect(closed.expanded).toBe('false');
          expect(closed.label).toContain('Continue a past conversation');
          expect(closed.buttonTop, 'the offer sits above the form, on the same page').toBeLessThan(closed.formTop);
          expect(closed.listed, 'closed: no list yet').toBe(0);
          expect(closed.height, 'a finger-sized target').toBeGreaterThanOrEqual(44);
          await shot(tab, variant, scheme, 'closed');

          await tab.click(DISCLOSURE);
          await tab.waitForSelector('[data-continue-row]');
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
          await shot(tab, variant, scheme, 'list');
        }));

      it(`${variant.name} ${scheme}: an empty daemon says so inside the open offer`, () =>
        withPage(variant, scheme, '&empty=1', async tab => {
          await tab.click(DISCLOSURE);
          await tab.waitForSelector('[data-continue-empty]');
          expect(await tab.textContent('[data-continue-empty]')).toBe('No past conversations yet.');
          await noSideways(tab);
          await shot(tab, variant, scheme, 'empty');
        }));

      it(`${variant.name} ${scheme}: picking a conversation fills the form, and Create resumes THAT conversation`, () =>
        withPage(variant, scheme, '', async tab => {
          await tab.click(DISCLOSURE);
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

  it('a runtime typed for the OTHER harness is refused by the daemon and says why; nothing is resumed or opened', () =>
    withPage(VARIANTS[0], 'light', '', async tab => {
      await tab.click(DISCLOSURE);
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
      expect(await tab.getAttribute(DISCLOSURE, 'aria-expanded')).toBe('true');
    }));

  it('a Codex pick names Codex and its own conversation id; "Start fresh instead" starts without one', () =>
    withPage(VARIANTS[0], 'light', '', async tab => {
      await tab.click(DISCLOSURE);
      await tab.click(`[data-continue-row="${CODEX}"]`);
      await tab.click('[data-continue-action]');
      await tab.waitForSelector('[data-new-ferret-picked]');
      expect(await tab.evaluate(() => (window as unknown as { __harness?: string }).__harness)).toBe('codex');
      await tab.getByRole('button', { name: 'Start fresh instead' }).click();
      expect(await tab.evaluate(() => (window as unknown as { __harness?: string }).__harness)).toBeUndefined();
      expect(await tab.inputValue('#fy-new-ferret-folder')).toBe('');
      expect(rowIds).toContain(CODEX);
    }));
});
