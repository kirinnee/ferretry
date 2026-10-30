/**
 * Screenshots of the composer's task menu in both of its modes: the `@` ladder with its fourth tier
 * (`@@@@`, legend and rows) and the direct `&` sigil in the owner's symbols mode, at a 390px phone and a
 * 1440px desktop, in the light and dark studio themes. Review evidence for the task picker; nothing
 * compares the PNGs.
 *
 *   bun harness/task-picker-screenshot.tsx          # writes harness/out/task-picker-*.png
 *
 * It renders the REAL `Composer` with a fixed task list injected, so nothing reaches a daemon. Like
 * `pack-mode-screenshot.tsx` it drives the system Chrome through playwright-core and aborts every request
 * off the loopback origin. TASK_PICKER_SHOTS names another directory for the PNGs.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { Composer } from '../../src/components/composer.tsx';
import { composerSuggestionSwitches } from '../../src/components/composer-autocomplete.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'd' });
const tasks = [
  { id: 'F412', title: 'Add the tasks tier to the composer', status: 'in_progress', phase: 'build', assignee: 'lizzette', updatedAt: '2026-10-30T09:40:00.000Z' },
  { id: 'F409', title: 'Bound the fleet task-board reads', status: 'in_progress', phase: 'design', blocked: true, assignee: 'janet', updatedAt: '2026-10-30T08:10:00.000Z' },
  { id: 'F405', title: 'Review the board aggregate contract', status: 'in_progress', phase: 'research', assignee: 'mvgt2oz9', updatedAt: '2026-10-29T17:00:00.000Z' },
  { id: 'F398', title: 'Write the pairing runbook', status: 'todo', createdAt: '2026-10-29T10:00:00.000Z' },
  { id: 'F391', title: 'Fix the stale tmux sweep', status: 'done', assignee: 'janet', updatedAt: '2026-10-28T12:00:00.000Z' },
];
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="flex min-h-[460px] flex-col justify-end bg-bg p-4 text-fg" style={{ maxWidth: 720, margin: '0 auto' }} data-shot="">
    <Composer
      api={{ send: async () => undefined }}
      autocompleteFetcher={async () => Response.json({}, { status: 500 })}
      autocompleteTasks={tasks}
      compact={params.get('compact') === '1'}
      daemon={daemon}
      sessionId="session-a"
      suggestions={composerSuggestionSwitches(mode === 'symbols' ? 'symbols' : 'ladder', true)}
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/task-picker-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'task-picker-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'task-picker-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'task-picker-entry.tsx'));
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
  { name: 'mobile', width: 390, height: 844, compact: '1' },
  { name: 'desktop', width: 1_440, height: 900, compact: '0' },
] as const;

const SCENES = [
  { name: 'ladder', mode: 'ladder', draft: '@@@@F4' },
  { name: 'ampersand', mode: 'symbols', draft: '&F4' },
] as const;

const shotsDir = process.env.TASK_PICKER_SHOTS ?? outDir;
mkdirSync(shotsDir, { recursive: true });
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
        page.on('pageerror', error => fail(`the page threw: ${error.message}`));
        for (const scene of SCENES) {
          await page.goto(`${server.url}?theme=studio-${scheme}&mode=${scene.mode}&compact=${viewport.compact}`);
          const field = page.locator('[data-live-editor]');
          await field.waitFor({ state: 'visible' });
          await field.click();
          await page.keyboard.type(scene.draft);
          await page.locator('[data-kind="task"]').first().waitFor({ state: 'visible' });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scene.name} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `task-picker-${scene.name}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
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
