/**
 * Build the shell harness, serve it on an ephemeral loopback port, and
 * screenshot it at both viewports.
 *
 * Dev-only. It never runs in CI and is not part of the shipped bundle: its whole
 * job is to make "does the port still look like the original?" a thing a human
 * can answer by opening two PNGs.
 *
 * It drives the browser through playwright-core with the system Chrome, exactly
 * as the visual integration tests already do, and aborts every request that
 * leaves the loopback origin — a shell harness has no business reaching the
 * network.
 *
 *   bun harness/screenshot.ts            # writes harness/out/*.png
 *   bun harness/screenshot.ts --serve    # leave it running to look at by hand
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

/** Harness sections that live below the fold and are captured element by element. */
const SECTIONS = [
  'harness-new-session',
  'harness-session-screen',
  'harness-composer-markdown',
  'harness-lineage',
  'harness-marks',
  'harness-chat-width',
  'harness-dead-pane',
  'harness-fleet-sidebar',
  'harness-runtime-controls',
  'harness-pending-sends',
] as const;

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { cwd: packageDir, stdio: 'inherit' });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`);
}

mkdirSync(outDir, { recursive: true });

process.stdout.write('📦 bundling the harness page…\n');
run('bun', ['build', 'harness/main.tsx', '--outdir', 'harness/out', '--target', 'browser']);

process.stdout.write('🎨 compiling the design system…\n');
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  'harness/out/app.css',
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(Bun.file(path === '/' ? join(harnessDir, 'index.html') : join(outDir, path)));
  },
});

try {
  if (process.argv.includes('--serve')) {
    process.stdout.write(`🌐 serving ${server.url} — Ctrl-C to stop\n`);
    await new Promise(() => {});
  }

  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  if (chrome === null) fail('no system Chrome or Chromium found');

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== server.url.origin) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      await page.goto(server.url.toString());
      const target = join(outDir, `${viewport.name}.png`);
      await page.screenshot({ path: target });
      process.stdout.write(`📸 ${viewport.name} ${viewport.width}x${viewport.height} -> ${target}\n`);

      if (viewport.name === 'desktop') {
        const fleetRailTarget = join(outDir, `fleet-navigation-rail-${viewport.name}.png`);
        await page.getByLabel('Fleet navigation rail preview').screenshot({ path: fleetRailTarget });
        process.stdout.write(`📸 fleet navigation rail -> ${fleetRailTarget}\n`);
      }

      const browserTarget = join(outDir, `remote-browser-${viewport.name}.png`);
      await page.getByAltText('Live remote browser frame').waitFor({ state: 'visible' });
      await page.getByLabel('Remote browser display').screenshot({ path: browserTarget });
      process.stdout.write(`📸 remote browser -> ${browserTarget}\n`);
      // The whole pane, not just the display: the tab strip, address bar and
      // lifecycle controls are the part that has to match the original.
      const browserPaneTarget = join(outDir, `remote-browser-pane-${viewport.name}.png`);
      await page.locator('[data-harness="remote-browser"]').screenshot({ path: browserPaneTarget });
      process.stdout.write(`📸 remote browser pane -> ${browserPaneTarget}\n`);
      const learningTarget = join(outDir, `learning-${viewport.name}.png`);
      await page.getByLabel('Learning proposals').screenshot({ path: learningTarget });
      process.stdout.write(`📸 learning -> ${learningTarget}\n`);
      const analyticsTarget = join(outDir, `analytics-${viewport.name}.png`);
      await page.getByLabel('Analytics cost ledger').screenshot({ path: analyticsTarget });
      process.stdout.write(`📸 analytics -> ${analyticsTarget}\n`);
      const analyticsResponseTarget = join(outDir, `analytics-response-${viewport.name}.png`);
      await page.getByLabel('Analytics raw query result').screenshot({ path: analyticsResponseTarget });
      process.stdout.write(`📸 analytics response -> ${analyticsResponseTarget}\n`);
      const analyticsSeriesTarget = join(outDir, `analytics-time-series-${viewport.name}.png`);
      await page.getByLabel('Analytics time series').screenshot({ path: analyticsSeriesTarget });
      process.stdout.write(`📸 analytics time series -> ${analyticsSeriesTarget}\n`);
      const globalAnalyticsTarget = join(outDir, `global-analytics-${viewport.name}.png`);
      const globalAnalytics = page.getByRole('main', { name: 'Global analytics' });
      // The production shell correctly locks html/body to one viewport and
      // gives route pages their own scroller. In this harness the route is far
      // down a stacked review page, so Chrome cannot stitch its full scroll
      // area in place on a phone: the top is blank and the tail is clipped.
      // Clone the already-rendered route into the viewport for this one shot.
      // It keeps the exact component DOM/styles while removing only the
      // harness stacking context that no production route has.
      await globalAnalytics.evaluate(element => {
        document.documentElement.style.height = 'auto';
        document.documentElement.style.overflow = 'auto';
        document.body.style.height = 'auto';
        document.body.style.overflow = 'auto';
        document.body.replaceChildren(element.cloneNode(true));
      });
      await page.getByRole('main', { name: 'Global analytics' }).screenshot({ path: globalAnalyticsTarget });
      process.stdout.write(`📸 global analytics -> ${globalAnalyticsTarget}\n`);
      // Restore the live React fixture after the static clone; later shots
      // still exercise their real components, refs and async state.
      await page.goto(server.url.toString());
      const sessionAnalyticsTarget = join(outDir, `session-analytics-${viewport.name}.png`);
      const sessionAnalytics = page.getByLabel('Session analytics', { exact: true });
      await sessionAnalytics.getByText('1 matched · 5 indexed').waitFor({ state: 'visible' });
      await sessionAnalytics.screenshot({ path: sessionAnalyticsTarget });
      process.stdout.write(`📸 session analytics -> ${sessionAnalyticsTarget}\n`);
      const composerSettingsTarget = join(outDir, `markdown-composer-settings-${viewport.name}.png`);
      await page.getByLabel('Markdown composer settings').screenshot({ path: composerSettingsTarget });
      process.stdout.write(`📸 Markdown composer settings -> ${composerSettingsTarget}\n`);
      const dictationShortcutTarget = join(outDir, `dictation-shortcut-${viewport.name}.png`);
      await page.getByLabel('Dictation shortcut settings').screenshot({ path: dictationShortcutTarget });
      process.stdout.write(`📸 Dictation shortcut settings -> ${dictationShortcutTarget}\n`);
      const dictationPanelTarget = join(outDir, `dictation-panel-${viewport.name}.png`);
      await page.locator('#harness-dictation-panel').screenshot({ path: dictationPanelTarget });
      process.stdout.write(`📸 Dictation panel -> ${dictationPanelTarget}\n`);
      // The dictation settings surface is several viewports tall. Chrome culls
      // painting outside the viewport while an element screenshot scrolls, so
      // the capture is taken against a temporarily tall viewport and the real
      // one is restored immediately — otherwise most of the image is black.
      const dictationSettingsTarget = join(outDir, `dictation-settings-${viewport.name}.png`);
      await page.setViewportSize({ width: viewport.width, height: 3_000 });
      await page.locator('#harness-dictation-settings').screenshot({ path: dictationSettingsTarget });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      process.stdout.write(`📸 Dictation settings -> ${dictationSettingsTarget}\n`);
      const dictationMicTarget = join(outDir, `dictation-mic-${viewport.name}.png`);
      await page.locator('#harness-dictation-mic').screenshot({ path: dictationMicTarget });
      process.stdout.write(`📸 Dictation mic button -> ${dictationMicTarget}\n`);
      const notificationSettingsTarget = join(outDir, `notification-settings-${viewport.name}.png`);
      await page.getByLabel('Notification settings').first().screenshot({ path: notificationSettingsTarget });
      process.stdout.write(`📸 Notification settings -> ${notificationSettingsTarget}\n`);
      const settingsPageTarget = join(outDir, `settings-page-${viewport.name}.png`);
      await page.getByLabel('Settings page preview').screenshot({ path: settingsPageTarget });
      process.stdout.write(`📸 Settings page -> ${settingsPageTarget}\n`);
      const learningHeaderTarget = join(outDir, `learning-header-${viewport.name}.png`);
      await page.getByLabel('Learning header').screenshot({ path: learningHeaderTarget });
      process.stdout.write(`📸 Learning header -> ${learningHeaderTarget}\n`);
      const attentionTarget = join(outDir, `attention-${viewport.name}.png`);
      await page.getByLabel('Attention ledger').screenshot({ path: attentionTarget });
      process.stdout.write(`📸 Attention ledger -> ${attentionTarget}\n`);
      const pinsTriggerTarget = join(outDir, `pins-trigger-${viewport.name}.png`);
      await page.getByLabel('Pins trigger').screenshot({ path: pinsTriggerTarget });
      process.stdout.write(`📸 Pins trigger -> ${pinsTriggerTarget}\n`);
      const pinsTarget = join(outDir, `pins-${viewport.name}.png`);
      await page.getByLabel('Pins ledger').screenshot({ path: pinsTarget });
      process.stdout.write(`📸 Pins ledger -> ${pinsTarget}\n`);
      const pairingTarget = join(outDir, `pairing-${viewport.name}.png`);
      await page.getByLabel('Daemon pairing').screenshot({ path: pairingTarget });
      process.stdout.write(`📸 pairing ${viewport.name} -> ${pairingTarget}\n`);
      const wardenAttentionTarget = join(outDir, `warden-attention-${viewport.name}.png`);
      await page.locator('[aria-labelledby="warden-attention-heading"]').screenshot({ path: wardenAttentionTarget });
      process.stdout.write(`📸 Warden attention -> ${wardenAttentionTarget}\n`);
      const wardenStripTarget = join(outDir, `warden-strip-${viewport.name}.png`);
      await page.locator('[data-harness="warden-strip"]').screenshot({ path: wardenStripTarget });
      process.stdout.write(`📸 Warden strip -> ${wardenStripTarget}\n`);
      const taskDagTarget = join(outDir, `task-dag-${viewport.name}.png`);
      await page.locator('[data-task-graph]').screenshot({ path: taskDagTarget });
      process.stdout.write(`📸 Task dependency graph -> ${taskDagTarget}\n`);
      const sessionTasksTarget = join(outDir, `session-tasks-${viewport.name}.png`);
      await page.getByLabel('Session task board').screenshot({ path: sessionTasksTarget });
      process.stdout.write(`📸 Session task board -> ${sessionTasksTarget}\n`);
      const taskNameTarget = join(outDir, `task-name-${viewport.name}.png`);
      await page.getByLabel('Task name').screenshot({ path: taskNameTarget });
      process.stdout.write(`📸 Task name -> ${taskNameTarget}\n`);

      const unlockTarget = join(outDir, `attachment-unlock-${viewport.name}.png`);
      await page.goto(`${server.url}?attachment-unlock`);
      await page.getByRole('dialog', { name: 'Unlock encrypted PDF' }).screenshot({ path: unlockTarget });
      process.stdout.write(`📸 attachment unlock -> ${unlockTarget}\n`);
      await page.goto(server.url.toString());

      // The harness stacks every ported surface down one column, so most of it
      // is below the fold. A full-page stitch cannot prove those: the app bar
      // is sticky, and Chrome repaints a fixed layer into every stitched tile.
      // So each surface below the fold is captured as ITS OWN element shot,
      // which is both immune to that and easier to compare against the
      // original screen by screen.
      for (const section of SECTIONS) {
        const element = page.locator(`#${section}`);
        await element.scrollIntoViewIfNeeded();
        const sectionTarget = join(outDir, `${viewport.name}-${section}.png`);
        await element.screenshot({ path: sectionTarget });
        process.stdout.write(`📸 ${viewport.name} ${section} -> ${sectionTarget}\n`);
      }

      const ledgerTarget = join(outDir, `send-ledger-${viewport.name}.png`);
      await page.getByLabel('Send ledger rows').screenshot({ path: ledgerTarget });
      process.stdout.write(`📸 send ledger -> ${ledgerTarget}
`);

      // A tool run's EXPANDED state is the other half of its design — the slim
      // chrome line is what it looks like at rest, and the code surfaces only
      // exist after a deliberate click — so it gets its own pass.
      const toolGroup = page.locator('[data-transcript-kind="tool"]').first();
      await toolGroup.scrollIntoViewIfNeeded();
      await toolGroup.getByRole('button').first().click();
      await toolGroup.getByRole('button').nth(1).click();
      const toolGroupTarget = join(outDir, `tool-group-${viewport.name}.png`);
      await toolGroup.screenshot({ path: toolGroupTarget });
      process.stdout.write(`📸 tool group -> ${toolGroupTarget}\n`);

      // The context menu is anchored and `fixed`, which is exactly what a
      // full-page stitch cannot capture — so it gets its own viewport-sized
      // pass behind a fragment.
      const menuTarget = join(outDir, `${viewport.name}-menu.png`);
      await page.goto(`${server.url}#menu`);
      await page.reload();
      // Wait for the rows, not just for load: the menu paints hidden and is
      // revealed by a layout effect once it has been measured and clamped.
      await page.locator('[role="menuitem"]').last().waitFor({ state: 'visible' });
      await page.screenshot({ path: menuTarget });
      process.stdout.write(`📸 ${viewport.name} context menu -> ${menuTarget}\n`);

      const paletteTarget = join(outDir, `${viewport.name}-palette.png`);
      await page.goto(`${server.url}#palette`);
      await page.reload();
      await page.locator('[role="option"]').last().waitFor({ state: 'visible' });
      await page.screenshot({ path: paletteTarget });
      process.stdout.write(`📸 ${viewport.name} command palette -> ${paletteTarget}\n`);

      const rowMenuTarget = join(outDir, `${viewport.name}-row-menu.png`);
      await page.goto(`${server.url}#row-menu`);
      await page.reload();
      await page.locator('[role="menuitem"]').last().waitFor({ state: 'visible' });
      await page.screenshot({ path: rowMenuTarget });
      process.stdout.write(`📸 ${viewport.name} session row menu -> ${rowMenuTarget}\n`);

      // The bulk-stop confirmation is a fixed overlay like the menu and the
      // palette, and its two states are different screens: what will die, and
      // what did.
      for (const [fragment, name] of [
        ['#stop', 'stop-confirm'],
        ['#stop-results', 'stop-results'],
      ] as const) {
        const stopTarget = join(outDir, `${viewport.name}-${name}.png`);
        await page.goto(`${server.url}${fragment}`);
        await page.reload();
        await page.getByRole('dialog', { name: /confirm|results/ }).waitFor({ state: 'visible' });
        await page.screenshot({ path: stopTarget });
        process.stdout.write(`📸 ${viewport.name} ${name} -> ${stopTarget}\n`);
      }

      // The fleet drawer only exists below the drawer breakpoint, and only while
      // it is open, so a page-flow capture at 390px correctly shows nothing.
      const drawerTarget = join(outDir, `${viewport.name}-fleet-drawer.png`);
      await page.goto(`${server.url}#fleet-drawer`);
      await page.reload();
      const drawer = page.getByRole('dialog', { name: 'Fleet sessions' });
      if (await drawer.isVisible().catch(() => false)) {
        await page.screenshot({ path: drawerTarget });
        process.stdout.write(`📸 ${viewport.name} fleet drawer -> ${drawerTarget}\n`);
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
}
