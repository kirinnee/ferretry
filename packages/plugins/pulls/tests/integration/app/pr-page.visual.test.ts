/**
 * THE PR PAGE in a real browser over fake data (`fixtures/pr-page-scene.tsx`), at 1280 and 390 wide, light and dark.
 *
 * The page draws strangers' text, so this also proves the one thing a unit test cannot: a description holding a REMOTE
 * IMAGE makes the browser request nothing from that address (a local listener counts what reaches it).
 *
 * Set `FY_PR_PAGE_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PR_PAGE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let pixels: ReturnType<typeof Bun.serve> | undefined;
let pixelRequests = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pr-page-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pr-page-scene.tsx'],
    {
      cwd: packageRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the PR page scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  // The "stranger's picture host": anything that reaches it is counted.
  pixels = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      pixelRequests += 1;
      return new Response('', { status: 204 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  pixels?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

const open = async (variant: (typeof VARIANTS)[number], kind: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  const pixel = `${pixels?.url.origin ?? ''}/pixel.png`;
  await tab.goto(
    `${server?.url.origin ?? ''}/?theme=studio-${variant.scheme}&case=${kind}&pixel=${encodeURIComponent(pixel)}`,
  );
  await tab.waitForSelector(kind === 'paused' ? '[data-pull-paused]' : '[data-pull-header]');
  return { tab, problems, close: async () => await context.close() };
};

describe('PR page', () => {
  for (const kind of ['long', 'merged', 'draft', 'paused', 'hostile'] as const) {
    for (const variant of VARIANTS) {
      it(`${kind} at ${variant.name}: draws, never scrolls sideways, no stray errors`, async () => {
        const { tab, problems, close } = await open(variant, kind);
        const sideways = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(sideways).toBeLessThanOrEqual(0);
        if (shotsDir !== '') {
          // Tall enough that the page, which scrolls inside its own box, is drawn whole.
          await tab.setViewportSize({ width: variant.width, height: variant.phone ? 3200 : 2000 });
          await tab.screenshot({ path: join(shotsDir, `${variant.name}-${kind}.png`) });
          if (kind === 'long')
            for (const label of ['ci', 'files']) {
              await tab.locator(`[data-pull-tab="${label}"]`).click();
              await tab.waitForTimeout(400); // the underline eases to the new tab
              await tab.screenshot({ path: join(shotsDir, `${variant.name}-${kind}-${label}.png`) });
            }
        }
        expect(problems).toEqual([]);
        await close();
      });
    }
  }

  const REQUESTED_CONTROLS = [
    ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e],
    ...[0x2066, 0x2067, 0x2068, 0x2069],
    ...[0x200b, 0x200c, 0x200d, 0x200e, 0x200f],
    0xfeff,
  ].map(code => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`);

  for (const variant of VARIANTS) {
    it(`hostile text at ${variant.name}: every control is a chip in the title, an empty-looking body and a comment, and a link shows where it goes`, async () => {
      const { tab, problems, close } = await open(variant, 'hostile');
      const seen = await tab.evaluate(() => {
        const labels = (root: Element | null) =>
          [...(root?.querySelectorAll('[data-diff-control]') ?? [])].map(chip =>
            chip.getAttribute('data-diff-control'),
          );
        const entries = [...document.querySelectorAll('[data-pull-entry]')];
        const dest = document.querySelector('[data-gh-dest]');
        const box = dest?.getBoundingClientRect();
        const style = dest === null || dest === undefined ? undefined : getComputedStyle(dest);
        return {
          title: labels(document.querySelector('h1')),
          titleText: document.querySelector('h1')?.textContent ?? '',
          description: labels(entries[0] ?? null),
          descriptionText: entries[0]?.textContent ?? '',
          comment: labels(entries[1] ?? null),
          commentText: entries[1]?.textContent ?? '',
          destination: dest?.textContent ?? '',
          destinationBox: box === undefined ? undefined : { left: box.left, right: box.right, width: box.width },
          destinationVisible: style !== undefined && style.visibility === 'visible' && style.display !== 'none',
          viewport: window.innerWidth,
        };
      });
      expect(seen.title).toEqual(['U+202E', 'U+200B', 'U+FEFF']);
      expect(seen.titleText).not.toMatch(/[‪-‮⁦-⁩​-‏﻿]/u);
      expect(seen.description).toEqual(['U+FEFF']);
      expect(seen.descriptionText).not.toContain('No description provided');
      expect(seen.comment).toEqual(REQUESTED_CONTROLS);
      expect(seen.commentText).not.toMatch(/[‪-‮⁦-⁩​-‏﻿]/u);
      // The real destination is on the page, not in a tooltip, and it fits the screen.
      expect(seen.destination).toContain('https://evil.example/steal?token=1');
      expect(seen.destinationVisible).toBe(true);
      expect(seen.destinationBox?.width ?? 0).toBeGreaterThan(0);
      expect(seen.destinationBox?.left ?? -1).toBeGreaterThanOrEqual(0);
      expect(seen.destinationBox?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(seen.viewport);
      expect(problems).toEqual([]);
      await close();
    });
  }

  it('the biggest page the wire allows (500 comments and 500 reviews of 65,536 characters) mounts a bounded few nodes', async () => {
    const started = Date.now();
    const { tab, problems, close } = await open(VARIANTS[3], 'flood');
    const counts = await tab.evaluate(() => ({
      entries: document.querySelectorAll('[data-pull-entry]').length,
      nodes: document.querySelectorAll('*').length,
      chips: document.querySelectorAll('[data-diff-control]').length,
      more: document.querySelectorAll('[data-pull-more]').length,
    }));
    console.log(`flood: ${JSON.stringify(counts)} in ${Date.now() - started} ms`);
    expect(counts.entries).toBeLessThanOrEqual(21);
    expect(counts.nodes).toBeLessThan(10_000);
    expect(counts.chips).toBeLessThan(5_000);
    expect(counts.more).toBeGreaterThan(0);
    // Asking for more shows more, and still a bounded amount.
    await tab.locator('[data-pull-more] button').first().click();
    const after = await tab.evaluate(() => document.querySelectorAll('[data-pull-entry]').length);
    expect(after).toBeGreaterThan(counts.entries);
    expect(problems).toEqual([]);
    await close();
  });

  it('a remote image in the description is never requested, and a script in it never runs', async () => {
    const before = pixelRequests;
    const { tab, problems, close } = await open(VARIANTS[0], 'long');
    // Give a stray <img> every chance to load.
    await tab.waitForTimeout(500);
    expect(pixelRequests).toBe(before);
    expect(await tab.locator('[data-gh-text] img').count()).toBe(0);
    expect(await tab.locator('[data-gh-image]').count()).toBeGreaterThan(0);
    expect(problems).toEqual([]);
    await close();
  });
});
