/**
 * CONVERSATION TITLES in a real browser (r11 S11). The rows are made by the REAL conversation index from fake transcripts (a fake
 * vault masks the secrets it is told of) and drawn by the REAL conversation card (`fixtures/conversation-titles-scene.tsx`).
 *
 * The owner's lines, as computed DOM, at 1280 and 390, light and dark:
 *  - a conversation a ferret keeps is headed by its title ALONE: no text node of the card says the ferret's callsign, and there
 *    is no first-message line under it (nothing sits between the title and the meta line);
 *  - a conversation with no CLI title gets a short, task-like title that is not the message's own opening;
 *  - a secret in the first message (a token, a vault value, over several lines, in unicode) is in neither the title, the DOM, both
 *    storages nor the console;
 *  - opening the list asks nothing of a model: the page's request log holds the page, its script and the rows only.
 *
 * Set `FY_CONVERSATION_TITLES_SHOTS_DIR` to keep `<viewport>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { LinkableConversation } from '../../../contract/index.ts';
import {
  ConversationIndex,
  type FerretConversationNames,
  type IndexSource,
  type ScrubBatch,
} from '../../../daemon/links/lib/conversation-index.ts';
import { claudeRecord, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CONVERSATION_TITLES_SHOTS_DIR ?? '';

const A = '3b1a4a52-0000-4000-8000-0000000000a1';
const B = '3b1a4a52-0000-4000-8000-0000000000b2';
const C = '3b1a4a52-0000-4000-8000-0000000000c3';
const D = '3b1a4a52-0000-4000-8000-0000000000d4';
const E = '3b1a4a52-0000-4000-8000-0000000000e5';
// Spelled in two pieces: a whole secret-shaped literal would make GitHub's push protection refuse the branch.
const FAKE_TOKEN = `${'ghp_'}aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF3hJ6`;
const FAKE_VAULT_VALUE = 'hunter2-prod-deploy';
const FAKE_UNICODE_VALUE = 'パスワード秘密123';
const FAKE_MULTILINE_VALUE = 'line one of the secret\nline two of the secret';
const SECRETS = [FAKE_TOKEN, FAKE_VAULT_VALUE, FAKE_UNICODE_VALUE, 'hunter2', 'ghp_aB3d', 'line one of the secret'];
const OPENING = 'can you look at why the deploy script fails on mac? see /tmp/x.log';

const vault: ScrubBatch = async work =>
  work(text =>
    Object.entries({ DEPLOY_KEY: FAKE_VAULT_VALUE, JP: FAKE_UNICODE_VALUE, CERT: FAKE_MULTILINE_VALUE }).reduce(
      (masked, [name, value]) => masked.split(value).join(`[redacted:${name}]`),
      text,
    ),
  );

/** The rows the real index lists for five fake conversations, and what it offered Ferrets. */
const makeRows = async (): Promise<{ rows: readonly LinkableConversation[]; offered: readonly string[] }> => {
  const history = new MemoryHistory();
  const at = '2026-02-01T09:00:00.000Z';
  const talk = (text: string) => `${claudeRecord('user', text, at)}\n${claudeRecord('assistant', 'ok', at)}\n`;
  const rec = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
  const file = (id: string) => `projects/-work-app/${id}.jsonl`;
  // A: kept by ferret ms-12; Claude Code wrote its own title.
  history.set(
    file(A),
    talk('please look at the login test') + rec({ type: 'ai-title', aiTitle: 'Fix flaky login test' }),
  );
  // B: no CLI title; the owner's opening message is a question with a path in it.
  history.set(file(B), talk(OPENING));
  // C: a first message with a token, a vault value, a multi-line vault value and a unicode vault value.
  history.set(
    file(C),
    talk(
      `Fix the deploy script. The key is ${FAKE_VAULT_VALUE} and the token is ${FAKE_TOKEN}.\n${FAKE_MULTILINE_VALUE}\n${FAKE_UNICODE_VALUE}`,
    ),
  );
  // D: kept by a ferret whose owner renamed it; a newer title then arrives.
  history.set(file(D), talk('rotate the keys') + rec({ type: 'ai-title', aiTitle: 'Newest generated title' }));
  // E: a unicode conversation.
  history.set(
    file(E),
    talk('ログインのバグを直してください') + rec({ type: 'ai-title', aiTitle: 'ログインのバグを直す' }),
  );
  const names: FerretConversationNames = new Map([
    [`claude-code:${A}`, { ferret: 'ms-12', name: 'Ms-12' }],
    [`claude-code:${D}`, { ferret: 'ms-13', name: 'Ms-13', title: 'My own words', titleSource: 'owner' as const }],
  ]);
  const offered: string[] = [];
  const sources: IndexSource[] = [
    { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: history },
  ];
  const index = new ConversationIndex({
    sqlite: () => memorySqlite(),
    sources: async () => sources,
    ferretNames: async () => names,
    parsers: PARSERS,
    nowMs: () => 0,
    scrubbing: vault,
    adoptTitle: async (ferret, title) => {
      offered.push(`${ferret}=${title}`);
      return 'adopted';
    },
  });
  await index.refresh();
  return { rows: index.query().conversations.map(found => found.row), offered };
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let rowsJson = '[]';
let offeredByIndex: readonly string[] = [];
const requests: string[] = [];

beforeAll(async () => {
  const made = await makeRows();
  rowsJson = JSON.stringify(made.rows);
  offeredByIndex = made.offered;
  directory = await mkdtemp(join(tmpdir(), 'ferretry-conversation-titles-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/conversation-titles-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the titles scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/rows.json') return new Response(rowsJson, { headers: { 'content-type': 'application/json' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 900, phone: true },
] as const;

describe('the index’s answer, before any browser', () => {
  it('offers Ferrets the conversation’s own title for the ferret that has none, and nothing for the owner’s', () => {
    expect(offeredByIndex).toEqual(['ms-12=Fix flaky login test']);
  });
});

describe('conversation titles, as the card draws them', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`at ${viewport.name} in ${scheme}: title alone, task-like, scrubbed, no model asked`, async () => {
        requests.length = 0;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          colorScheme: scheme,
        });
        try {
          const origin = server?.url.origin ?? '';
          const outside: string[] = [];
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin === origin) return await route.continue();
            outside.push(route.request().url());
            return await route.abort();
          });
          const tab = await context.newPage();
          const consoleText: string[] = [];
          tab.on('console', message => consoleText.push(message.text()));
          tab.on('pageerror', error => consoleText.push(error.message));
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          await tab.waitForSelector('[data-row]');
          // Kept before any assert, so a failing run (the base) still leaves its picture.
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}.png`) });

          const card = async (id: string) =>
            await tab.evaluate(rowId => {
              const row = document.querySelector<HTMLElement>(`[data-row="${rowId}"]`) as HTMLElement;
              const text: string[] = [];
              const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) text.push(walker.currentNode.textContent ?? '');
              const title = row.querySelector<HTMLElement>('.fy-convo-title') as HTMLElement;
              const meta = row.querySelector<HTMLElement>('.fy-convo-meta') as HTMLElement;
              const box = (element: HTMLElement) => element.getBoundingClientRect();
              return {
                title: title.textContent ?? '',
                titleWeight: Number(getComputedStyle(title).fontWeight),
                text,
                hasFirstLine: row.querySelector('[data-conversation-first]') !== null,
                hasLatestLine: row.querySelector('[data-conversation-latest]') !== null,
                // Nothing sits between the title and the meta line: they are one line-height apart, not a line of preview.
                gap: box(meta).top - box(title).bottom,
                lineHeight:
                  Number.parseFloat(getComputedStyle(title).lineHeight) || title.getBoundingClientRect().height,
                titleLines: Math.round(
                  box(title).height / (Number.parseFloat(getComputedStyle(title).lineHeight) || 1),
                ),
                overflowX: row.scrollWidth - row.clientWidth,
                ferretBadge: row.querySelector('[data-conversation-ferret]')?.textContent ?? null,
                ferretTooltip: row.querySelector('[data-conversation-ferret]')?.getAttribute('title') ?? null,
              };
            }, id);

          // (a) kept by ferret ms-12, Claude Code's own title: exactly that title, no callsign, no first-message line.
          const kept = await card(A);
          expect(kept.title).toBe('Fix flaky login test');
          expect(kept.text.some(text => /ms-12/iu.test(text))).toBe(false);
          expect(kept.hasFirstLine).toBe(false);
          expect(kept.hasLatestLine).toBe(false);
          expect(kept.titleWeight).toBeGreaterThanOrEqual(600);
          expect(kept.gap).toBeLessThan(kept.lineHeight);
          expect(kept.overflowX).toBeLessThanOrEqual(0);
          expect(kept.ferretBadge).toBe('Ferret · working');
          expect(kept.ferretTooltip).toBe('Ms-12');

          // (b) no CLI title: a task-like title, not the message's own opening.
          const made = await card(B);
          expect(made.title.split(' ').length).toBeLessThanOrEqual(5);
          expect(made.title.length).toBeLessThanOrEqual(60);
          expect(made.title).not.toContain('/');
          expect(made.title).not.toBe(OPENING.slice(0, 60));
          expect(made.hasFirstLine).toBe(false);
          expect(made.titleLines).toBe(1);

          // (c) the secrets: not in the title, the page, either storage, or the console.
          const scrubbed = await card(C);
          expect(scrubbed.title).toBe('Fix the Deploy Script');
          const page = await tab.evaluate(() => ({
            html: document.documentElement.outerHTML,
            rows: [...document.querySelectorAll('[data-row]')].map(row => row.outerHTML).join('\n'),
            local: JSON.stringify({ ...localStorage }),
            session: JSON.stringify({ ...sessionStorage }),
          }));
          for (const secret of SECRETS) {
            expect(page.html).not.toContain(secret);
            expect(page.local).not.toContain(secret);
            expect(page.session).not.toContain(secret);
            expect(consoleText.join('\n')).not.toContain(secret);
          }
          // The vault's mark names the secret: it is no word of any row.
          expect(page.rows).not.toMatch(/redacted|DEPLOY_KEY/u);
          expect(rowsJson).not.toContain(FAKE_TOKEN);
          expect(rowsJson).not.toContain('hunter2');

          // (d) the owner's own title on the ferret outranks a newer generated one.
          expect((await card(D)).title).toBe('My own words');

          // unicode survives, and nothing overflows a phone.
          const japanese = await card(E);
          expect(japanese.title).toBe('ログインのバグを直す');
          for (const id of [A, B, C, D, E]) expect((await card(id)).overflowX).toBeLessThanOrEqual(0);

          // (e) the page asked only for itself, its script and the rows: no model endpoint, nothing outside.
          expect(outside).toEqual([]);
          expect([...new Set(requests)].sort()).toEqual(['/', '/app.js', '/rows.json']);

          if (shotsDir !== '') {
            // The measured values behind the asserts, for the PR body.
            const measured = {
              keptTitle: kept.title,
              gap: kept.gap,
              lineHeight: kept.lineHeight,
              weight: kept.titleWeight,
              madeTitle: made.title,
              madeLines: made.titleLines,
              scrubbedTitle: scrubbed.title,
              requests: [...new Set(requests)].sort(),
            };
            await writeFile(join(shotsDir, `${viewport.name}-${scheme}.json`), JSON.stringify(measured, null, 2));
          }
        } finally {
          await context.close();
        }
      }, 60_000);
});
