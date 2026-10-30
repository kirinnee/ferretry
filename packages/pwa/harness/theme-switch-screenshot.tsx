/**
 * Screenshots and close-path checks of the theme picker. Each scene is shot closed and with the picker open
 * (its ✕ and Done showing), in the light and dark studio themes, and the open picker must close every way out
 * (owner, 2026-10-30: "make sure i can close it!"): ✕, Done, Escape, a tap outside it, and the platform Back.
 *
 *   * desktop — the session header, the theme icon beside Interrupt/Stop (the REAL `SessionTopBar`, 1440px).
 *   * phone-chat — the compact session header, the theme icon beside ⓘ (the REAL `SessionTopBar`, 390px).
 *   * desktop-page — a page with no session header: the Insights tab strip carries it at its right end (the REAL
 *     `InsightsFrame` and `PageThemeSwitch`, 1440px).
 *   * phone — the top bar of a non-session page (the REAL `AppBar` with its theme slot, 390px).
 *
 *   bun harness/theme-switch-screenshot.tsx   # writes harness/out/theme-switch-<scene>-<scheme>-<state>.png
 *
 * The picker writes the same `fy-theme` preference Settings does; this harness only looks and closes it. The
 * PNGs are review evidence; nothing compares them.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

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
      session={session}
      themeToggle={<ThemeToggle iconOnly />}
      turn="your-turn"
    />
    <Body />
  </div>
);

const phoneChat = (
  <div className="kt-shell flex flex-col overflow-hidden">
    <SessionTopBar
      actions={null}
      compact
      menu={<Menu />}
      onOpenSessions={noop}
      onToggleInfo={noop}
      session={session}
      themeToggle={<ThemeToggle iconOnly touch />}
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
  scene === 'desktop'
    ? desktop
    : scene === 'phone-chat'
      ? phoneChat
      : scene === 'desktop-page'
        ? desktopPage
        : phone,
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
  { name: 'phone-chat', width: 390, height: 844, mobile: true },
  { name: 'desktop-page', width: 1440, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
] as const;

const PANEL = '[role="dialog"][aria-label="Theme"]';

/** A point beside the open theme picker (on whichever side has room) at height `y`, i.e. outside it. */
const freeSide = async (page: Page, y: number): Promise<{ x: number; y: number }> => {
  const width = page.viewportSize()?.width ?? 0;
  const panel = await page.locator('[role="dialog"][aria-label="Theme"]').boundingBox();
  const left = panel === null ? 0 : panel.x;
  const right = panel === null ? 0 : width - (panel.x + panel.width);
  return { x: left >= right ? Math.max(1, left / 2) : width - Math.max(1, right / 2), y };
};

const checkClosePaths = async (
  page: Page,
  label: string,
  touch: boolean,
  width: number,
  height: number,
): Promise<void> => {
  const press = async (selector: string): Promise<void> => {
    const target = page.locator(selector).first();
    if (touch) await target.tap();
    else await target.click();
  };
  const isGone = async (): Promise<boolean> =>
    await page
      .locator(PANEL)
      .waitFor({ state: 'hidden', timeout: 3_000 })
      .then(
        () => true,
        () => false,
      );
  const open = async (): Promise<void> => {
    await press('[data-theme-trigger]');
    await page.locator(PANEL).waitFor({ state: 'visible', timeout: 3_000 });
    await page.waitForTimeout(150);
  };
  const startPath = new URL(page.url()).pathname;
  const outside = { x: 0, y: Math.min(height - 8, 600) };
  const paths: readonly [string, () => Promise<void>][] = [
    ['the ✕', () => press('[data-theme-close]')],
    ['Done', () => press('[data-theme-done]')],
    ['Escape', () => page.keyboard.press('Escape')],
    [
      'a tap outside it',
      async () => {
        const at = await freeSide(page, outside.y);
        if (touch) await page.touchscreen.tap(at.x, at.y);
        else await page.mouse.click(at.x, at.y);
      },
    ],
    ['the platform Back', () => page.evaluate(() => history.back())],
  ];
  // A picker left open from the shots above is closed first, so every path starts from a fresh open.
  if ((await page.locator(PANEL).count()) > 0) {
    await page.keyboard.press('Escape');
    if (!(await isGone())) fail(`${label}: Escape did not clear the picker left open by the shot`);
  }
  await open();
  const close = await page.locator('[data-theme-close]').first().boundingBox();
  if (
    close === null ||
    close.x < 0 ||
    close.y < 0 ||
    close.x + close.width > width ||
    close.y + close.height > height
  ) {
    fail(`${label}: the ✕ is not on screen (${JSON.stringify(close)})`);
  }
  await page.keyboard.press('Escape');
  if (!(await isGone())) fail(`${label}: Escape did not close the picker`);
  for (const [path, act] of paths) {
    await open();
    await act();
    if (!(await isGone())) fail(`${label}: ${path} did not close the picker`);
    if (new URL(page.url()).pathname !== startPath) fail(`${label}: ${path} left the page it was opened over`);
    process.stdout.write(`✅ ${label}: ${path} closes it\n`);
  }
};

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
              fail(`${scene.name} ${scheme}: the popover leaves the viewport (${JSON.stringify(panel)})`);
            }
          }
          const target = join(outDir, `theme-switch-${scene.name}-${scheme}-${state}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        }
        await checkClosePaths(page, `${scene.name} ${scheme}`, scene.mobile, scene.width, scene.height);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
