/**
 * Screenshots of "Move to Codex…" — the sheet that converts a Claude ferret's conversation onto a Codex
 * account — at a 390px phone and a 1440px desktop, in the light and dark studio themes. Review
 * evidence; nothing compares the PNGs.
 *
 *   bun harness/convert-sheet-screenshot.tsx      # writes harness/out/convert-<state>-<viewport>-<scheme>.png
 *
 * It renders the REAL `ConvertSheet` with a canned preview and a canned move, in five states: a ready
 * preview, the account picker, a refused preview, the busy sentence while the daemon checks the
 * converted file, and a move paused for in-flight work. No real path, name or credential appears.
 * Like `screenshot.ts` it drives the system Chrome through playwright-core and aborts every request off
 * the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
import { FyHttpError } from '@ferretry/protocol/client';
import { ConvertSheet } from '../../src/features/session-actions/convert-sheet.tsx';

const state = new URLSearchParams(location.search).get('state') ?? 'ready';
const daemon = { daemonId: 'fy_daemon_harness', baseUrl: 'https://harness.invalid', deviceId: 'harness', carriers: [] };
const scope = { daemonId: 'fy_daemon_harness', sessionId: 'harness-session' };
const view = {
  config: { id: 'harness-session', name: 'Tidy the release notes', harness: 'claude', agent: 'claude-work', teammate: 'hadi' },
  state: { id: 'harness-session', status: 'running', turn: 4 },
  directory: '/work/harness',
};
const account = (id, displayName) => ({
  id, wrapper: id, displayName, kind: 'codex', agent: true, credentialId: id + '-login',
  defaultModel: null, models: [], available: true, unavailableReason: null,
});
const accounts = state === 'picker'
  ? [account('codex-work', 'Codex · work'), account('codex-home', 'Codex · home')]
  : [account('codex-work', 'Codex · work')];
const summary = {
  converter: 1, sourceHarness: 'claude', sourceVersion: '2.1.281', targetHarness: 'codex', targetVersion: '0.163.0',
  turns: 40, keptTurns: 12, omittedTurns: 28, cutNewest: true, messages: 24, nativeToolCalls: 9,
  toolCallsAsText: 31, attachments: 2, dropped: { reasoning: 14, sidechains: 3, internal: 57, compactions: 0 },
  estimatedTokens: 90000, budgetTokens: 200000,
};
const readPreview = async () =>
  state === 'refused'
    ? { kind: 'refused', targetAgent: 'codex-work', reason: 'Codex 0.163.0 is not installed on this machine, so the converted conversation cannot be checked.' }
    : { kind: 'ready', targetAgent: 'codex-work', targetModel: 'gpt-5.5', summary };
const inflight = {
  error: 'refused', code: 'migration_refused',
  inflight: { status: 'running', turn: 4, blockedBy: 'unknown', restartsWithCli: 1, items: [
    { kind: 'process', verdict: 'unknown', title: 'A program Ferretry doesn’t recognise is running', detail: 'build-watch --serve', age: '2h', blocks: true },
  ] },
};
const move = async () => {
  if (state === 'moving') return await new Promise(() => undefined);
  throw new FyHttpError('refused', 409, 'migration_refused', inflight);
};
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex flex-col bg-bg">
    <ConvertSheet
      accounts={accounts}
      connection={daemon}
      move={move}
      onClose={() => undefined}
      onMoved={() => undefined}
      open
      readPreview={readPreview}
      scope={scope}
      view={view}
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/convert-sheet-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'convert-sheet-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'convert-sheet-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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

const STATES = ['ready', 'picker', 'refused', 'moving', 'paused'] as const;
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1_440, height: 900, touch: false },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const state of STATES) {
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
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          if (state === 'picker') {
            await page.locator('[data-convert-accounts]').waitFor({ state: 'visible' });
            await page.locator('[data-convert-accounts] label').first().click();
          }
          if (state === 'moving' || state === 'paused') {
            await page.locator('[data-convert-confirm]').click();
          }
          const marker = {
            ready: '[data-convert-preview]',
            picker: '[data-convert-preview]',
            refused: '[data-convert-refused]',
            moving: '[data-convert-moving]',
            paused: '[data-convert-paused]',
          }[state];
          await page.locator(marker).waitFor({ state: 'visible' });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${state}/${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          // Every control must be reachable and at least the pointer's own target floor.
          const floor = viewport.touch ? 44 : 24;
          const small = await page.evaluate(
            minimum =>
              [...document.querySelectorAll<HTMLElement>('button, label')]
                .filter(node => node.offsetParent !== null && !node.closest('[aria-hidden="true"]'))
                .filter(node => node.getBoundingClientRect().height < minimum)
                .map(node => (node.textContent ?? '').trim().slice(0, 30)),
            floor,
          );
          if (small.length > 0)
            fail(`${state}/${viewport.name}/${scheme} has controls under ${floor}px: ${small.join(', ')}`);
          const target = join(outDir, `convert-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
