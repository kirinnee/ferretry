/**
 * Screenshots of Settings › Machine › What agents may control, with its Page scripts row — the owner's switch
 * for `browser.eval` — as the app draws it: the section as it opens, Page scripts off (`off`), and with Page
 * scripts ticked and the Save panel showing (`on`), at a 390px phone and a 1440px desktop, in the light and
 * dark studio themes. Review evidence for the row and its warning; nothing compares the PNGs.
 *
 *   bun harness/page-scripts-screenshot.tsx          # writes harness/out/page-scripts-*.png
 *   PAGE_SCRIPTS_SHOTS=/tmp/dir bun harness/page-scripts-screenshot.tsx
 *
 * It renders the REAL `MachineSettingsTab` over a machine with every switch at its default, with the daemon
 * answered inside the page. Like `pack-mode-screenshot.tsx` it drives the system Chrome through
 * playwright-core and aborts every request off the loopback origin.
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
import { MachineSettingsTab } from '../../src/features/fleet/machine/settings-tab.tsx';
import { machineAnswer, machineView, scriptedClient, STUDIO } from '../../tests/unit/features/fleet/setup/setup-support.ts';
import { machineSetupAnswer } from '../machine-setup-fixture.ts';

const scripted = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
const client = {
  request: async (path, schema, init) => {
    const setup = machineSetupAnswer('studio-mac', true, path, init);
    return setup === undefined ? scripted.request(path, schema, init) : schema.parse(setup);
  },
};
const browser = Object.assign(new EventTarget(), { location: { hash: '#machines/studio-mac/machine' } });

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="bg-bg p-4 text-fg" data-shot="">
    <MachineSettingsTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={machineView({})}
      online
      checking={false}
      onRetry={() => {}}
      createClient={async () => client}
      sources={[]}
      browser={browser}
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/page-scripts-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'page-scripts-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'page-scripts-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'page-scripts-entry.tsx'));
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

const shotsDir = process.env.PAGE_SCRIPTS_SHOTS ?? outDir;
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
        for (const scene of ['off', 'on'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}`);
          const section = page.locator('[data-setup-section="agent-control"]');
          await section.waitFor({ state: 'visible' });
          if (scene === 'on') {
            await section.locator('[data-setup-choice="pageScripts"]').click();
            await section.getByRole('button', { name: 'Save what agents may control' }).waitFor({ state: 'visible' });
          }
          await section.scrollIntoViewIfNeeded();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scene} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `page-scripts-${scene}-${viewport.name}-${scheme}.png`);
          await section.screenshot({ path: target });
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
