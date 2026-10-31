/**
 * &F58: the Resume button on a STOPPED ferret — the real chat header and a sessions-bar row with its menu open.
 * Phone 390px and desktop 1440px, light and dark.
 *
 *   REVIVE_SHOTS=/tmp/claude-1000/shots/revive-button bun harness/revive-button-screenshot.tsx
 *
 * It FAILS when a stopped ferret's header or row menu does not offer Resume, or a running one's does.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out', 'revive-button');
const shotsDir = process.env.REVIVE_SHOTS ?? outDir;

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const BAR_ENTRY = `
import { createRoot } from 'react-dom/client';
import { SessionsBar } from '../../../src/shell/sessions-bar.tsx';
import { SessionRowMenu } from '../../../src/shell/session-row-menu.tsx';
import { sessionView } from '../../../tests/support/sessions.ts';

const NOW = '2026-10-30T09:00:00.000Z';
const make = (id, label, status) =>
  sessionView(id, {
    config: { teammate: id, label, name: label, mode: 'interactive', cwd: '/home/kirin/Workspace/personal/ferretry' },
    state: { status, lastActivityAt: NOW, ...(status === 'stopped' ? { attention: { open: 1, first: 'A1', ask: 'Which lanes should the board have?', latestAt: NOW } } : {}) },
  });
const sessions = [make('stopped-one', 'Home manager', 'stopped'), make('running-one', 'Plain chores', 'running')];
const compact = window.innerWidth < 640;
const root = document.getElementById('root');
createRoot(root).render(
  <div className="bg-bg text-fg" data-shot="" style={{ width: compact ? 390 : 340, minHeight: 560 }}>
    <SessionsBar active={null} activeSessionId="running-one" canMutate daemonId={'harness'} machineName="Liftoff EC2"
      machines={[]} onAddMachine={() => {}} onClose={() => {}} onCollapse={() => {}} onNavigate={() => {}}
      onOpenPalette={() => {}} presentation="column" projects={[]} sessions={sessions} />
    <SessionRowMenu state={{ view: sessions[0], x: compact ? 40 : 60, y: 330 }} sessions={sessions} canMutate onClose={() => {}} onRun={() => {}} onBulkStop={() => {}} touch={compact} />
  </div>,
);
`;

const html = (theme: string, script: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="/app.css" /></head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/${script}"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
await Bun.write(join(outDir, 'bar-entry.tsx'), BAR_ENTRY);
run('bun', ['build', join(outDir, 'bar-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'bar-entry.tsx'));
run('bun', ['build', join(harnessDir, 'phone-chat-page.tsx'), '--outdir', outDir, '--target', 'browser']);
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
  async fetch(request) {
    const url = new URL(request.url);
    const theme = url.searchParams.get('theme') ?? 'studio-dark';
    if (url.pathname === '/chat')
      return new Response(html(theme, 'phone-chat-page.js'), { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/bar')
      return new Response(html(theme, 'bar-entry.js'), { headers: { 'content-type': 'text/html' } });
    const built = Bun.file(join(outDir, url.pathname));
    if (await built.exists()) return new Response(built);
    const shipped = Bun.file(join(packageDir, 'public', url.pathname));
    return (await shipped.exists()) ? new Response(shipped) : new Response(null, { status: 404 });
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;
const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const label = `${viewport.name}/${scheme}`;
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        deviceScaleFactor: 2,
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        page.on('pageerror', error => process.stderr.write(`⚠️ page error: ${error.message}\n`));

        for (const status of ['stopped', 'running'] as const) {
          await page.goto(`${server.url}chat?theme=studio-${scheme}&status=${status}&turn=idle`);
          const header = page.locator('[data-session-bar]');
          await header.waitFor();
          await page.waitForTimeout(500);
          const names = await header
            .locator('button')
            .evaluateAll(buttons =>
              buttons.map(b => `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`.trim()),
            );
          const offers = names.some(n => /resume|start/iu.test(n));
          process.stdout.write(`${label} chat header (${status}): ${JSON.stringify(names)}\n`);
          if (status === 'stopped' && !offers) fail(`${label}: a stopped ferret's chat header offers no Resume`);
          if (status === 'running' && offers) fail(`${label}: a running ferret's chat header offers Resume`);
          if (status === 'stopped') {
            const target = join(shotsDir, `chat-header-stopped-${viewport.name}-${scheme}.png`);
            await page.screenshot({ path: target });
            process.stdout.write(`📸 ${target}\n`);
          }
        }

        await page.goto(`${server.url}bar?theme=studio-${scheme}`);
        await page.getByRole('menuitem').first().waitFor();
        const menu = await page.getByRole('menuitem').allTextContents();
        process.stdout.write(`${label} row menu (stopped): ${JSON.stringify(menu)}\n`);
        if (!menu.some(t => /resume/iu.test(t))) fail(`${label}: a stopped ferret's row menu offers no Resume`);
        const target = join(shotsDir, `list-row-stopped-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: target });
        process.stdout.write(`📸 ${target}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
