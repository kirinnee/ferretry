/**
 * The phone session top bar and the sessions list rows, at 360 / 390 / 430px in the light and dark studio
 * themes (an iPhone-like and an Android-like context), plus the desktop sessions column at 1440.
 *
 *   bun harness/mobile-ui3-screenshot.tsx              # writes harness/out/mobile-ui3-after-*.png
 *   bun harness/mobile-ui3-screenshot.tsx --before     # the same fixture, named -before- (run it on the old code)
 *
 * It renders the REAL `SessionTopBar` (healthy, reconnecting, offline, needs-you and a long name) and the
 * REAL `SessionsBar` against invented sessions, and fails when anything in either scrolls sideways or
 * when the top bar's controls overlap or leave the screen at any phone width.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
const TAG = process.argv.includes('--before') ? 'before' : 'after';

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { ChevronDown } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { LiveStreamIndicator } from '../../src/components/live-stream-indicator.tsx';
import { SessionTopBar } from '../../src/components/session-top-bar.tsx';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';

const NOW = Date.parse('2026-10-20T08:00:00.000Z');
const ago = minutes => new Date(NOW - minutes * 60_000).toISOString();
const session = (id, teammate, label, status, extra = {}) => ({
  config: { id, name: label ?? 'Session ' + id, teammate, label, agent: 'claude', harness: 'claude', modelHint: 'claude-opus-5', mode: 'auto', cwd: '/work/' + id, createdAt: ago(600), updatedAt: ago(1), ...extra },
  state: { id, status, turn: 4, lastActivityAt: ago(1) },
  directory: '/work/' + id,
});
const SESSIONS = [
  session('hm', 'hadi', 'Home Manager', 'running'),
  session('dw', 'maryah', 'Diene Work', 'awaiting_user'),
  session('fr', 'ottilie', 'Fix the stuck sign-in on the checkout page', 'running'),
  session('nl', 'wren', undefined, 'stopped', { name: undefined }),
];
const view = new URLSearchParams(location.search).get('view');
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

const menu = <button aria-label="Actions" className="fy-session-bar__icon" type="button"><ChevronDown aria-hidden="true" size={18} /></button>;
const needsYou = <button className="fy-needs-you" type="button">needs you</button>;
const stream = status => <LiveStreamIndicator compact onReconnect={() => undefined} quiet status={status} />;
const bar = (title, s, status, compact) => (
  <section data-case={title} style={{ marginBottom: 14 }}>
    <p style={{ font: '11px/1 monospace', margin: '0 12px 4px', opacity: 0.6 }}>{title}</p>
    <SessionTopBar
      actions={null}
      compact={compact}
      menu={menu}
      onOpenSessions={() => undefined}
      onToggleInfo={() => undefined}
      project="ferretry"
      session={s}
      status={status}
      subFerrets={null}
      switches={{ learning: true, hypermedia: true, pack: true }}
      turn="your-turn"
    />
  </section>
);

const long = session('lg', 'bartholomew-the-third', 'Rewrite the quarterly reconciliation job', 'running');
const page =
  view === 'bar' ? (
    <main data-fixture="" style={{ background: 'var(--bg)', minHeight: '100vh', paddingTop: 8 }}>
      {bar('healthy', SESSIONS[0], stream('live'), true)}
      {bar('reconnecting', SESSIONS[0], stream('reconnecting'), true)}
      {bar('offline', SESSIONS[1], stream('disconnected'), true)}
      {bar('needs you + reconnecting', SESSIONS[1], <>{needsYou}{stream('reconnecting')}</>, true)}
      {bar('long name + offline', long, <>{needsYou}{stream('disconnected')}</>, true)}
    </main>
  ) : (
    <div data-fixture="" style={{ height: view === 'column' ? 760 : 700, display: 'flex' }}>
      <SessionsBar
        active={null}
        activeSessionId="hm"
        daemonId="studio"
        machineName="studio"
        machines={[{ daemonId: 'studio', name: 'studio' }]}
        now={NOW}
        onAddMachine={() => undefined}
        onClose={() => undefined}
        onCollapse={() => undefined}
        onNavigate={() => undefined}
        onOpenPalette={() => undefined}
        presentation={view === 'column' ? 'column' : 'drawer'}
        projects={[]}
        sessions={SESSIONS}
      />
    </div>
  );
createRoot(root).render(page);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/mobile-ui3-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'mobile-ui3-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'mobile-ui3-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

/** Every control in the bar must sit inside the screen and none may overlap another. */
const checkBar = async (page: Page, label: string): Promise<void> => {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const width = window.innerWidth;
    for (const header of document.querySelectorAll('[data-session-bar]')) {
      const name = header.parentElement?.getAttribute('data-case') ?? '?';
      const boxes = [...header.querySelectorAll('button, h1, .fy-needs-you, .fy-live-quiet svg')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(b => b.r.width > 0 && b.r.height > 0);
      for (const { el, r } of boxes)
        if (r.left < -0.5 || r.right > width + 0.5)
          out.push(name + ': ' + (el.getAttribute('aria-label') ?? el.tagName) + ' leaves the screen');
      for (let i = 0; i < boxes.length; i += 1)
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
          const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
          if (x > 1 && y > 1)
            out.push(
              name +
                ': ' +
                (a.el.getAttribute('aria-label') ?? a.el.tagName) +
                ' [' +
                Math.round(a.r.left) +
                '-' +
                Math.round(a.r.right) +
                '] overlaps ' +
                (b.el.getAttribute('aria-label') ?? b.el.tagName) +
                ' [' +
                Math.round(b.r.left) +
                '-' +
                Math.round(b.r.right) +
                ']',
            );
        }
    }
    return out;
  });
  if (problems.length > 0 && TAG === 'before')
    process.stdout.write(`⚠️  (expected on the old bar) ${label}: ${problems.join('; ')}\n`);
  else if (problems.length > 0) fail(`${label}: ${problems.join('; ')}`);
};

const WIDTHS = [360, 390, 430] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;
const PHONES = [
  ['iphone', IPHONE_UA],
  ['android', ANDROID_UA],
] as const;

try {
  for (const theme of THEMES) {
    const scheme = theme.endsWith('dark') ? 'dark' : 'light';
    const shoot = async (
      file: string,
      context: Awaited<ReturnType<typeof browser.newContext>>,
      view: string,
      check: boolean,
    ) => {
      const page = await context.newPage();
      await page.goto(`${server.url}?theme=${theme}&view=${view}`);
      await page.locator('[data-fixture]').waitFor({ state: 'visible' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) fail(`${file} scrolls sideways by ${overflow}px`);
      if (check) await checkBar(page, file);
      const path = join(outDir, `mobile-ui3-${TAG}-${file}.png`);
      await page.screenshot({ path, fullPage: true });
      process.stdout.write(`📸 ${path}\n`);
      await page.close();
    };
    for (const [kind, userAgent] of PHONES) {
      for (const width of WIDTHS) {
        const context = await browser.newContext({
          viewport: { width, height: 760 },
          isMobile: true,
          hasTouch: true,
          userAgent,
          deviceScaleFactor: 2,
          colorScheme: scheme,
        });
        try {
          await shoot(`bar-${kind}-${width}-${theme}`, context, 'bar', true);
          if (kind === 'iphone') await shoot(`drawer-${kind}-${width}-${theme}`, context, 'drawer', false);
        } finally {
          await context.close();
        }
      }
    }
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    try {
      await shoot(`sidebar-desktop-${theme}`, desktop, 'column', false);
    } finally {
      await desktop.close();
    }
  }
  process.stdout.write('✅ nothing scrolls sideways; the phone bar never clips or overlaps\n');
} finally {
  await browser.close();
  server.stop();
}
