/**
 * CHAT POLISH, in a real browser: a ferret's message at rest is its first line with "Show more",
 * several image reads are ONE tool group, and the task picker carries an "Include agent tasks" switch.
 *
 * The scene (`tests/integration/fixtures/chat-polish-scene.tsx`) is the real `Transcript` and the real
 * popover. Set `FY_CHAT_POLISH_SHOTS_DIR` to keep it at a phone and a desktop, light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_CHAT_POLISH_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; padding: 0 16px; width: 100%; box-sizing: border-box; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-chat-polish-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/chat-polish-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the chat-polish scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
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

const newContext = async (phone: boolean, mode: 'light' | 'dark'): Promise<BrowserContext> =>
  await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    deviceScaleFactor: phone ? 2 : 1,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });

const open = async (context: BrowserContext, query: string, ready: string): Promise<Page> => {
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?${query}`);
  await tab.waitForSelector(ready);
  return tab;
};

describe('chat polish', () => {
  it('shows a ferret’s long message as its first line and opens it on Show more', async () => {
    const context = await newContext(true, 'light');
    try {
      const tab = await open(context, 'theme=studio-light', '.fy-transcript-content');
      expect(await tab.locator('[data-peer-preview]').count()).toBe(1);
      expect(await tab.locator('[data-peer-preview]').innerText()).toBe('Review of the relay change');
      expect(await tab.getByText('fingerprint allowlist').count()).toBe(0);
      expect(await tab.locator('[data-peer-more]').count()).toBe(1);
      await tab.locator('[data-peer-more]').click();
      expect(await tab.getByText('fingerprint allowlist').count()).toBe(1);
      expect(await tab.locator('[data-peer-more]').innerText()).toBe('Show less');
    } finally {
      await context.close();
    }
  });

  it('keeps a peer message’s foot on ONE row: its controls at the left, the time and ticks at the right', async () => {
    const context = await newContext(true, 'light');
    const centre = (box: { readonly height: number; readonly y: number } | null): number =>
      (box?.y ?? 0) + (box?.height ?? 0) / 2;
    try {
      const tab = await open(context, 'theme=studio-light', '.fy-transcript-content');
      const foot = tab.locator('.fy-message-peer[data-peer="torrey"] [data-message-footer]');
      const more = await foot.locator('[data-peer-more]').boundingBox();
      const link = await foot.locator('.fy-peer-open').boundingBox();
      const time = await foot.locator('time').boundingBox();
      expect(more).not.toBeNull();
      expect(link).not.toBeNull();
      expect(time).not.toBeNull();
      // Show more, Open chat and the time share one line — none takes a row of its own.
      expect(Math.abs(centre(more) - centre(time))).toBeLessThanOrEqual(2);
      expect(Math.abs(centre(link) - centre(time))).toBeLessThanOrEqual(2);
      expect(time?.x ?? 0).toBeGreaterThan((link?.x ?? 0) + (link?.width ?? 0));
      // A short message with nothing to open keeps the same foot: the link alone, still one row.
      const short = tab.locator('.fy-message-peer[data-peer="lizzette"] [data-message-footer]');
      const quiet = await short.locator('.fy-peer-open').boundingBox();
      const shortTime = await short.locator('time').boundingBox();
      expect(await short.locator('[data-peer-more]').count()).toBe(0);
      expect(Math.abs(centre(quiet) - centre(shortTime))).toBeLessThanOrEqual(2);
      // On the narrowest phone the row may wrap, but a control's own words are never cut: neither the
      // button nor the link carries an ellipsis.
      const narrow = await browser.newContext({
        viewport: { width: 320, height: 640 },
        colorScheme: 'light',
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      try {
        const tab = await open(narrow, 'theme=studio-light', '.fy-transcript-content');
        const controls = tab.locator(
          '.fy-message-peer[data-peer="torrey"] [data-peer-more], .fy-message-peer[data-peer="torrey"] .fy-peer-open',
        );
        expect(await controls.count()).toBe(2);
        for (const control of await controls.all())
          expect(await control.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      } finally {
        await narrow.close();
      }
    } finally {
      await context.close();
    }
  });

  it('draws an instructions update as one folded line and opens its sections', async () => {
    const context = await newContext(true, 'light');
    try {
      const tab = await open(context, 'theme=studio-light', '.fy-transcript-content');
      expect(await tab.getByText('[instructions updated]').count()).toBe(0);
      expect(await tab.locator('[data-instructions-update]').innerText()).toContain('Ferretry tools, Board');
      expect(await tab.locator('[data-system-detail]').count()).toBe(0);
      await tab.locator('[data-instructions-update] .fy-system-details').click();
      expect(await tab.locator('[data-system-detail]').innerText()).toContain('all work is a card');
    } finally {
      await context.close();
    }
  });

  it('folds six image reads into one group', async () => {
    const context = await newContext(false, 'light');
    try {
      const tab = await open(context, 'theme=studio-light', '.fy-transcript-content');
      expect(await tab.getByText('6 images').count()).toBeGreaterThan(0);
      expect(await tab.locator('[data-transcript-kind="image"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('adds agent tasks to the picker only when the switch is on', async () => {
    const context = await newContext(true, 'light');
    try {
      const tab = await open(context, 'theme=studio-light&picker=1', '[data-agent-tasks-switch]');
      expect(await tab.getByText('&F31').count()).toBe(0);
      await tab.locator('[data-agent-tasks-switch]').click();
      expect(await tab.getByText('&F31').count()).toBe(1);
      expect(await tab.locator('[data-agent-tasks-switch]').getAttribute('aria-checked')).toBe('true');
    } finally {
      await context.close();
    }
  });

  it('lists the most relevant fifty open human cards of a busy project and lets the query narrow them', async () => {
    const context = await newContext(true, 'light');
    try {
      const tab = await open(context, 'theme=studio-light&picker=1&many=1', '[data-agent-tasks-switch]');
      expect(await tab.locator('[role="option"]').count()).toBe(50);
      expect(await tab.getByText('&F51', { exact: true }).count()).toBe(0);
      await tab.locator('[data-agent-tasks-switch]').click();
      expect(await tab.locator('[role="option"]').count()).toBe(50);
    } finally {
      await context.close();
    }
    const narrowed = await newContext(true, 'light');
    try {
      const tab = await open(narrowed, 'theme=studio-light&picker=1&many=1&q=allowlist', '[data-agent-tasks-switch]');
      expect(await tab.locator('[role="option"]').count()).toBe(10);
    } finally {
      await narrowed.close();
    }
  });
});

describe('chat polish, captured', () => {
  it.if(shotsDir !== '')(
    'keeps the scenes at a phone and a desktop, light and dark',
    async () => {
      const states = [
        ['chat', ''],
        ['chat-open', '&open=1'],
        ['chat-update', '&update=1'],
        ['ferretry', '&ferretry=1'],
        ['ferretry-open', '&ferretry=1'],
        ['picker', '&picker=1'],
        ['picker-on', '&picker=1&on=1'],
        ['picker-many', '&picker=1&many=1'],
        ['picker-many-on', '&picker=1&many=1&on=1'],
      ] as const;
      for (const phone of [false, true])
        for (const mode of ['light', 'dark'] as const)
          for (const [state, extra] of states) {
            const context = await newContext(phone, mode);
            try {
              const picker = extra.includes('picker');
              const tab = await open(
                context,
                `theme=studio-${mode}${extra}`,
                picker ? '[data-agent-tasks-switch]' : '.fy-transcript-content',
              );
              if (state === 'chat-open') await tab.locator('[data-peer-more]').click();
              if (state === 'chat-update') await tab.locator('[data-instructions-update] .fy-system-details').click();
              if (state === 'ferretry-open')
                for (const toggle of await tab.locator('[data-ferretry-message] .fy-system-details').all())
                  await toggle.click();
              await tab.waitForTimeout(150);
              await tab.screenshot({
                path: join(shotsDir, `chat-polish-${state}-${phone ? 'phone' : 'desktop'}-${mode}.png`),
              });
            } finally {
              await context.close();
            }
          }
    },
    180_000,
  );
});
