/**
 * WHICH AGENT AN ADD SKILLS INSTALL IS FOR, in a real browser (G1 #2570): a Claude-only machine installs for Claude
 * without being asked and offers nothing else, a machine running both asks and offers both, and a ferret on a harness a
 * catalog cannot install into is refused in words with Install off. Set `FY_G1_SHOTS_DIR` to keep
 * `add-skills-<case>-<width>-<mode>-<rounding>.png` (and `…-agent.png` with the picker open).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_G1_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-add-skills-agent-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/add-skills-agent-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the add-skills scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

// Studio is the default rounding; Neumorphism has the highest radii of the shipped styles.
const ROUNDING = { default: 'studio', highest: 'neumorphism' } as const;
const SIZES = [
  { name: '390', width: 390, height: 844, scale: 2 },
  { name: '1440', width: 1_440, height: 900, scale: 1 },
] as const;
const CASES = ['claude-only', 'both', 'unknown'] as const;

const call = (tab: Page, name: '__open' | '__next'): Promise<unknown> => tab.evaluate(`window.${name}()`);

describe('the agent an Add skills install is for', () => {
  for (const kind of CASES)
    for (const { name, width, height, scale } of SIZES)
      for (const mode of ['light', 'dark'] as const)
        for (const [rounding, style] of Object.entries(ROUNDING))
          it(`${kind} (${name}, ${mode}, ${rounding} rounding)`, async () => {
            const context = await browser.newContext({
              viewport: { width, height },
              colorScheme: mode,
              deviceScaleFactor: scale,
              reducedMotion: 'reduce',
            });
            try {
              const origin = server?.url.origin ?? '';
              await context.route('**/*', async route =>
                new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
              );
              const tab = await context.newPage();
              await tab.goto(`${origin}/?style=${style}&mode=${mode}&case=${kind}`);
              await tab.waitForSelector('[data-add-skills-row]', { timeout: 15_000 });
              const shot = async (suffix: string): Promise<void> => {
                if (shotsDir !== '')
                  await tab.screenshot({
                    path: join(shotsDir, `add-skills-${kind}-${name}-${mode}-${rounding}${suffix}.png`),
                  });
              };
              const scope = (await tab.locator('[data-add-skills-scope]').textContent()) ?? '';
              if (kind === 'unknown') {
                expect(scope).toBe('fake-third is not a harness a catalog can install into yet.');
                expect(await tab.locator('[data-add-skills-install]').first().isDisabled()).toBe(true);
                await shot('');
              } else {
                expect(scope).toContain('Installs into this project');
                await shot('');
                await call(tab, '__open');
                await tab.waitForSelector('[data-shared-install-button]');
                await call(tab, '__next');
                await tab.waitForSelector('[data-catalog-harness] [role="combobox"]');
                const shown = (
                  (await tab.locator('[data-catalog-harness] [role="combobox"]').textContent()) ?? ''
                ).trim();
                expect(shown).toBe(kind === 'claude-only' ? 'Claude' : 'Choose…');
                await tab.locator('[data-catalog-harness] [role="combobox"]').click();
                const options = await tab.locator('[role="option"] [data-label]').allTextContents();
                expect(options.filter(option => option !== 'Choose…')).toEqual(
                  kind === 'claude-only' ? ['Claude'] : ['Claude', 'Codex'],
                );
                // The open list fades in; the shot waits for it to finish.
                await tab.waitForTimeout(400);
                await shot('-agent');
              }
              // Nothing runs off the page sideways.
              expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            } finally {
              await context.close();
            }
          }, 60_000);
});
