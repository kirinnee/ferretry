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
 *   bun harness/screenshot.ts --landing-only # capture the built landing at both viewports
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright-core';
import { chromium } from 'playwright-core';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

/** A real phone context: a 390px desktop is not the mobile journey this UI serves. */
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
} as const;

const SETTINGS_ONLY = process.argv.includes('--settings-only');
const TASK_BOARD_ONLY = process.argv.includes('--task-board-only');

/** Harness sections that live below the fold and are captured element by element. */
const SECTIONS = [
  'harness-new-session',
  'harness-session-screen',
  'harness-references',
  'harness-composer-markdown',
  'harness-lineage',
  'harness-marks',
  'harness-chat-width',
  'harness-dead-pane',
  'harness-fleet-sidebar',
  'harness-terminal-deck',
  'harness-surface-references',
  'harness-runtime-controls',
  'harness-pending-sends',
  'harness-skills',
  'harness-thinking-indicator',
  'harness-task-board',
  // The install stage is deliberately absent: it is taller than a phone, and an
  // element capture inside this fixed gallery clips its top away. It gets a
  // page of its own below instead.
  // The entry question — what the reader HAS, which is the only thing this page
  // cannot detect — and the two questions the daemon subflow asks after it.
  'harness-onboarding-entry',
  'harness-onboarding-target',
  // The assumption stated with a way out, and the phone where the same screen
  // states a FACT instead, because the hardware answered the question.
  'harness-onboarding-doer',
  'harness-onboarding-doer-mobile',
  'harness-onboarding-brief',
  // The same prompt for an agent on another machine: a clipboard does not cross
  // devices, so this frame carries the share sheet and the page's own address.
  'harness-onboarding-brief-elsewhere',
  'harness-onboarding-agent-pair',
  // And that step without the "already open in another tab" line, which is true
  // only when the daemon is on the machine reading the page.
  'harness-onboarding-agent-pair-elsewhere',
  // The step that makes the daemon worth starting: Ferretry runs Claude Code and
  // Codex and is neither, so a daemon with both missing starts and can do nothing.
  'harness-onboarding-agents',
  'harness-onboarding-daemon',
  'harness-onboarding-connect',
  // The same-machine collapse, and the one screen that stands in for the whole
  // "another computer, by hand" branch — the same on a phone and on a computer.
  'harness-onboarding-local',
  'harness-onboarding-elsewhere',
  'harness-onboarding-elsewhere-mobile',
  'harness-onboarding-handoff',
  'harness-onboarding-scan',
  'harness-onboarding-pair',
  'harness-onboarding-done',
] as const;

/**
 * The fleet cockpit frames, captured on their own page rather than inside the gallery.
 *
 * The failed apply is in the list on purpose: a gallery of happy paths proves nothing about the one
 * screen a person actually reads while something is wrong.
 */
const FLEET_FRAMES = [
  'cockpit',
  'cockpit-staged',
  'states',
  'accounts',
  'preview',
  'failed-apply',
  'create',
  'layer',
] as const;

/**
 * A software keyboard, told the truth.
 *
 * Chrome's `setViewportSize` (and CDP's visible-size) shrink the LAYOUT
 * viewport: `innerHeight` and `screen.height` move together and the page looks
 * like a short landscape device — which is the very misreading the portrait
 * gate was fixed for. An Android keyboard does something different: with
 * `interactive-widget=resizes-content` the screen stays a 390x844 portrait
 * phone and only `window.visualViewport` gets shorter.
 *
 * So the seam replaces `window.visualViewport` with a real EventTarget whose
 * height a harness setter can change, and dispatches the same `resize` the
 * browser would. The production producer (`useAppViewport`) listens to exactly
 * that, so the capture exercises the shipped code path rather than a mock of it.
 */
const VISUAL_VIEWPORT_SHIM = `(() => {
  const real = window.visualViewport;
  if (!real) throw new Error('this browser has no visualViewport to model a keyboard with');
  // WRAP, never replace: a substitute object breaks the driver's own pointer
  // coordinate maths once touch emulation is on, and every other reader of the
  // viewport would be reading a fake. Only 'height' is overridden, and only
  // while the harness says a keyboard is up.
  let override = null;
  const inherited = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(real), 'height');
  Object.defineProperty(real, 'height', {
    configurable: true,
    get: () => (override === null ? inherited.get.call(real) : override),
  });
  window.__harnessKeyboard = (nextHeight) => {
    override = nextHeight;
    real.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
  };
})();`;

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { cwd: packageDir, stdio: 'inherit' });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`);
}

/**
 * DictationSheet renders its `[data-dictation-panel="non-modal"]` overlay
 * absolutely positioned ABOVE its anchor, so it can paint outside the card's
 * own bounding box without ever growing it — `card.screenshot()` clips the
 * overlay away. Scroll the card into view, take the union of the card and
 * every visible panel descendant's page bounding box, and clip a page
 * screenshot to that union instead.
 */
async function screenshotDictationCard(page: Page, card: Locator, target: string): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  const panels = card.locator('[data-dictation-panel="non-modal"]');

  const measureUnion = async () => {
    const cardBox = await card.boundingBox();
    if (cardBox === null) fail(`${target}: dictation card has no bounding box`);
    const panelCount = await panels.count();
    if (panelCount === 0) fail(`${target}: no dictation panel found to union with the card`);
    const boxes = [cardBox];
    for (let index = 0; index < panelCount; index += 1) {
      const panel = panels.nth(index);
      if (!(await panel.isVisible())) continue;
      const panelBox = await panel.boundingBox();
      if (panelBox === null) fail(`${target}: visible dictation panel ${index} has no bounding box`);
      boxes.push(panelBox);
    }
    return {
      left: Math.min(...boxes.map(box => box.x)),
      top: Math.min(...boxes.map(box => box.y)),
      right: Math.max(...boxes.map(box => box.x + box.width)),
      bottom: Math.max(...boxes.map(box => box.y + box.height)),
    };
  };

  let union = await measureUnion();
  if (union.top < 0) {
    // The overlay renders above its anchor, so it can extend above the top of
    // the viewport even once the card itself is scrolled into view. Scroll
    // the extra distance and re-measure against the new scroll position.
    await page.evaluate(deltaY => window.scrollBy(0, deltaY), union.top);
    union = await measureUnion();
  }

  const viewport = page.viewportSize();
  if (viewport === null) fail(`${target}: page has no viewport to clip against`);
  const x = Math.max(0, Math.floor(union.left));
  const y = Math.max(0, Math.floor(union.top));
  const right = Math.min(viewport.width, Math.ceil(union.right));
  const bottom = Math.min(viewport.height, Math.ceil(union.bottom));
  if (right <= x || bottom <= y) fail(`${target}: clipped dictation capture collapsed to an empty rect`);

  await page.screenshot({ path: target, clip: { x, y, width: right - x, height: bottom - y } });
}

mkdirSync(outDir, { recursive: true });

/**
 * The public landing is intentionally outside the React harness: proving that
 * it never loads the app bundle means shooting the real Vite build instead of a
 * component rendition. Keep this narrow mode in the existing harness so it
 * inherits the same loopback-only browser lifecycle and cleanup guarantees.
 */
if (process.argv.includes('--landing-only')) {
  process.stdout.write('📦 building the public landing…\n');
  run('bun', ['run', 'build']);
  const landingDir = join(packageDir, 'dist');
  const landingServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      return new Response(Bun.file(path === '/' ? join(landingDir, 'index.html') : join(landingDir, path)));
    },
  });
  const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
  if (chrome === null) {
    landingServer.stop();
    fail('no system Chrome or Chromium found');
  }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== landingServer.url.origin) {
            await route.abort();
            return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        await page.goto(landingServer.url.toString());
        const target = join(outDir, `landing-${viewport.name}.png`);
        await page.screenshot({ path: target, fullPage: true });
        process.stdout.write(`📸 landing ${viewport.name} ${viewport.width}x${viewport.height} -> ${target}\n`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    landingServer.stop();
  }
  process.exit(0);
}

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
        ...(viewport.name === 'mobile'
          ? PHONE_CONTEXT
          : { viewport: { width: viewport.width, height: viewport.height } }),
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });
      // Every capture below runs against this one context and page. Closing them
      // in `finally` keeps a single failed locator from leaking a Chromium context
      // for the rest of the run; the browser and the server have the same
      // guarantee one level up, so nothing here can survive a thrown capture.
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) {
            await route.abort();
            return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        try {
          await page.goto(server.url.toString());
          if (TASK_BOARD_ONLY) {
            const target = join(outDir, `task-board-${viewport.name}.png`);
            const taskBoard = page.locator('#harness-task-board');
            await taskBoard.scrollIntoViewIfNeeded();
            await taskBoard.screenshot({ path: target });
            process.stdout.write(`📸 task board ${viewport.name} ${viewport.width}x${viewport.height} -> ${target}\n`);
            continue;
          }
          if (!SETTINGS_ONLY) {
            const target = join(outDir, `${viewport.name}.png`);
            await page.screenshot({ path: target });
            process.stdout.write(`📸 ${viewport.name} ${viewport.width}x${viewport.height} -> ${target}\n`);

            // The gallery bar carries BOTH transient states (reconnecting and an
            // available update). It complements the at-rest workspace bar below
            // and proves that 390px gets a breathing row instead of dropped state.
            const statusTopBarTarget = join(outDir, `top-bar-status-${viewport.name}.png`);
            await page.locator('[data-density-region="app-bar"]').first().screenshot({ path: statusTopBarTarget });
            process.stdout.write(`📸 top bar status ${viewport.name} -> ${statusTopBarTarget}\n`);

            if (viewport.name === 'desktop') {
              const fleetRailTarget = join(outDir, `fleet-navigation-rail-${viewport.name}.png`);
              await page.getByLabel('Fleet navigation rail preview').screenshot({ path: fleetRailTarget });
              process.stdout.write(`📸 fleet navigation rail -> ${fleetRailTarget}\n`);
            }

            // Scoped to its own card: the unified browser surface renders the SAME
            // pane, display and live frame, so a page-wide locator for any of them
            // is ambiguous by design rather than by accident.
            const remoteBrowserCard = page.locator('[data-harness="remote-browser"]');
            const browserTarget = join(outDir, `remote-browser-${viewport.name}.png`);
            await remoteBrowserCard.getByAltText('Live remote browser frame').waitFor({ state: 'visible' });
            await remoteBrowserCard.getByLabel('Remote browser display').screenshot({ path: browserTarget });
            process.stdout.write(`📸 remote browser -> ${browserTarget}\n`);
            // The whole pane, not just the display: the tab strip, address bar and
            // lifecycle controls are the part that has to match the original.
            const browserPaneTarget = join(outDir, `remote-browser-pane-${viewport.name}.png`);
            await remoteBrowserCard.screenshot({ path: browserPaneTarget });
            process.stdout.write(`📸 remote browser pane -> ${browserPaneTarget}\n`);

            // The unified surface is captured HERE, beside the standalone pane it
            // embeds and while its display is still live. The harness stream socket
            // is one-shot by design, so a shot taken later in the run would show
            // the honest "stream stalled" state instead of the composition under
            // review.
            const unifiedPreviewTarget = join(outDir, `unified-browser-preview-${viewport.name}.png`);
            await page.locator('[data-harness="unified-browser-preview"]').screenshot({ path: unifiedPreviewTarget });
            process.stdout.write(`📸 Unified browser preview -> ${unifiedPreviewTarget}\n`);

            const unifiedRealCard = page.locator('[data-harness="unified-browser-real"]');
            const unifiedRealTarget = join(outDir, `unified-browser-real-${viewport.name}.png`);
            await unifiedRealCard.getByAltText('Live remote browser frame').waitFor({ state: 'visible' });
            await unifiedRealCard.screenshot({ path: unifiedRealTarget });
            process.stdout.write(`📸 Unified browser real engine -> ${unifiedRealTarget}\n`);

            // The engine selector and the escape actions live behind the one ⋯
            // menu, so opening it is the only way to review them. Escape closes it
            // again and returns focus to the trigger, leaving the page as the rest
            // of this pass expects to find it.
            const unifiedMenuTarget = join(outDir, `unified-browser-menu-${viewport.name}.png`);
            await unifiedRealCard.getByLabel('Browser controls').click();
            await unifiedRealCard.getByRole('dialog', { name: 'Browser controls' }).waitFor({ state: 'visible' });
            await unifiedRealCard.screenshot({ path: unifiedMenuTarget });
            await page.keyboard.press('Escape');
            await unifiedRealCard.getByRole('dialog', { name: 'Browser controls' }).waitFor({ state: 'hidden' });
            process.stdout.write(`📸 Unified browser controls menu -> ${unifiedMenuTarget}\n`);

            // The remote login is deliberately reviewed as its whole journey:
            // start, link-out, a rejected callback with nothing echoed, then a
            // verified identity. The phone capture uses PHONE_CONTEXT above so
            // its touch layout and user agent are the real mobile branch.
            const remoteLogin = page.locator('[data-harness="remote-login"]');
            for (const [state, settle] of [
              ['start', async () => {}],
              [
                'url',
                async () => {
                  await remoteLogin.getByRole('button', { name: 'Log in to Claude Code' }).click();
                  await remoteLogin.getByText('Open this URL anywhere').waitFor({ state: 'visible' });
                },
              ],
              [
                'rejected',
                async () => {
                  await remoteLogin
                    .locator('textarea[name="remote-login-callback"]')
                    .fill('http://127.0.0.1:43123/oauth/callback?rejected=fixture');
                  await remoteLogin.getByRole('button', { name: 'Finish sign-in' }).click();
                  await remoteLogin.getByRole('alert').waitFor({ state: 'visible' });
                },
              ],
              [
                'success',
                async () => {
                  await remoteLogin
                    .locator('textarea[name="remote-login-callback"]')
                    .fill('http://127.0.0.1:43123/oauth/callback?accepted=fixture');
                  await remoteLogin.getByRole('button', { name: 'Finish sign-in' }).click();
                  await remoteLogin.getByRole('status').waitFor({ state: 'visible' });
                },
              ],
            ] as const) {
              await settle();
              const target = join(outDir, `remote-login-${state}-${viewport.name}.png`);
              await remoteLogin.screenshot({ path: target });
              process.stdout.write(`📸 remote login ${state} -> ${target}\n`);
            }
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
            // The live recognition states. Each card opens its own flow at mount
            // against a scripted recognition object, so there is nothing to click
            // and nothing to wait for beyond the stage the card settled into.
            for (const [id, name] of [
              ['harness-dictation-live', 'Dictation live recognition'],
              ['harness-dictation-unavailable', 'Dictation unavailable'],
              ['harness-dictation-permission-denied', 'Dictation permission denied'],
            ] as const) {
              const target = join(outDir, `${id.replace('harness-', '')}-${viewport.name}.png`);
              const card = page.locator(`#${id}`);
              await card.locator('[data-dictation-panel="non-modal"]').first().waitFor({ state: 'visible' });
              await screenshotDictationCard(page, card, target);
              process.stdout.write(`📸 ${name} -> ${target}\n`);
            }
            const notificationSettingsTarget = join(outDir, `notification-settings-${viewport.name}.png`);
            await page.getByLabel('Notification settings').first().screenshot({ path: notificationSettingsTarget });
            process.stdout.write(`📸 Notification settings -> ${notificationSettingsTarget}\n`);
          }

          // Settings gets a production-sized canvas of its own. The gallery card
          // above uses the same SettingsPageHarness component, but the standalone
          // query removes the gallery gutters so these are true 390×844 and
          // 1440×900 responsive captures rather than close approximations.
          const settingsUrl = new URL(server.url);
          settingsUrl.searchParams.set('settings-harness', '1');
          await page.goto(settingsUrl.toString());
          let settingsPage = page.getByLabel('Settings page preview', { exact: true });
          await settingsPage.locator('[data-settings-section="appearance"]').waitFor({ state: 'visible' });

          const appearanceTarget = join(outDir, `settings-appearance-${viewport.name}.png`);
          await page.screenshot({ path: appearanceTarget });
          process.stdout.write(`📸 Settings Appearance ${viewport.name} -> ${appearanceTarget}\n`);

          if (viewport.name === 'mobile') {
            // Closed and open are both review states. The latter is a viewport
            // shot because BottomSheet is fixed to the viewport, not to the
            // Settings card that happened to open it.
            const pickerDismissedTarget = join(outDir, 'settings-picker-dismissed-mobile.png');
            await page.screenshot({ path: pickerDismissedTarget });
            process.stdout.write(`📸 Settings picker dismissed -> ${pickerDismissedTarget}\n`);

            await settingsPage.locator('[data-settings-section-trigger]').click();
            const picker = page.getByRole('dialog', { name: 'Choose a settings section' });
            await picker.waitFor({ state: 'visible' });
            const pickerOpenTarget = join(outDir, 'settings-picker-open-mobile.png');
            await page.screenshot({ path: pickerOpenTarget });
            process.stdout.write(`📸 Settings picker open -> ${pickerOpenTarget}\n`);
            await page.keyboard.press('Escape');
            await picker.waitFor({ state: 'hidden' });
          }

          const selectSettingsSection = async (id: 'appearance' | 'behaviour' | 'daemons') => {
            const label = { appearance: 'Appearance', behaviour: 'Behaviour', daemons: 'Daemons' }[id];
            if (viewport.name === 'mobile') {
              await settingsPage.locator('[data-settings-section-trigger]').click();
              const picker = page.getByRole('dialog', { name: 'Choose a settings section' });
              await picker.waitFor({ state: 'visible' });
              await picker.getByRole('button', { name: new RegExp(`^${label}`) }).click();
              await picker.waitFor({ state: 'hidden' });
            } else {
              await settingsPage.getByRole('button', { name: new RegExp(`^${label}`) }).click();
            }
            await settingsPage.locator(`[data-settings-section="${id}"]`).waitFor({ state: 'visible' });
            if (viewport.name === 'desktop') {
              // ChoiceRail rows fade their colours over 150ms. Capture the
              // settled state so the row we left cannot read as selected too.
              await page.waitForTimeout(200);
            }
          };

          await selectSettingsSection('behaviour');
          const behaviourTarget = join(outDir, `settings-behaviour-${viewport.name}.png`);
          await page.screenshot({ path: behaviourTarget });
          process.stdout.write(`📸 Settings Behaviour ${viewport.name} -> ${behaviourTarget}\n`);

          const composerEnterTarget = join(outDir, `settings-composer-enter-key-${viewport.name}.png`);
          await settingsPage.locator('#settings-composer-enter-key').screenshot({ path: composerEnterTarget });
          process.stdout.write(`📸 Settings composer Enter key ${viewport.name} -> ${composerEnterTarget}\n`);

          await selectSettingsSection('daemons');
          const daemonTabs = await settingsPage.locator('[data-daemon-subtab]').count();
          if (daemonTabs !== 3)
            fail(`settings many-daemon fixture rendered ${daemonTabs} daemon sub-tabs instead of 3`);
          const daemonsTarget = join(outDir, `settings-daemons-${viewport.name}.png`);
          await page.screenshot({ path: daemonsTarget });
          process.stdout.write(`📸 Settings Daemons (many) ${viewport.name} -> ${daemonsTarget}\n`);

          const selectDaemon = async (name: string) => {
            if (viewport.name === 'mobile') {
              await settingsPage.locator('[data-daemon-subtab-trigger]').click();
              const picker = page.getByRole('dialog', { name: 'Choose a daemon' });
              await picker.waitFor({ state: 'visible' });
              await picker.getByRole('button', { name: new RegExp(`^${name}`) }).click();
              await picker.waitFor({ state: 'hidden' });
            } else {
              await settingsPage
                .locator('[data-daemon-subtabs="desktop"]')
                .getByRole('tab', { name: new RegExp(`^${name}`) })
                .click();
            }
          };

          /**
           * Open one of the daemon's panels — the third and innermost level of
           * Settings navigation, which the two presentations reach differently.
           *
           * A desktop reads the vertical rail beside the panel, which is a real
           * tablist. A phone has no tablist at all: one trigger names the open
           * panel and the app's shared BottomSheet lists the rest as ordinary
           * navigation rows, deliberately without `role="tab"` — so asking for a
           * tab there would find the hidden desktop rail and click nothing a
           * reader can see.
           */
          const selectDaemonPanel = async (frame: Locator, label: string) => {
            if (viewport.name === 'mobile') {
              await frame.locator('[data-daemon-panel-trigger]').click();
              const picker = page.getByRole('dialog', { name: 'Choose a panel' });
              await picker.waitFor({ state: 'visible' });
              await picker
                .locator('[data-daemon-panel-choice]')
                .filter({ has: page.getByText(label, { exact: true }) })
                .click();
              await picker.waitFor({ state: 'hidden' });
              return;
            }
            await frame
              .locator('[data-daemon-settings-tabs="desktop"]')
              .getByRole('tab', { name: new RegExp(`^${label}`) })
              .click();
            // The rail's rows carry `transition-colors`, so a capture taken the
            // instant a panel opens catches the row it left mid-fade and reads as
            // two selected rows. Let the 150ms colour transition land first.
            await page.waitForTimeout(200);
          };

          if (viewport.name === 'mobile') {
            await settingsPage.locator('[data-daemon-subtab-trigger]').click();
            const daemonPicker = page.getByRole('dialog', { name: 'Choose a daemon' });
            await daemonPicker.waitFor({ state: 'visible' });
            const daemonPickerTarget = join(outDir, 'settings-daemon-picker-open-mobile.png');
            await page.screenshot({ path: daemonPickerTarget });
            process.stdout.write(`📸 Settings daemon picker open -> ${daemonPickerTarget}\n`);
            await page.keyboard.press('Escape');
            await daemonPicker.waitFor({ state: 'hidden' });
          }

          const wardenFrame = settingsPage.locator('[data-daemon-settings-frame="harness-daemon"]');
          await wardenFrame.scrollIntoViewIfNeeded();

          // The fixture is only evidence about the real frame if it carries the
          // panels the composition root supplies. It once carried six of the
          // production eight, so the row that overflowed a desktop could not be
          // seen here at all. Count the rail's rows, which exist in the document
          // at both widths, rather than the sheet's, which are rendered only
          // once that sheet has been opened.
          const daemonPanels = await wardenFrame.locator('[data-daemon-panel]').count();
          if (daemonPanels !== 8)
            fail(`settings fixture rendered ${daemonPanels} daemon panels instead of the production 8`);

          if (viewport.name === 'mobile') {
            // The level-three picker: the resting trigger that names the open
            // panel, and the shared sheet it opens. Both are review states, and
            // the sheet is a viewport shot because BottomSheet is fixed to the
            // viewport rather than to the frame that opened it.
            const panelPickerDismissedTarget = join(outDir, 'settings-daemon-panel-picker-dismissed-mobile.png');
            await page.screenshot({ path: panelPickerDismissedTarget });
            process.stdout.write(`📸 Settings daemon panel picker dismissed -> ${panelPickerDismissedTarget}\n`);

            await wardenFrame.locator('[data-daemon-panel-trigger]').click();
            const panelPicker = page.getByRole('dialog', { name: 'Choose a panel' });
            await panelPicker.waitFor({ state: 'visible' });
            const openPanelChoices = await panelPicker.locator('[data-daemon-panel-choice]').count();
            if (openPanelChoices !== 8)
              fail(`the daemon panel sheet listed ${openPanelChoices} panels instead of the production 8`);
            const panelPickerOpenTarget = join(outDir, 'settings-daemon-panel-picker-open-mobile.png');
            await page.screenshot({ path: panelPickerOpenTarget });
            process.stdout.write(`📸 Settings daemon panel picker open -> ${panelPickerOpenTarget}\n`);
            await page.keyboard.press('Escape');
            await panelPicker.waitFor({ state: 'hidden' });
          }

          const wardenFrameTarget = join(outDir, `settings-daemon-warden-${viewport.name}.png`);
          await page.screenshot({ path: wardenFrameTarget });
          process.stdout.write(`📸 Settings daemon Warden ${viewport.name} -> ${wardenFrameTarget}\n`);

          // Every panel the daemon owns, in the order the frame lists them.
          for (const [label, slug, ready] of [
            // Both of these wait for SETTLED content, not for a spinner or a
            // refusal: the harness daemon answers `/v1/secrets` and
            // `/v1/fleet/environment` in the page, so a capture that still showed
            // "Reading…" or "Failed to fetch" would be a regression to review,
            // not a state to accept.
            ['Secrets', 'secrets', '[data-testid="secrets-card"]'],
            ['Environment', 'environment', '[aria-label="Target environment entries"]'],
            ['Resource limits', 'resource-limits', '[data-testid="cgroup-config-card"]'],
            ['Doctor', 'doctor', '[data-doctor-daemon="harness-daemon"]'],
            ['Fleet', 'fleet', '[data-fleet-configuration]'],
            ['Carrier', 'carrier', '[data-active-carrier]'],
            ['Host checks', 'host-checks', '[data-daemon-host-checks="harness-daemon"]'],
          ] as const) {
            await selectDaemonPanel(wardenFrame, label);
            await wardenFrame.locator(ready).first().waitFor({ state: 'visible' });
            const target = join(outDir, `settings-daemon-${slug}-${viewport.name}.png`);
            await page.screenshot({ path: target });
            process.stdout.write(`📸 Settings daemon ${label} ${viewport.name} -> ${target}\n`);
          }

          await selectDaemon('Travel laptop');
          const unavailableWardenFrame = settingsPage.locator('[data-daemon-settings-frame="unreachable-daemon"]');
          await unavailableWardenFrame.scrollIntoViewIfNeeded();
          await unavailableWardenFrame.getByLabel('Warden status unavailable').waitFor({ state: 'visible' });
          const unavailableWardenTarget = join(outDir, `settings-daemon-warden-unavailable-${viewport.name}.png`);
          await page.screenshot({ path: unavailableWardenTarget });
          process.stdout.write(
            `📸 Settings unavailable daemon Warden ${viewport.name} -> ${unavailableWardenTarget}\n`,
          );

          await selectDaemon('Studio workstation');
          const currentFrame = settingsPage.locator('[data-daemon-settings-frame="harness-daemon"]');
          await selectDaemonPanel(currentFrame, 'Host checks');
          const currentDaemon = currentFrame.locator('[data-daemon-host-checks="harness-daemon"]');
          await currentDaemon.locator('[data-daemon-reachability="reachable"]').waitFor({ state: 'visible' });
          await currentDaemon.getByText('Manage daemon', { exact: true }).click();
          await currentDaemon.getByText('Removing this pairing only forgets it in this browser.').waitFor({
            state: 'visible',
          });
          const removalTarget = join(outDir, `settings-removal-disclosure-${viewport.name}.png`);
          await page.screenshot({ path: removalTarget });
          process.stdout.write(`📸 Settings removal disclosure ${viewport.name} -> ${removalTarget}\n`);

          // The compact registry is a separate deterministic route rather than a
          // DOM mutation: it remounts the reachability hooks exactly as a fresh
          // one-daemon browser would and proves the empty space is intentional.
          settingsUrl.searchParams.set('settings-daemons', 'one');
          await page.goto(settingsUrl.toString());
          settingsPage = page.getByLabel('Settings page preview', { exact: true });
          if (viewport.name === 'mobile') {
            await settingsPage.locator('[data-settings-section-trigger]').click();
            const picker = page.getByRole('dialog', { name: 'Choose a settings section' });
            await picker.getByRole('button', { name: /^Daemons/ }).click();
            await picker.waitFor({ state: 'hidden' });
          } else {
            await settingsPage.getByRole('button', { name: /^Daemons/ }).click();
          }
          await settingsPage.locator('[data-settings-section="daemons"]').waitFor({ state: 'visible' });
          const oneDaemonFrame = settingsPage.locator('[data-daemon-settings-frame="harness-daemon"]');
          await oneDaemonFrame.scrollIntoViewIfNeeded();
          await selectDaemonPanel(oneDaemonFrame, 'Host checks');
          await settingsPage.locator('[data-daemon-reachability="reachable"]').waitFor({ state: 'visible' });
          const oneDaemonTabs = await settingsPage.locator('[data-daemon-subtab]').count();
          if (oneDaemonTabs !== 1)
            fail(`settings one-daemon fixture rendered ${oneDaemonTabs} daemon sub-tab instead of 1`);
          const oneDaemonTarget = join(outDir, `settings-daemons-one-${viewport.name}.png`);
          await page.screenshot({ path: oneDaemonTarget });
          process.stdout.write(`📸 Settings Daemons (one) ${viewport.name} -> ${oneDaemonTarget}\n`);

          // The rest of this pass still belongs to the full gallery.
          await page.goto(server.url.toString());
          const fleetInventoryTarget = join(outDir, `fleet-inventory-${viewport.name}.png`);
          await page.getByLabel('Fleet inventory preview').screenshot({ path: fleetInventoryTarget });
          process.stdout.write(`📸 Fleet inventory -> ${fleetInventoryTarget}\n`);
          if (SETTINGS_ONLY) continue;
          const learningHeaderTarget = join(outDir, `learning-header-${viewport.name}.png`);
          await page.getByLabel('Learning header').screenshot({ path: learningHeaderTarget });
          process.stdout.write(`📸 Learning header -> ${learningHeaderTarget}\n`);
          // A four-kind ledger is taller than a phone viewport. Chrome may cull
          // unpainted rows during an element screenshot, so temporarily borrow
          // a tall viewport to capture the full, real phone-width board.
          const attentionTarget = join(outDir, `attention-${viewport.name}.png`);
          await page.setViewportSize({ width: viewport.width, height: 2_400 });
          const attention = page.getByLabel('Attention ledger');
          await attention.locator('summary').filter({ hasText: 'Resolution audit' }).click();
          await attention.screenshot({ path: attentionTarget });
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          process.stdout.write(`📸 Attention ledger -> ${attentionTarget}\n`);
          const pinsTriggerTarget = join(outDir, `pins-trigger-${viewport.name}.png`);
          await page.getByLabel('Pins trigger').screenshot({ path: pinsTriggerTarget });
          process.stdout.write(`📸 Pins trigger -> ${pinsTriggerTarget}\n`);
          const pinsTarget = join(outDir, `pins-${viewport.name}.png`);
          await page.getByLabel('Pins ledger').screenshot({ path: pinsTarget });
          process.stdout.write(`📸 Pins ledger -> ${pinsTarget}\n`);
          // Three pairing screens, because they are three different screens: the
          // cold open a first-timer sees, the confirmation a scanned QR lands
          // on, and what the surface becomes once a daemon is connected.
          for (const [label, slug] of [
            ['Daemon pairing', 'pairing'],
            ['Pairing confirmation', 'pairing-confirm'],
            ['Paired daemon list', 'pairing-list'],
          ] as const) {
            const pairingTarget = join(outDir, `${slug}-${viewport.name}.png`);
            await page.getByLabel(label, { exact: true }).screenshot({ path: pairingTarget });
            process.stdout.write(`📸 ${label} ${viewport.name} -> ${pairingTarget}\n`);
          }

          // AND IN LIGHT. Pairing is the first screen a new reader ever sees,
          // and half of them are not in dark mode. The rest of this harness page
          // is captured dark only; this one surface is worth both.
          await page.evaluate(() => {
            document.documentElement.dataset.theme = 'studio-light';
          });
          for (const [label, slug] of [
            ['Daemon pairing', 'pairing'],
            ['Pairing confirmation', 'pairing-confirm'],
            ['Paired daemon list', 'pairing-list'],
          ] as const) {
            const lightTarget = join(outDir, `${slug}-light-${viewport.name}.png`);
            await page.getByLabel(label, { exact: true }).screenshot({ path: lightTarget });
            process.stdout.write(`📸 ${label} light ${viewport.name} -> ${lightTarget}\n`);
          }
          await page.evaluate(() => {
            document.documentElement.dataset.theme = 'studio-dark';
          });
          const wardenAttentionTarget = join(outDir, `warden-attention-${viewport.name}.png`);
          await page
            .locator('[aria-labelledby="warden-attention-heading"]')
            .screenshot({ path: wardenAttentionTarget });
          process.stdout.write(`📸 Warden attention -> ${wardenAttentionTarget}\n`);
          const wardenStripTarget = join(outDir, `warden-strip-${viewport.name}.png`);
          await page.locator('[data-harness="warden-strip"]').screenshot({ path: wardenStripTarget });
          process.stdout.write(`📸 Warden strip -> ${wardenStripTarget}\n`);
          // The secret store, in the three states a person actually meets: one that exists
          // (masked, with a configured reference that does not resolve), a damaged store that says
          // so rather than reporting empty, and a read this browser could not make.
          for (const [name, selector] of [
            [`secrets`, `[data-harness="secrets-card"]`],
            [`secrets-damaged`, `[data-harness="secrets-damaged"]`],
            [`secrets-unreachable`, `[data-harness="secrets-unreachable"]`],
          ] as const) {
            const target = join(outDir, `${name}-${viewport.name}.png`);
            await page.locator(selector).screenshot({ path: target });
            process.stdout.write(`📸 Secrets ${name} ${viewport.name} -> ${target}\n`);
          }
          const taskDagTarget = join(outDir, `task-dag-${viewport.name}.png`);
          await page.locator('[data-task-graph]').screenshot({ path: taskDagTarget });
          process.stdout.write(`📸 Task dependency graph -> ${taskDagTarget}\n`);
          const sessionTasksTarget = join(outDir, `session-tasks-${viewport.name}.png`);
          await page.getByLabel('Session task board').screenshot({ path: sessionTasksTarget });
          process.stdout.write(`📸 Session task board -> ${sessionTasksTarget}\n`);
          const taskNameTarget = join(outDir, `task-name-${viewport.name}.png`);
          await page.getByLabel('Task name').screenshot({ path: taskNameTarget });
          process.stdout.write(`📸 Task name -> ${taskNameTarget}\n`);

          const inAppTarget = join(outDir, `in-app-browser-${viewport.name}.png`);
          await page.locator('#harness-in-app-browser').scrollIntoViewIfNeeded();
          await page.getByLabel('In-app link preview').screenshot({ path: inAppTarget });
          process.stdout.write(`📸 In-app link preview -> ${inAppTarget}\n`);

          const filesTarget = join(outDir, `files-${viewport.name}.png`);
          await page.locator('#harness-files').scrollIntoViewIfNeeded();
          await page.getByLabel('Files browser').screenshot({ path: filesTarget });
          process.stdout.write(`📸 Files browser -> ${filesTarget}\n`);

          // The body behind ONE file tab (#35), not the picker: its own path in
          // the bar, its own raw/diff/refresh controls, its own bytes.
          const fileInstanceTarget = join(outDir, `file-instance-${viewport.name}.png`);
          await page.locator('#harness-file-instance').scrollIntoViewIfNeeded();
          await page.getByLabel('File tab body').screenshot({ path: fileInstanceTarget });
          process.stdout.write(`📸 File tab body -> ${fileInstanceTarget}\n`);

          const attachmentsTarget = join(outDir, `attachments-${viewport.name}.png`);
          // The thumbnail is `loading="lazy"` and the harness stacks it thousands
          // of pixels below the fold, so Chrome has not started decoding it yet.
          // Scroll first: capturing before it lands gives a 0x0 box and a card
          // screenshot that is silently missing its image.
          await page.locator('#harness-attachments').scrollIntoViewIfNeeded();
          await page.getByAltText('Coverage by tier').waitFor({ state: 'visible' });
          await page.getByLabel('Transcript attachments').screenshot({ path: attachmentsTarget });
          process.stdout.write(`📸 Transcript attachments -> ${attachmentsTarget}\n`);
          const terminalTarget = join(outDir, `terminal-snapshot-${viewport.name}.png`);
          await page.getByLabel('Terminal snapshot').screenshot({ path: terminalTarget });
          process.stdout.write(`📸 Terminal snapshot -> ${terminalTarget}\n`);

          const sidePaneTabsTarget = join(outDir, `side-pane-tabs-${viewport.name}.png`);
          await page.locator('[data-harness="side-pane-tabs"]').screenshot({ path: sidePaneTabsTarget });
          process.stdout.write(`📸 Side pane tabs -> ${sidePaneTabsTarget}\n`);

          for (const [label, slug] of [
            ['Session dashboard full table', 'session-dashboard-table'],
            ['Session dashboard full cards', 'session-dashboard-cards'],
            ['Session dashboard compact panel', 'session-dashboard-compact'],
            ['Session dashboard scoped', 'session-dashboard-scoped'],
            ['Session dashboard minimal panel', 'session-dashboard-minimal'],
            ['Session dashboard lean table', 'session-dashboard-lean-table'],
            ['Sessions page connected', 'sessions-page-connected'],
          ] as const) {
            const dashboardTarget = join(outDir, `${slug}-${viewport.name}.png`);
            await page.getByLabel(label, { exact: true }).screenshot({ path: dashboardTarget });
            process.stdout.write(`📸 ${label} -> ${dashboardTarget}\n`);
          }

          // Four stacked dashboards are taller than a phone viewport, and Chrome
          // culls painting outside the viewport while an element screenshot scrolls
          // — the same reason the dictation settings shot below borrows a tall
          // viewport. Without this most of the image comes back black.
          const dashboardStatesTarget = join(outDir, `session-dashboard-states-${viewport.name}.png`);
          await page.setViewportSize({ width: viewport.width, height: 2_000 });
          await page
            .getByLabel('Session dashboard states', { exact: true })
            .screenshot({ path: dashboardStatesTarget });
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          process.stdout.write(`📸 Session dashboard states -> ${dashboardStatesTarget}\n`);

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

          const renameTarget = join(outDir, `${viewport.name}-rename.png`);
          await page.goto(`${server.url}#rename`);
          await page.reload();
          await page.getByRole('dialog', { name: 'Rename session' }).waitFor({ state: 'visible' });
          await page.screenshot({ path: renameTarget });
          process.stdout.write(`📸 ${viewport.name} rename sheet -> ${renameTarget}\n`);

          const migrateTarget = join(outDir, `${viewport.name}-migrate.png`);
          await page.goto(`${server.url}#migrate`);
          await page.reload();
          await page.getByRole('dialog', { name: 'Change model or account' }).waitFor({ state: 'visible' });
          await page.screenshot({ path: migrateTarget });
          process.stdout.write(`📸 ${viewport.name} migrate sheet -> ${migrateTarget}\n`);

          // THE ASSEMBLED SESSION WORKSPACE, on a page of its own.
          //
          // It is `h-full` with a single scroller of its own, so an element shot
          // inside the stacked gallery would be clipped by the gallery's
          // scroller and would prove nothing about where the composer sits. The
          // alternate root mounts the production shell and the production
          // viewport producer, and derives pane-vs-sheet from the layout regime
          // exactly as `src/App.tsx` does — so this loop's two viewports are the
          // two presentations, with nothing to switch by hand.
          //
          // Captured at rest FIRST: the pane starts closed in production, so the
          // full-width chat column is the state a reader actually opens on, and
          // it is the only frame that shows the transcript and the composer with
          // nothing over them.
          const workspaceTarget = join(outDir, `${viewport.name}-session-workspace.png`);
          await page.goto(`${server.url}#session-workspace`);
          await page.reload();
          await page.locator('#harness-session-workspace-page').waitFor({ state: 'visible' });
          // The transcript follows its tail on mount; wait for the LAST row
          // rather than for load, or the shot catches a scroller mid-pin.
          await page.locator('[data-transcript-kind]').last().waitFor({ state: 'visible' });
          await page.screenshot({ path: workspaceTarget });
          process.stdout.write(`📸 ${viewport.name} session workspace -> ${workspaceTarget}\n`);

          // THE TOP BAR AS ITS OWN REVIEW SURFACE. The workspace capture proves
          // the bar's share of the viewport; this tighter image makes its actual
          // spacing legible. At 390px the destination picker is a distinct state,
          // and dismissal is part of the interaction contract, so capture both
          // sides of the same production trigger instead of posing an already-
          // open component in the harness.
          const topBar = page.locator('[data-density-region="app-bar"]');
          const topBarTarget = join(outDir, `top-bar-${viewport.name}.png`);
          await topBar.screenshot({ path: topBarTarget });
          process.stdout.write(`📸 top bar ${viewport.name} -> ${topBarTarget}\n`);
          const topBarGeometry = await page.evaluate(() => {
            const header = document.querySelector<HTMLElement>('[data-density-region="app-bar"]');
            const slot = document.querySelector<HTMLElement>('[data-app-bar-session-search-slot]');
            const headerBox = header?.getBoundingClientRect();
            const slotBox = slot?.getBoundingClientRect();
            return {
              height: headerBox === undefined ? null : Math.round(headerBox.height),
              slotCentre: slotBox === undefined ? null : Math.round(slotBox.left + slotBox.width / 2),
              viewportCentre: Math.round(window.innerWidth / 2),
            };
          });
          process.stdout.write(
            `   top bar geometry: height=${String(topBarGeometry.height)}px ` +
              `slot centre=${String(topBarGeometry.slotCentre)}px viewport centre=${topBarGeometry.viewportCentre}px\n`,
          );
          if (
            topBarGeometry.slotCentre === null ||
            Math.abs(topBarGeometry.slotCentre - topBarGeometry.viewportCentre) > 1
          ) {
            fail(`the current-session search slot is not centred at ${viewport.name}`);
          }
          if (viewport.name === 'mobile') {
            const destinationTrigger = page.getByRole('button', { name: 'Choose destination' });
            await destinationTrigger.click();
            const destinationDialog = page.getByRole('dialog', { name: 'Choose destination' });
            await destinationDialog.waitFor({ state: 'visible' });
            const pickerGeometry = await destinationDialog.evaluate(dialog => {
              const box = dialog.getBoundingClientRect();
              return {
                left: Math.round(box.left),
                right: Math.round(box.right),
                viewport: window.innerWidth,
                pageScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              };
            });
            if (
              pickerGeometry.pageScrollsX ||
              pickerGeometry.left < 0 ||
              pickerGeometry.right > pickerGeometry.viewport + 1
            ) {
              fail(`the mobile destination picker overflows its ${pickerGeometry.viewport}px viewport`);
            }
            const pickerTarget = join(outDir, 'top-bar-picker-open-mobile.png');
            await page.screenshot({ path: pickerTarget });
            process.stdout.write(`📸 top bar picker open mobile -> ${pickerTarget}\n`);

            await destinationDialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
            await destinationDialog.waitFor({ state: 'hidden' });
            const dismissedTarget = join(outDir, 'top-bar-picker-dismissed-mobile.png');
            await topBar.screenshot({ path: dismissedTarget });
            process.stdout.write(`📸 top bar picker dismissed mobile -> ${dismissedTarget}\n`);
          }

          // Geometry, printed rather than eyeballed. A screenshot cannot tell a
          // pinned tail apart from a transcript that happens to be short, and it
          // cannot show that the page itself never scrolls — which is the one
          // invariant the whole shell exists to hold (`html, body { overflow:
          // hidden }` plus one scroller per page).
          const workspaceGeometry = await page.evaluate(() => {
            const root = document.documentElement;
            const scrollers = [...document.querySelectorAll<HTMLElement>('*')].filter(element => {
              const style = getComputedStyle(element);
              const scrolls = /auto|scroll/u.test(`${style.overflowY}${style.overflowX}`);
              return scrolls && element.scrollHeight - element.clientHeight > 1;
            });
            const composer = document.querySelector<HTMLElement>('[data-session-input] form');
            const transcript = document.querySelector<HTMLElement>('.fy-transcript');
            const box = composer?.getBoundingClientRect();
            return {
              appHeight: root.style.getPropertyValue('--app-h'),
              pageScrollsX: root.scrollWidth > root.clientWidth,
              pageScrollsY: root.scrollHeight > root.clientHeight,
              scrollers: scrollers.map(element => element.className.split(/\s+/u)[0] || element.tagName),
              transcriptPinned:
                transcript === null
                  ? null
                  : transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 2,
              composerBottom: box === undefined ? null : Math.round(box.bottom),
              composerVisible: box === undefined ? null : Math.round(box.bottom) <= window.innerHeight,
              pane: document.querySelector('aside') !== null,
            };
          });
          process.stdout.write(
            `   workspace geometry: --app-h=${workspaceGeometry.appHeight || '(unset)'} ` +
              `page scroll x/y=${workspaceGeometry.pageScrollsX}/${workspaceGeometry.pageScrollsY} ` +
              `scrollers=[${workspaceGeometry.scrollers.join(', ')}] ` +
              `transcript pinned=${String(workspaceGeometry.transcriptPinned)} ` +
              `composer bottom=${String(workspaceGeometry.composerBottom)}px ` +
              `visible=${String(workspaceGeometry.composerVisible)} pane mounted=${workspaceGeometry.pane}\n`,
          );
          if (workspaceGeometry.pageScrollsX) {
            fail('the session workspace made the page scroll horizontally');
          }
          if (workspaceGeometry.composerVisible === false) {
            fail(`the composer sits below the viewport at ${viewport.name}`);
          }

          // THEN the companion pane, opened through the page's own launcher —
          // the same `pane.open('terminals', …)` a reader clicks. Driving the
          // real control is what makes this a capture of the desktop/sheet split
          // rather than of a prop someone set. The terminal surface is chosen
          // because it resolves entirely from the harness client and snapshot
          // reader: the files tree would paint a network error over the layout.
          const workspacePaneTarget = join(outDir, `${viewport.name}-session-workspace-pane.png`);
          await page.getByRole('button', { name: 'Terminal', exact: true }).click();
          await page.getByText('Session pane snapshot').waitFor({ state: 'visible' });
          await page.screenshot({ path: workspacePaneTarget });
          process.stdout.write(
            `📸 ${viewport.name} session workspace, ${viewport.name === 'mobile' ? 'sheet' : 'pane'} open -> ` +
              `${workspacePaneTarget}\n`,
          );

          // The real remote browser gets this route of its own so this is the
          // production side-pane layout taking the whole screen, not a gallery
          // card sized to look like one. The visible Exit control is the phone
          // escape hatch; Escape then proves the keyboard route returns to the
          // exact pane/sheet it started from.
          const fullBrowserTarget = join(outDir, `${viewport.name}-browser-full-viewport.png`);
          await page.goto(`${server.url}#browser-full-viewport`);
          await page.reload();
          await page.locator('#harness-browser-full-viewport-page').waitFor({ state: 'visible' });
          await page.getByLabel('Expand browser to fill the viewport').click();
          const exitBrowser = page.getByLabel('Exit full-screen browser');
          await exitBrowser.waitFor({ state: 'visible' });
          const fullBrowserGeometry = await exitBrowser.evaluate(button => {
            const frame = button.closest('aside')?.parentElement;
            const box = frame?.getBoundingClientRect();
            return {
              fixed: frame === null || frame === undefined ? false : getComputedStyle(frame).position === 'fixed',
              width: box === undefined ? null : Math.round(box.width),
              height: box === undefined ? null : Math.round(box.height),
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
            };
          });
          if (
            !fullBrowserGeometry.fixed ||
            fullBrowserGeometry.width !== fullBrowserGeometry.viewportWidth ||
            fullBrowserGeometry.height !== fullBrowserGeometry.viewportHeight
          ) {
            fail(`the full browser does not occupy the ${viewport.name} viewport`);
          }
          await page.screenshot({ path: fullBrowserTarget });
          process.stdout.write(`📸 ${viewport.name} browser full viewport -> ${fullBrowserTarget}\n`);
          await page.keyboard.press('Escape');
          await page.getByLabel('Expand browser to fill the viewport').waitFor({ state: 'visible' });

          /**
           * The five fleet frames, each on a page of its own.
           *
           * Three of them are taller than a desktop viewport, and an element capture of a tall card
           * inside the gallery's scroller clips to the wrong region — the first pass produced a fleet
           * "preview" image showing the secrets cards. On a page that starts at the top with no sticky
           * chrome, an element capture is exact.
           */
          for (const frame of FLEET_FRAMES) {
            await page.goto(`${server.url}#fleet-${frame}`);
            await page.reload();
            await page.locator(`#harness-fleet-${frame}-page`).waitFor({ state: 'visible' });
            // The two-column live-versus-proposed layout only exists while a change is staged, and
            // staging it is an interaction. Driving the real clicks is the only way to capture that
            // layout without inventing a state the surface cannot actually be in.
            if (frame === 'cockpit-staged') {
              await page.getByRole('button', { name: 'Edit layer' }).first().click();
              await page.locator('[data-fleet-layer-form]').waitFor({ state: 'visible' });
              await page.getByRole('button', { name: 'Preview this change' }).click();
              const staged = page.locator('[data-fleet-proposal-id]');
              if ((await staged.count()) === 0) {
                const refused = await page.locator('[data-fleet-refusal] pre').allInnerTexts();
                process.stdout.write(`   staging did not land: ${refused.join(' | ') || 'no refusal shown'}\n`);
              }
              await staged.waitFor({ state: 'visible' });
            }
            const fleetTarget = join(outDir, `${viewport.name}-fleet-${frame}.png`);
            // A full-page capture of a page carrying ONE frame: Chrome captures beyond the viewport
            // itself, so a frame taller than the screen is whole rather than stitched by hand.
            // The REQUIRED evidence is the viewport itself — exactly 390x844 or 1440x900, the screen a
            // person is actually holding. The full-page shot beside it supplements that; it never
            // replaces it, because a frame that only reads well when unrolled to 2000px is not a
            // frame that works on a phone.
            // Back to the top: the interaction above scrolls, and a viewport capture is supposed to show
            // what a person sees when the screen opens.
            // Blur first: the surface moves focus to the panel it just opened, and the browser scrolls a
            // focused element into view, so scrolling alone would be undone.
            // The create frame is the A2 evidence: it has to be captured WITH keyboard focus on the
            // harness radio, because the defect was that focus was not locatable there at all.
            if (frame === 'create') {
              await page.locator('[data-fleet-harness-selected="true"] input').evaluate(node => {
                (node as HTMLElement).focus();
                node.matches(':focus-visible');
              });
              await page.keyboard.press('ArrowRight');
              await page.keyboard.press('ArrowLeft');
            }
            await page.evaluate(frameName => {
              if (frameName === 'create') return;
              (document.activeElement as HTMLElement | null)?.blur();
              window.scrollTo(0, 0);
              // The scroller may be an element rather than the document, so reset every one of them.
              for (const node of document.querySelectorAll('*')) node.scrollTop = 0;
            }, frame as string);
            await page.waitForTimeout(60);
            const viewportTarget = join(outDir, `${viewport.name}-fleet-${frame}-viewport.png`);
            await page.screenshot({ path: viewportTarget });
            // Production deliberately locks html/body to one viewport. Keep that lock for the
            // required viewport evidence above, then release only the standalone harness document
            // before the supplemental full-page shot. Otherwise Chromium measures the overflowing
            // frame's full height but paints only the first viewport, leaving the rest black.
            await page.evaluate(() => {
              document.documentElement.style.height = 'auto';
              document.documentElement.style.overflow = 'auto';
              document.body.style.height = 'auto';
              document.body.style.overflow = 'auto';
            });
            await page.screenshot({ path: fleetTarget, fullPage: true });
            process.stdout.write(`📸 ${viewport.name} fleet ${frame} -> ${viewportTarget} + ${fleetTarget}\n`);
          }
          // Back to the gallery: every capture after this one expects the shell, and a page left on a
          // fleet fragment made the next locator wait for an app bar that is not on it.
          await page.goto(server.url.toString());
          await page.reload();
          await page.locator('[data-density-region="app-bar"]').first().waitFor({ state: 'visible' });

          // The install stage on a page of its own, so the capture starts at
          // the real top of the screen rather than wherever the gallery's
          // scroller happened to clip it.
          const installTarget = join(outDir, `${viewport.name}-onboarding-install-page.png`);
          await page.goto(`${server.url}#onboarding-install`);
          await page.reload();
          await page.locator('#harness-onboarding-install-page').waitFor({ state: 'visible' });
          await page.screenshot({ path: installTarget, fullPage: true });
          process.stdout.write(`📸 ${viewport.name} setup install page -> ${installTarget}\n`);

          // The pairing stage with the keyboard up: the state the reader
          // reported as broken. Phone only — a desktop has no software keyboard
          // to model, and pretending otherwise would be a made-up screenshot.
          //
          // Supplementary, not authoritative: this gallery context is 390px wide
          // but not touch-emulated, so it proves the layout and the focus, not
          // the coarse-pointer branches. The real-app driver owns that.
          if (viewport.name === 'mobile') {
            await page.addInitScript(VISUAL_VIEWPORT_SHIM);
            // A real document navigation, not a fragment jump: the alternate
            // root only mounts on load, and an init script only runs on one.
            await page.goto(`${server.url}#onboarding-keyboard`);
            await page.reload();
            await page.locator('#harness-onboarding-scan-page').waitFor({ state: 'visible' });

            // The keyboard is only up because a FIELD has focus, so the shot has
            // to start there — an unfocused capture would look identical and
            // prove nothing about the state that was reported broken.
            await page.getByRole('button', { name: 'Paste a link instead' }).click();
            const field = page.locator('#pairing-link');
            await field.waitFor({ state: 'visible' });
            await field.focus();

            const before = await page.evaluate(() => ({
              innerHeight: window.innerHeight,
              screenHeight: window.screen.height,
              visual: window.visualViewport?.height ?? null,
              focused: document.activeElement?.id ?? null,
            }));
            if (before.focused !== 'pairing-link') fail(`the pairing field never took focus (got ${before.focused})`);

            await page.evaluate(() => {
              (window as unknown as { __harnessKeyboard: (height: number) => void }).__harnessKeyboard(430);
            });
            // The producer schedules through requestAnimationFrame, so the
            // attribute lands a frame after the resize, not with it.
            await page
              .waitForFunction(() => document.documentElement.getAttribute('data-keyboard') === 'open')
              .catch(() => fail('the production viewport producer never reported an open keyboard'));

            // The keyboard is only handled if the field it belongs to is still
            // on screen. A shot of the stage with the input somewhere below the
            // fold is a picture of the bug, not of the fix.
            await page
              .waitForFunction(() => {
                const input = document.getElementById('pairing-link');
                const limit = window.visualViewport?.height ?? window.innerHeight;
                if (input === null) return false;
                const rect = input.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= limit;
              })
              .catch(async () => {
                const state = await page.evaluate(() => {
                  const input = document.getElementById('pairing-link');
                  const rect = input?.getBoundingClientRect();
                  return {
                    keyboard: document.documentElement.getAttribute('data-keyboard'),
                    appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-h'),
                    visual: window.visualViewport?.height ?? null,
                    focused: document.activeElement?.id ?? null,
                    top: Math.round(rect?.top ?? -1),
                    bottom: Math.round(rect?.bottom ?? -1),
                  };
                });
                fail(`the focused pairing field never came back into view: ${JSON.stringify(state)}`);
              });

            const after = await page.evaluate(() => {
              const rect = document.getElementById('pairing-link')?.getBoundingClientRect();
              return {
                innerHeight: window.innerHeight,
                screenHeight: window.screen.height,
                visual: window.visualViewport?.height ?? null,
                focused: document.activeElement?.id ?? null,
                keyboard: document.documentElement.getAttribute('data-keyboard'),
                fieldTop: Math.round(rect?.top ?? -1),
                fieldBottom: Math.round(rect?.bottom ?? -1),
                gate: document.getElementById('fy-portrait-gate') !== null,
              };
            });
            if (after.focused !== 'pairing-link') fail('the pairing field lost focus before the capture');
            if (after.gate) fail('the portrait gate mounted over an upright phone with its keyboard open');

            const keyboardTarget = join(outDir, `${viewport.name}-onboarding-keyboard.png`);
            await page.screenshot({ path: keyboardTarget });
            // Printed, not assumed: a shot that silently failed to open the
            // keyboard looks exactly like one that did.
            process.stdout.write(
              `📸 ${viewport.name} setup pairing, keyboard open -> ${keyboardTarget}\n` +
                `   screen ${before.screenHeight}px and layout ${before.innerHeight}px unchanged at ` +
                `${after.screenHeight}px / ${after.innerHeight}px; visual viewport ${before.visual}px -> ` +
                `${after.visual}px; data-keyboard=${after.keyboard}; focus=#${after.focused} visible at ` +
                `${after.fieldTop}-${after.fieldBottom}px; portrait gate mounted=${after.gate}\n`,
            );
          }
        } finally {
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
}
