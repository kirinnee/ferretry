/**
 * THE SHARED SORTABLE LIST IN CHROMIUM (`fixtures/sortable-list-scene.tsx`): the real `SortableList` dragged by a real
 * mouse and a real touch. Two defects only a browser shows, both found in review of the first build:
 *
 *  - CAPTURE. Chromium takes the pointer away from a node that React moves, which a drag across a row boundary always
 *    does. The release then never reached the grip: the row stayed held and `onReorder` was never called, for a mouse and
 *    a touch alike, and with reduced motion even for a release inside the list.
 *  - OFFSET. The held row's offset from the pointer was worked out from where the row WAS before the move, so after a
 *    reorder it sat a whole row away from the pointer.
 *
 * Each case drags the first row down across two rows, releases OUTSIDE the list, and reads what the caller was told.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-sortable-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/sortable-list-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the sortable scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  browser = await sharedChromium();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Scene {
  readonly tab: Page;
  readonly context: BrowserContext;
  readonly close: () => Promise<void>;
}

const open = async (options: { touch?: boolean; reducedMotion?: boolean }): Promise<Scene> => {
  const context = await browser.newContext({
    viewport: { width: 800, height: 640 },
    hasTouch: options.touch === true,
    reducedMotion: options.reducedMotion === true ? 'reduce' : 'no-preference',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/`);
  await tab.waitForSelector('[data-sortable-key]');
  return { tab, context, close: async () => await context.close() };
};

const order = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(() =>
    Array.from(document.querySelectorAll('li[data-sortable-key]'), li => li.getAttribute('data-sortable-key') ?? ''),
  );
const reorders = async (tab: Page): Promise<string[][]> => await tab.evaluate(() => window.__reorders);
const held = async (tab: Page): Promise<number> => await tab.locator('li[data-state="held"]').count();

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
const boxOf = async (tab: Page, selector: string): Promise<Box> => {
  const box = await tab.locator(selector).boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return box;
};
const rowBox = async (tab: Page, name: string): Promise<Box> => await boxOf(tab, `li[data-sortable-key="${name}"]`);
const gripCentre = async (tab: Page, name: string): Promise<{ x: number; y: number }> => {
  const box = await boxOf(tab, `li[data-sortable-key="${name}"] [data-sortable-grip]`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** The pointer, as one interface for both devices. */
interface Pointer {
  readonly down: (x: number, y: number) => Promise<void>;
  readonly move: (x: number, y: number) => Promise<void>;
  readonly up: (x: number, y: number) => Promise<void>;
}
const mouse = (tab: Page): Pointer => ({
  down: async (x, y) => {
    await tab.mouse.move(x, y);
    await tab.mouse.down();
  },
  move: async (x, y) => await tab.mouse.move(x, y, { steps: 6 }),
  up: async (x, y) => {
    await tab.mouse.move(x, y, { steps: 2 });
    await tab.mouse.up();
  },
});
const touch = (session: CDPSession): Pointer => {
  const send = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number): Promise<void> => {
    await session.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
    });
  };
  return {
    down: async (x, y) => await send('touchStart', x, y),
    move: async (x, y) => await send('touchMove', x, y),
    up: async (x, y) => {
      await send('touchMove', x, y);
      await send('touchEnd', x, y);
    },
  };
};

/** Drag the first row's grip `rows` rows down plus `extra` px, hold there, and report the held row's drift from the pointer. */
const dragDown = async (scene: Scene, pointer: Pointer, rows: number, extra: number) => {
  const { tab } = scene;
  const start = await gripCentre(tab, 'Ferrets');
  const heldStart = await rowBox(tab, 'Ferrets');
  const pitch = (await rowBox(tab, 'Agenda')).y - heldStart.y;
  const delta = rows * pitch + extra;
  await pointer.down(start.x, start.y);
  await pointer.move(start.x, start.y + delta);
  await tab.waitForFunction(() => document.querySelector('li[data-state="held"]') !== null);
  // One frame for the layout effect that measures the offset, one for the slide to settle.
  await tab.waitForTimeout(250);
  const heldNow = await rowBox(tab, 'Ferrets');
  return { start, delta, pitch, drift: heldNow.y + heldNow.height / 2 - (heldStart.y + heldStart.height / 2) - delta };
};

describe('the sortable list in Chromium', () => {
  for (const reducedMotion of [false, true])
    it(`a mouse drag down across two rows, released outside the list, drops the row (reduced motion: ${reducedMotion})`, async () => {
      const scene = await open({ reducedMotion });
      try {
        const pointer = mouse(scene.tab);
        const { start, delta, drift } = await dragDown(scene, pointer, 2, 10);
        expect(Math.abs(drift), 'the held row follows the pointer, not a row away from it').toBeLessThanOrEqual(2);
        await pointer.up(700, start.y + delta);
        await scene.tab.waitForTimeout(100);
        expect(await reorders(scene.tab), 'onReorder is called once with the new order').toEqual([
          ['Agenda', 'Board', 'Ferrets', 'Insights'],
        ]);
        expect(await order(scene.tab)).toEqual(['Agenda', 'Board', 'Ferrets', 'Insights']);
        expect(await held(scene.tab), 'no row is left held').toBe(0);
      } finally {
        await scene.close();
      }
    });

  it('a mouse drag released INSIDE the list at the first crossing still drops the row with reduced motion', async () => {
    const scene = await open({ reducedMotion: true });
    try {
      const pointer = mouse(scene.tab);
      const { start, delta } = await dragDown(scene, pointer, 1, 8);
      await pointer.up(start.x, start.y + delta);
      await scene.tab.waitForTimeout(100);
      expect(await reorders(scene.tab)).toEqual([['Agenda', 'Ferrets', 'Board', 'Insights']]);
      expect(await held(scene.tab)).toBe(0);
    } finally {
      await scene.close();
    }
  });

  it('a touch drag down across two rows, released outside the list, drops the row, and the offset equals the pointer delta', async () => {
    const scene = await open({ touch: true });
    try {
      const session = await scene.context.newCDPSession(scene.tab);
      const pointer = touch(session);
      const { start, delta, drift } = await dragDown(scene, pointer, 2, 10);
      expect(Math.abs(drift), 'the held row follows the finger').toBeLessThanOrEqual(2);
      await pointer.up(700, start.y + delta);
      await scene.tab.waitForTimeout(100);
      expect(await reorders(scene.tab)).toEqual([['Agenda', 'Board', 'Ferrets', 'Insights']]);
      expect(await held(scene.tab)).toBe(0);
    } finally {
      await scene.close();
    }
  });

  it('a drag that goes back up past the start and out of the window is dropped where it ended', async () => {
    const scene = await open({});
    try {
      const pointer = mouse(scene.tab);
      const start = await gripCentre(scene.tab, 'Insights');
      const pitch = (await rowBox(scene.tab, 'Agenda')).y - (await rowBox(scene.tab, 'Ferrets')).y;
      await pointer.down(start.x, start.y);
      await pointer.move(start.x, start.y - 2 * pitch - 10);
      await pointer.up(700, start.y - 2 * pitch - 10);
      await scene.tab.waitForTimeout(100);
      expect(await reorders(scene.tab)).toEqual([['Ferrets', 'Insights', 'Agenda', 'Board']]);
      expect(await held(scene.tab)).toBe(0);
    } finally {
      await scene.close();
    }
  });
});
