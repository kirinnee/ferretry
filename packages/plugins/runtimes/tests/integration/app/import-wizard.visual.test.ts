/**
 * THE IMPORT WIZARD in a real browser, over fixed fake data (`fixtures/import-wizard-scene.tsx`): fresh machine, everything
 * found, Codex not installed, secret environment, hooks present, and the answer after an import. Each fits the screen, keeps
 * every control a 44px target on a phone, and reads in light and dark.
 *
 * Set `FY_IMPORT_WIZARD_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type BrowserContext = Awaited<ReturnType<Browser['newContext']>>;
type Page = Awaited<ReturnType<BrowserContext['newPage']>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_IMPORT_WIZARD_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-import-wizard-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/import-wizard-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the import-wizard scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const newContext = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark'): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

const open = async (context: BrowserContext, view: string, mode: 'light' | 'dark'): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?view=${view}&theme=studio-${mode}`);
  await tab.waitForSelector('[data-tool-page], [data-import-confirm]');
  return tab;
};

const shootWhole = async (tab: Page, path: string, width: number): Promise<void> => {
  const height = await tab.evaluate(() => {
    const root = document.getElementById('root');
    return Math.ceil(
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, root?.scrollHeight ?? 0),
    );
  });
  await tab.setViewportSize({ width, height: Math.max(height, 200) });
  await tab.mouse.move(0, 0);
  await tab.screenshot({ path });
};

const fits = async (tab: Page, width: number): Promise<void> => {
  const overflow = await tab.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
  const boxes = tab.locator('[data-import-wizard] *');
  for (let at = 0; at < (await boxes.count()); at += 1) {
    const box = await boxes.nth(at).boundingBox();
    if (box === null) continue;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  }
};

const targetsAreBigEnough = async (tab: Page): Promise<void> => {
  const targets = tab.locator(
    '[data-import-wizard] label:has(input), [data-import-wizard] button, [data-import-wizard] input[type="text"]',
  );
  for (let at = 0; at < (await targets.count()); at += 1) {
    const box = await targets.nth(at).boundingBox();
    if (box === null) continue;
    const which = (await targets.nth(at).evaluate(element => element.outerHTML)).slice(0, 140);
    expect(box.height, `a tap target is under 44px tall: ${which}`).toBeGreaterThanOrEqual(43);
  }
};

interface Case {
  readonly name: string;
  readonly view: string;
  readonly prepare?: (tab: Page) => Promise<void>;
  readonly expectText: readonly string[];
  readonly expectNo?: readonly string[];
}

const CASES: readonly Case[] = [
  {
    name: 'fresh-machine',
    view: 'fresh',
    expectText: ['Not installed on this machine', 'brew install --cask claude-code', 'Install Claude Code'],
  },
  {
    name: 'claude-found-all',
    view: 'claude',
    expectText: [
      'Instructions in your Default profile',
      'MCP server',
      'Claude settings',
      'This login’s environment',
      'Secrets go to the Vault.',
      'Not imported: Ferretry doesn’t use hooks',
      'Stay in each project; agents read them there',
      'already read automatically, one way. Nothing to import.',
      'Import and create runtime',
    ],
  },
  {
    name: 'codex-not-installed',
    view: 'codex-off',
    prepare: async tab => {
      await tab.locator('[data-import-tab="codex"]').click();
      await tab.waitForSelector('[data-tool-install="codex"]');
    },
    expectText: ['Not installed on this machine', 'npm i -g @openai/codex'],
  },
  {
    name: 'secret-env',
    view: 'secrets',
    expectText: ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'kept in the Vault', 'Secrets go to the Vault.'],
  },
  {
    name: 'hooks-present',
    view: 'hooks',
    expectText: ['Hooks (5)', 'Not imported: Ferretry doesn’t use hooks', 'Project instructions (2 folders)'],
    expectNo: ['Hooks (5) · '],
  },
  {
    name: 'retry-same-runtime',
    view: 'retry',
    expectText: ['A runtime already uses this setup, so no second one is added.'],
    expectNo: ['Runtime name'],
  },
  {
    name: 'signed-out',
    view: 'signin',
    expectText: ['not signed in', 'Sign in now, or import first and sign in after.'],
  },
  {
    name: 'changed-since',
    view: 'changed',
    expectText: ['Changed since you last brought it in', 'instructions/claude', 'it stays as it was'],
  },
  {
    name: 'needs-passkey-ok',
    view: 'confirm',
    expectText: [
      'Looking at your setup needs your OK',
      'Look at my setup',
      'Nothing is read until you press the button.',
    ],
  },
  {
    // E3 item 4: the import never answered, the page stopped waiting, asked the machine ONCE, and shows what landed.
    name: 'partial-after-timeout',
    view: 'timeout',
    prepare: async tab => {
      await tab.locator('[data-change-submit]').click();
      await tab.waitForSelector('[data-import-partial]', { timeout: 15_000 });
      await tab.waitForSelector('[data-change-refusal]');
    },
    expectText: [
      'Part of the Claude Code import is on this machine',
      'Brought in',
      'secret-store key ANTHROPIC_API_KEY',
      'login claude-default',
      'claude-code/settings/default.yaml',
      'Not brought in',
      'skills/review.yaml',
      'the runtimes and fleet files',
      'variables of login claude-default',
      'Part of it did land on this machine',
      'Press Try again to bring in the rest',
    ],
    expectNo: ['is set up'],
  },
  {
    name: 'done',
    view: 'claude',
    prepare: async tab => {
      await tab.locator('[data-found-item="claude-code:env"] input').click();
      await tab.locator('[data-change-submit]').click();
      await tab.waitForSelector('[data-import-answer]');
    },
    expectText: [
      'Claude Code is set up',
      'Written by the parts that own them',
      'Not written: skills/release-notes.yaml',
    ],
  },
];

describe('the import wizard', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      for (const scene of CASES) {
        it(`${scene.name} (${viewport.name}, ${mode})`, async () => {
          const context = await newContext(viewport, mode);
          try {
            const tab = await open(context, scene.view, mode);
            await scene.prepare?.(tab);
            const body = (await tab.locator('[data-import-wizard]').textContent()) ?? '';
            for (const words of scene.expectText) expect(body).toContain(words);
            for (const words of scene.expectNo ?? []) expect(body).not.toContain(words);
            await fits(tab, viewport.width);
            if (viewport.phone) await targetsAreBigEnough(tab);
            if (shotsDir !== '')
              await shootWhole(tab, join(shotsDir, `${scene.name}-${viewport.name}-${mode}.png`), viewport.width);
          } finally {
            await context.close();
          }
        }, 60_000);
      }
});
