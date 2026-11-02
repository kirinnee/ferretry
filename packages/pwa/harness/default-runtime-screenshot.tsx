/**
 * "Default for new agents" on the Runtimes tab (docs/design/account-model.md §4.2): the one-row select with its
 * hint, the inline Save / Keep panel after a change, and the list with its Default badge and Make default
 * buttons, on a machine with 13 runtimes. At a 390px phone and a 1440px desktop, light and dark. Review
 * evidence; nothing compares the PNGs.
 *
 *   bun harness/default-runtime-screenshot.tsx [out-dir]   # writes <state>-<390|1440>-<light|dark>.png
 *
 * It renders the REAL `RuntimesTab` against the harness catalogue with a 13-runtime overlay. Nothing touches a
 * network (every request off the loopback origin is aborted). It fails if any state scrolls sideways, if the
 * label, select and hint do not share one row on the desktop or do not stack on the phone, if any row's actions wrap
 * onto a second line, or if Make default is offered on a switched-off runtime.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/b141/e-default-runtime');

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
import { RuntimesTab } from '../../src/features/fleet/runtimes/runtimes-tab.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { harnessCatalogAnswer, harnessRuntime } from '../account-model-catalog.ts';

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
location.hash = '#machines/studio-mac/runtimes';

const OFF = { source: 'runtime', until: '2026-11-04T00:00:00.000Z', reason: 'Out of quota' };
const row = (name, harness, credential, status, extra = {}) => {
  const base = harnessRuntime(name, harness, 'Default', credential);
  return { ...base, agent: true, credential: { ...base.credential, status }, ...extra };
};
const RUNTIMES = {
  format: 'version-2',
  runtimes: [
    row('claude-default', 'claude', 'claude-personal', 'ready'),
    row('claude-agent', 'claude', 'claude-personal', 'ready'),
    row('claude-review', 'claude', 'claude-personal', 'ready'),
    row('claude-work', 'claude', 'claude-work', 'needs_sign_in'),
    row('claude-atomi', 'claude', 'claude-personal', 'ready', { disabled: OFF, launch: { available: false, reason: 'switched off' } }),
    row('claude-llm1', 'claude', 'claude-personal', 'ready'),
    row('claude-llm2', 'claude', 'claude-personal', 'refresh_due'),
    row('claude-lab', 'claude', 'claude-personal', 'ready', { agent: false }),
    row('claude-scratch', 'claude', 'claude-personal', 'checking'),
    row('codex-default', 'codex', 'codex', 'ready'),
    row('codex-kirin', 'codex', 'codex', 'ready'),
    row('codex-atomi', 'codex', 'codex', 'ready', { disabled: OFF, launch: { available: false, reason: 'switched off' } }),
    row('codex-work', 'codex', 'codex', 'needs_sign_in'),
  ],
};
const MACHINE = {
  name: 'studio-mac',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  tools: [
    { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
    { harness: 'codex', label: 'Codex', installed: true, command: '/usr/local/bin/codex' },
  ],
  runtimeCount: 13,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
};

const client = {
  request: async (path, schema, init) => {
    if (path === '/v1/fleet/runtimes') return schema.parse(RUNTIMES);
    if (path === '/v1/fleet/machine') return schema.parse(MACHINE);
    const answer = harnessCatalogAnswer(path, init);
    if (answer === undefined) throw new Error('no route ' + path);
    return schema.parse(answer);
  },
};
createRoot(root).render(
  <main data-fixture="" className="mx-auto max-w-[960px] p-4">
    <RuntimesTab
      connection={daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 't' })}
      machineName="studio-mac"
      machine={MACHINE}
      online={true}
      checking={false}
      onRetry={() => undefined}
      createClient={async () => client}
    />
  </main>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/default-runtime-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'default-runtime-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'default-runtime-entry.jsx'), '--outdir', buildDir, '--target', 'browser']);
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const VIEWPORTS = {
  '390': { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  '1440': { viewport: { width: 1440, height: 900 } },
} as const;

try {
  for (const theme of ['light', 'dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === '390' ? 2 : 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
        locale: 'en-US',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${theme}`);
        await page.locator('[data-default-runtime-select]').waitFor({ state: 'visible' });
        await page.locator('[data-runtime-default-badge]').first().waitFor({ state: 'visible' });

        const sideways = async (where: string): Promise<void> => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
        };
        const shoot = async (state: string, clipHeight?: number): Promise<void> => {
          const where = `${state} at ${vp}/${theme}`;
          await sideways(where);
          const file = join(outDir, `${state}-${vp}-${theme}.png`);
          if (clipHeight === undefined) await page.locator('main').screenshot({ path: file });
          else
            await page.screenshot({
              path: file,
              fullPage: true,
              clip: { x: 0, y: 0, width: page.viewportSize()?.width ?? 390, height: clipHeight },
            });
          process.stdout.write(`📸 ${file}\n`);
        };

        const layout = await page.evaluate(() => {
          const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
          const label = rect('[data-default-runtime] label');
          const select = rect('[data-default-runtime-select]');
          const hint = rect('[data-default-runtime-hint]');
          return label && select && hint
            ? {
                oneRow: Math.abs(label.top - select.top) < 24 && Math.abs(select.top - hint.top) < 24,
                stacked: label.bottom <= select.top + 1 && select.bottom <= hint.top + 1,
              }
            : null;
        });
        if (layout === null) fail(`default runtime control is incomplete at ${vp}/${theme}`);
        if (vp === '1440' && layout?.oneRow !== true) fail(`the control is not one row at ${vp}/${theme}`);
        if (vp === '390' && layout?.stacked !== true) fail(`the control does not stack at ${vp}/${theme}`);

        const split = await page.evaluate(() =>
          [...document.querySelectorAll('[data-runtime-actions]')]
            .filter(actions => {
              const tops = new Set(
                [...actions.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top)),
              );
              return tops.size > 1;
            })
            .map(actions => actions.getAttribute('data-runtime-actions')),
        );
        if (split.length > 0) fail(`actions wrap onto a second line at ${vp}/${theme}: ${split.join(', ')}`);
        const offered = await page
          .locator('[data-runtime-make-default="claude-atomi"], [data-runtime-make-default="codex-atomi"]')
          .count();
        if (offered > 0) fail('Make default is offered on a switched-off runtime');

        await shoot('select-closed', 520);

        const pick = await page
          .locator('[data-default-runtime-select] option', { hasText: 'codex-kirin' })
          .getAttribute('value');
        await page.locator('[data-default-runtime-select]').selectOption(pick ?? '');
        await page.locator('[data-default-runtime-undo]').waitFor({ state: 'visible' });
        await shoot('pending-change', 620);
        await page.locator('[data-default-runtime-undo]').click();
        await page.locator('[data-default-runtime-undo]').waitFor({ state: 'detached' });

        await shoot('default-badge');
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ no state scrolls sideways; one row on desktop, stacked on the phone\n');
} finally {
  await browser.close();
  server.stop();
}
