/**
 * Screenshots of the Remote Control switch: New session › Advanced options (closed, open and off, open
 * and on) and Info › Runtime › Remote control (off, on), at a 390px phone and a 1440px desktop, in the
 * light and dark studio themes. Review evidence for `docs/launch-settings.md`; nothing compares the PNGs.
 *
 *   bun harness/remote-control-screenshot.tsx [out-dir]   # writes remote-control-*.png (default harness/out)
 *
 * It renders the REAL `NewSessionPage` and the REAL `InfoRuntime`. Like `screenshot.ts` it drives the
 * system Chrome through playwright-core and aborts every request off the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import type { SessionView } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { NewSessionPage } from '../../src/components/new-session-page.tsx';
import { InfoRuntime } from '../../src/features/session-info/info-runtime.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
const shot = new URLSearchParams(location.search).get('shot');
const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.example.test', deviceId: 'token' });
const view = (remoteControl: boolean) => ({
  config: {
    id: 'session-a', name: 'Fix Restart Settings', agent: 'claude-default', harness: 'claude',
    modelHint: 'claude-opus-5', model: 'claude-opus-5', mode: 'auto', cwd: '/work/ferretry', remoteControl,
    createdAt: '2026-10-19T08:00:00.000Z', updatedAt: '2026-10-19T08:00:00.000Z',
  },
  state: { id: 'session-a', status: 'running', turn: 4, lastActivityAt: '2026-10-19T09:00:00.000Z' },
  directory: '/work/ferretry',
}) as unknown as SessionView;
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex flex-col bg-bg p-panel" style={{ maxWidth: 560, margin: '0 auto' }}>
    {shot === 'form' ? (
      <section data-shot="form">
        <NewSessionPage connection={daemon} onNavigate={() => {}} startSession={async () => ({ config: { id: 'x' } })} />
      </section>
    ) : (
      <section data-shot="info">
        <InfoRuntime
          instructions={{ kind: 'ready', items: ['CLAUDE.md'] }}
          mcp={{ kind: 'ready', items: ['playwright'] }}
          skills={12}
          view={view(shot === 'info-on')}
        />
      </section>
    )}
  </div>,
);
`;

const html = (theme: string, shot: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body class="bg-bg"><div id="root" data-q="${shot}"></div><script type="module" src="/remote-control-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'remote-control-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'remote-control-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark', url.searchParams.get('shot') ?? ''), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1_440, height: 900, touch: false },
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
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        const where = `${viewport.name}/${scheme}`;
        const capture = async (name: string): Promise<void> => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${name} at ${where} scrolls sideways by ${overflow}px`);
          const target = join(outDir, `remote-control-${name}-${viewport.name}-${scheme}.png`);
          await page.setViewportSize({
            width: viewport.width,
            height: Math.max(viewport.height, (await page.evaluate(() => document.documentElement.scrollHeight)) + 40),
          });
          await page.screenshot({ path: target });
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          process.stdout.write(`📸 ${target}\n`);
        };
        await page.goto(`${server.url}?theme=studio-${scheme}&shot=form`);
        const box = page.locator('#fy-new-session-remote-control');
        await page.locator('[data-new-session-advanced] summary').waitFor({ state: 'visible' });
        await capture('form-closed');
        await page.locator('[data-new-session-advanced] summary').click();
        await box.waitFor({ state: 'visible' });
        await capture('form-off');
        await box.check();
        await capture('form-on');
        for (const state of ['off', 'on'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&shot=info-${state}`);
          await page.locator(`[data-info-remote-control="${state}"]`).waitFor({ state: 'visible' });
          await capture(`info-${state}`);
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
