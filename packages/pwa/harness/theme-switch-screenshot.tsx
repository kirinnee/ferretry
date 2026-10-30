/**
 * Screenshots of the theme quick switch, which lives in a header that is already there. Each scene is shot
 * closed and with the popover open, in the light and dark studio themes:
 *
 *   * desktop — the session header's action row, the switch last after Actions (the REAL `SessionTopBar`, 1440px).
 *   * desktop-page — a page with no session header: the Insights tab strip carries it at its right end (the REAL
 *     `InsightsFrame` and `PageThemeSwitch`, 1440px).
 *   * phone — the top bar of a non-session page (the REAL `AppBar` with its theme slot, 390px).
 *
 * A session page on a phone has no switch in its bar: it is Actions ▾ › Theme… there
 * (`phone-chat-screenshot.ts` shoots and checks it).
 *
 *   bun harness/theme-switch-screenshot.tsx   # writes harness/out/theme-switch-<scene>-<scheme>-<state>.png
 *
 * The popover writes the same `fy-theme` preference Settings does; this harness only looks. Review evidence;
 * nothing compares the PNGs.
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
import { AppBar, AppTabBar } from '../../src/shell/app-bar.tsx';
import { SessionTopBar } from '../../src/components/session-top-bar.tsx';
import { InsightsFrame } from '../../src/shell/insights-frame.tsx';
import { ThemeToggle } from '../../src/shell/theme-toggle.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { sessionView } from '../../tests/support/sessions.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.local:7431', deviceId: 'harness' });
const session = sessionView('s1', { config: { teammate: 'hadi', label: 'Fix the sign-in' } });
const noop = () => undefined;
const scene = new URLSearchParams(location.search).get('scene');

const Body = () => (
  <div className="flex-1 p-4 text-ui text-muted">
    <p className="m-0">The page under the bar. The switch shares the bar; there is no strip of its own.</p>
  </div>
);
const Menu = () => (
  <button type="button" className="kt-btn kt-btn--sm" data-variant="ghost">Actions ▾</button>
);

const desktop = (
  <div className="kt-shell flex flex-col overflow-hidden">
    <SessionTopBar
      actions={
        <>
          <button type="button" className="kt-btn kt-btn--sm">Interrupt</button>
          <button type="button" className="kt-btn kt-btn--sm" data-variant="danger">Stop</button>
        </>
      }
      compact={false}
      menu={<Menu />}
      onToggleInfo={noop}
      project="ferretry"
      session={session}
      trailing={<ThemeToggle iconOnly />}
      turn="your-turn"
    />
    <Body />
  </div>
);

const desktopPage = (
  <div className="kt-shell flex flex-col overflow-hidden">
    <InsightsFrame current="analytics" daemonId={connection.daemonId} onNavigate={noop}>
      <Body />
    </InsightsFrame>
  </div>
);

const phone = (
  <div className="kt-shell flex flex-col overflow-hidden">
    <AppBar
      crumbs={[{ label: 'Projects' }]}
      daemon={connection.daemonId}
      onOpenPalette={noop}
      onOpenSidebar={noop}
      sessionCount={4}
      active="projects"
      tabBarShown
      themeToggle={<ThemeToggle touch />}
    />
    <Body />
    <AppTabBar daemon={connection.daemonId} active="projects" onOpenPalette={noop} />
  </div>
);

createRoot(document.getElementById('root')).render(
  scene === 'desktop' ? desktop : scene === 'desktop-page' ? desktopPage : phone,
);
`;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/theme-switch-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'theme-switch-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'theme-switch-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
    if (url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const SCENES = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'desktop-page', width: 1440, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
] as const;

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const scene of SCENES) {
      const context = await browser.newContext({
        viewport: { width: scene.width, height: scene.height },
        deviceScaleFactor: 2,
        isMobile: scene.mobile,
        hasTouch: scene.mobile,
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${server.url}?scene=${scene.name}`);
        const trigger = page.locator('[data-theme-trigger]');
        await trigger.waitFor({ state: 'visible' });
        const box = await trigger.boundingBox();
        if (box === null) fail(`${scene.name} ${scheme}: the trigger has no box`);
        if (box !== null && scene.mobile && (box.width < 44 || box.height < 44)) {
          fail(`${scene.name} ${scheme}: the trigger is ${box.width}x${box.height}, under the 44px target`);
        }
        if (box !== null && box.x + box.width > scene.width)
          fail(`${scene.name} ${scheme}: the trigger leaves the viewport`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scene.name} ${scheme} scrolls sideways by ${overflow}px`);
        for (const state of ['closed', 'open'] as const) {
          if (state === 'open') {
            await trigger.click();
            await page.locator('[role="dialog"][aria-label="Theme"]').waitFor({ state: 'visible' });
            const panel = await page.locator('[role="dialog"][aria-label="Theme"]').boundingBox();
            if (panel !== null && (panel.x < 0 || panel.x + panel.width > scene.width)) {
              fail(`${scene.name} ${scheme}: the popover leaves the viewport`);
            }
          }
          const target = join(outDir, `theme-switch-${scene.name}-${scheme}-${state}.png`);
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
