/**
 * Screenshots of Info › Runtime's Settings row when the CLI runs on older settings than a Restart would
 * give it, at a 390px phone and a desktop width, in the light and dark studio themes. Review evidence
 * for `docs/launch-settings.md`; nothing compares the PNGs.
 *
 *   bun harness/relaunch-settings-screenshot.tsx      # writes harness/out/relaunch-settings-*.png
 *   bun harness/relaunch-settings-screenshot.tsx --instructions [--out <dir>]
 *                                                     # writes info-instructions-*.png: the Instructions
 *                                                     # row (docs/launch-settings.md), fake launch data
 *
 * It renders the REAL `InfoPanel` on its Runtime tab with the REAL `InfoRuntime` inside it, so the row
 * is shown among the rows a reader meets it with. Like `screenshot.ts` it drives the system Chrome
 * through playwright-core and aborts every request off the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
/** `--instructions` captures the Instructions row instead of the Settings row. */
const instructionsMode = process.argv.includes('--instructions');
const outFlag = process.argv.indexOf('--out');
const shotsDir = outFlag === -1 ? outDir : resolve(process.argv[outFlag + 1] ?? outDir);

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

/** The page: Info on its Runtime tab, for a ferret switched to Sonnet and behind on its settings. */
const PAGE_ENTRY = `
import type { SessionView } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { InfoPanel } from '../../src/features/session-info/info-panel.tsx';
import type { InfoRelaunchRead } from '../../src/features/session-info/info-relaunch.tsx';
import { InfoRuntime } from '../../src/features/session-info/info-runtime.tsx';
const state = new URLSearchParams(location.search).get('state');
const view = {
  config: {
    id: 'session-a', name: 'Fix Restart Settings', agent: 'claude-default', harness: 'claude',
    modelHint: 'claude-opus-5', model: 'claude-opus-5', mode: 'auto', cwd: '/work/ferretry',
    createdAt: '2026-10-19T08:00:00.000Z', updatedAt: '2026-10-19T08:00:00.000Z',
  },
  state: {
    id: 'session-a', status: 'running', turn: 4, lastActivityAt: '2026-10-19T09:00:00.000Z',
    observedModel: 'claude-sonnet-5', observedReasoningEffort: 'high',
    ...(state === 'instructions'
      ? {
          launchInstructions: {
            sections: [
              { id: 'tools', chars: 642 },
              { id: 'settings', chars: 468 },
              { id: 'pack', chars: 1034 },
              { id: 'learning', chars: 401 },
            ],
            mode: 'auto',
            questions: false,
          },
        }
      : {}),
  },
  directory: '/work/ferretry',
} as unknown as SessionView;
const relaunch: InfoRelaunchRead = state !== 'stale'
  ? { kind: 'ready', settings: { current: true, reasons: [] } }
  : { kind: 'ready', settings: { current: false, reasons: ['arguments', 'settings'] } };
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
const nothing = () => null;
createRoot(root).render(
  <div className="kt-shell flex flex-col bg-bg" style={{ maxWidth: 480, margin: '0 auto' }}>
    <InfoPanel
      name="Fix Restart Settings"
      onClose={() => undefined}
      onTabChange={() => undefined}
      tab="runtime"
      render={{
        overview: nothing, usage: nothing, folder: nothing, surfaces: nothing,
        runtime: () => (
          <InfoRuntime
            instructions={{ kind: 'ready', items: ['CLAUDE.md'] }}
            mcp={{ kind: 'ready', items: ['playwright'] }}
            onRestart={() => new Promise<void>(() => undefined)}
            relaunch={relaunch}
            skills={12}
            view={view}
          />
        ),
      }}
    />
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg"><div id="root"></div><script type="module" src="/relaunch-settings-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
await Bun.write(join(outDir, 'relaunch-settings-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'relaunch-settings-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        if (instructionsMode) {
          await page.goto(`${server.url}?theme=studio-${scheme}&state=instructions`);
          const row = page.locator('[data-info-row="Instructions"]');
          await row.waitFor({ state: 'visible' });
          await row.scrollIntoViewIfNeeded();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`instructions at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `info-instructions-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
          continue;
        }
        for (const state of ['stale', 'current'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          await page.locator(`[data-info-settings="${state}"]`).waitFor({ state: 'visible' });
          // A row wider than a phone would hide its own last words off-screen.
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${state} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(outDir, `relaunch-settings-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, clip: { x: 0, y: 0, width: viewport.width, height: 760 } });
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
