/**
 * Screenshots of the sessions bar for the title-and-glyph fix: a session carrying a batch label shows its
 * NAME (a rename is seen, not hidden behind "diene-cyan"), and the Outdated mark is a small refresh glyph in
 * the marks cell, so a long name is no longer cut for a word. Light and dark studio themes, phone and
 * desktop. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/label-rename-screenshot.tsx --prefix <before|after> [--out <dir>]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
const prefixFlag = process.argv.indexOf('--prefix');
const prefix = prefixFlag === -1 ? 'after' : (process.argv[prefixFlag + 1] ?? 'after');
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

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { SessionTopBar } from '../../src/components/session-top-bar.tsx';
import { RestartOverlayProvider } from '../../src/features/restart-outdated/restart-overlay.tsx';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import { sessionView } from '../../tests/support/sessions.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const make = (id, name, label, sections, extra = {}) => ({
  ...sessionView(id, {
    config: { teammate: id, name, ...(label === undefined ? {} : { label }), mode: 'interactive', cwd: '/work/ferretry' },
    state: { lastActivityAt: NOW, ...extra },
  }),
  ...(sections === undefined ? {} : { outdated: { sections } }),
});
const attention = { open: 1, first: 'A1', ask: 'Which web address?', latestAt: NOW };
const open = make('cyan', 'CyanPrint renamed to the real task name', 'diene-cyan', ['pack', 'notify']);
const sessions = [
  open,
  make('quest', 'Questions for the owner about launch', 'liftoff-batch', ['tools'], { attention }),
  make('diene', 'Diene work on the release gates', 'diene-cyan', ['agenda']),
  make('labelled', 'Labelled sessions keep their own name', 'diene-cyan', ['pack']),
  make('ora', 'Plain chores'),
];
const compact = window.innerWidth < 640;
const restart = async () => ({
  restarted: [{ id: 'maryah', name: 'Maryah' }],
  queued: [
    { id: 'hadi', name: 'Hadi', reason: 'own-session' },
    { id: 'wren', name: 'Wren', reason: 'mid-turn' },
  ],
  skipped: [],
  failed: [],
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <RestartOverlayProvider>
  <div className="flex flex-col bg-bg text-fg" style={{ minHeight: 560 }} data-shot="">
    <SessionTopBar
      actions={null}
      compact={compact}
      project="ferretry"
      session={open}
      onOpenSessions={compact ? () => {} : undefined}
    />
    <div style={{ display: 'flex' }}>
      <SessionsBar
        active={null}
        activeSessionId="hadi"
        daemonId={'harness'}
        machineName="studio"
        machines={[]}
        onAddMachine={() => {}}
        onClose={() => {}}
        onCollapse={() => {}}
        onNavigate={() => {}}
        onOpenPalette={() => {}}
        onRestartOutdated={restart}
        presentation={compact ? 'drawer' : 'column'}
        projects={[]}
        sessions={sessions}
      />
    </div>
  </div>
  </RestartOverlayProvider>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg"><div id="root"></div><script type="module" src="/label-rename-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
await Bun.write(join(outDir, 'label-rename-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'label-rename-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
rmSync(join(outDir, 'label-rename-entry.tsx'));
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
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    const file = Bun.file(join(outDir, url.pathname));
    return (await file.exists()) ? new Response(file) : new Response('missing', { status: 404 });
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
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('[data-session-bar]').waitFor({ state: 'visible' });
        const shoot = async (scene: string): Promise<void> => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scene} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `label-rename-${prefix}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        };
        await shoot('list');
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
