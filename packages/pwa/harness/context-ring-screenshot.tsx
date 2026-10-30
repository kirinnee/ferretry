/**
 * The context ring: on the composer's status line next to the model chips and the quota, and on the
 * sidebar row (only from 90%) — at 12%, 75% and 95%, plus a compaction in flight. Desktop 1440 and phone
 * 390, light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/context-ring-screenshot.tsx [out-dir]   # writes context-pie-<state>-<viewport>-<scheme>.png
 *
 * The status line is the REAL `ComposerRuntimeWithKeyboard`, `ContextRing` and `ComposerQuota` inside the
 * composer's own status-line markup; the sidebar row is the REAL `SidebarRow`. It fails if a width
 * scrolls sideways or the ring leaves its row.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000');

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
import type { SessionView } from '@ferretry/protocol';
import { ComposerQuota } from '../../src/components/composer-quota.tsx';
import { ComposerRuntimeWithKeyboard } from '../../src/components/composer-runtime.tsx';
import { ContextRing } from '../../src/components/context-ring.tsx';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { buildLineage, nestByLineage } from '../../src/lib/lineage.ts';
import { SidebarRow } from '../../src/shell/agent-sidebar-rows.tsx';

const AT = '2026-10-30T08:00:00.000Z';
const params = new URLSearchParams(location.search);
const state = params.get('state') ?? '12';
const compacting = state === 'compacting';
const percent = compacting ? 95 : Number(state);
const WINDOW = 1_000_000;

const view = {
  config: {
    id: 'harness-session',
    name: 'Cache layer refactor',
    teammate: 'hadi',
    agent: 'claude-auto',
    harness: 'claude',
    cwd: '/work/ferretry',
    model: 'claude-opus-5-5[1m]',
    modelHint: 'claude-opus-5-5',
    harnessFlags: [],
    launchReasoningEffort: 'high',
    createdAt: AT,
    updatedAt: AT,
  },
  state: {
    id: 'harness-session',
    status: 'running',
    turn: 12,
    promptReady: true,
    turnState: 'working',
    observedModel: 'claude-opus-5-5',
    observedModelAt: AT,
    observedFast: true,
  },
  context: { usedTokens: Math.round((WINDOW * percent) / 100), windowTokens: WINDOW, percent, at: AT },
} as unknown as SessionView;

const quota = { fiveHourPercent: 11, weeklyPercent: 38, atLimit: false, authOk: true };
const rows = nestByLineage([view], buildLineage([view]));

createRoot(document.getElementById('root')).render(
  <div className="kt-shell flex min-h-full flex-col gap-panel bg-bg p-panel">
    <section className="kt-panel flex w-full max-w-xl flex-col gap-1 p-panel" data-shot="composer">
      <p className="kt-label m-0">Composer status line · {state}</p>
      <div className="fy-composer-actions border-t border-border-soft pt-1" data-composer-status="">
        <span className="fy-composer-status-chrome" data-composer-status-chrome="">
          <ComposerRuntimeWithKeyboard busy={false} canControl keyboardOpen={false} presentation="popover" view={view} />
          <ContextRing compacting={compacting} context={view.context} onOpen={() => undefined} />
          <ComposerQuota quota={quota} />
        </span>
      </div>
    </section>
    <section className="kt-panel flex w-full max-w-xs flex-col gap-1 p-panel" data-shot="sidebar">
      <p className="kt-label m-0">Sidebar row · {state}</p>
      <ul className="m-0 list-none p-0">
        <SidebarRow active={false} byId={new Map([[view.config.id, view]])} canMutate daemonId={daemonId('alpha')} row={rows[0]} />
      </ul>
    </section>
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/context-ring-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'context-ring-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'context-ring-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const VIEWPORTS = [
  { name: 'desktop', width: 1_440, height: 420, touch: false },
  { name: 'phone', width: 390, height: 420, touch: true },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const state of ['12', '75', '95', 'compacting']) {
    for (const viewport of VIEWPORTS) {
      for (const scheme of ['light', 'dark'] as const) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 2,
          colorScheme: scheme,
          reducedMotion: 'reduce',
          hasTouch: viewport.touch,
          isMobile: viewport.touch,
        });
        try {
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
          );
          const page = await context.newPage();
          const where = `${state}/${viewport.name}/${scheme}`;
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          await page.locator('[data-shot="composer"] [data-context-ring]').waitFor({ state: 'visible' });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          const outside = await page.evaluate(() => {
            const ring = document.querySelector('[data-shot="composer"] [data-context-ring]')?.getBoundingClientRect();
            const panel = document.querySelector('[data-shot="composer"]')?.getBoundingClientRect();
            return ring === undefined || panel === undefined || ring.right > panel.right || ring.left < panel.left;
          });
          if (outside) fail(`${where}: the ring leaves its row`);
          const sidebarRing = await page.locator('[data-shot="sidebar"] [data-context-ring]').count();
          const expected = state === '95' || state === 'compacting' ? 1 : 0;
          if (sidebarRing !== expected) fail(`${where}: sidebar ring count ${sidebarRing}, expected ${expected}`);
          const target = join(outDir, `context-pie-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
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
