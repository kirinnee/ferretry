/**
 * Screenshots of Settings › Voice › the engine list and the read-only speed block under it, in the states a
 * person can see: standard (the app as it ships, this site is not isolated), fast (a device that would run
 * several cores), skipped (the faster mode failed here and is turned off), no-faster (an engine with no
 * faster mode) and no-data (Browser voice: nothing of ours runs, so no block at all). Phone (390) and
 * desktop (1280), the light and dark studio themes. The dev-server link "Test speed on this device" is drawn in
 * every state that has a block, and each shot measures it (>= 44 CSS px tall, keyboard-focusable). Each shot ends well BELOW the block (its bottom edge
 * plus padding), so a clip is never mistaken for the page. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/speed-line-screenshot.tsx    # writes harness/out/speed-line-<state>-<viewport>-<scheme>.png
 *
 * It renders the REAL `DictationSettings` with the REAL `SpeedLine`. The installs are fakes built on the
 * page and the planner is given fixed signals — nothing is downloaded, no microphone opens, and no request
 * leaves the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
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

const STATES = ['standard', 'fast', 'skipped', 'no-faster', 'no-data'] as const;
/** Pixels of page kept visible under the block (or, with no block, under the engine list). */
const MARGIN_BELOW = 72;

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { DictationSettings } from '../../src/features/settings/dictation-settings.tsx';
import { ON_DEVICE_MODELS, modelDownloadBytes } from '../../src/lib/stt/model-catalog.ts';
import { OnDeviceVoice } from '../../src/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../src/lib/stt/on-device-voices.ts';
import { SpeedMemoryStore } from '../../src/lib/stt/speed-memory.ts';
import { NO_SIGNALS } from '../../src/lib/stt/speed-plan.ts';
import { SpeedPlanner } from '../../src/lib/stt/speed-planner.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { AVAILABLE_RECOGNITION, fakeRecognitionProvider } from '../../tests/support/browser-recognition.ts';

const state = new URLSearchParams(location.search).get('state') ?? 'standard';
const engine = state === 'no-faster' ? 'vosk-small-en' : state === 'no-data' ? 'browser' : 'parakeet';
const ISOLATED = { ...NO_SIGNALS, crossOriginIsolated: true, hardwareConcurrency: 8, deviceMemoryGb: 8 };
const planner = new SpeedPlanner({
  signals: state === 'standard' || state === 'no-faster' ? { ...NO_SIGNALS, hardwareConcurrency: 8, deviceMemoryGb: 8 } : ISOLATED,
  memory: new SpeedMemoryStore(null),
  now: () => 1,
});
if (state === 'skipped') planner.threadsFailed('parakeet');

const voices = new OnDeviceVoices(
  ON_DEVICE_MODELS.map((model, index) => {
    const totalBytes = modelDownloadBytes(model);
    const installed = model.id === 'parakeet' || index % 3 === 0;
    return new OnDeviceVoice({
      model,
      support: { available: true },
      store: {
        totalBytes,
        status: async () =>
          installed
            ? { state: 'installed' as const, version: model.versionLabel, bytes: totalBytes, installedAt: '2026-10-22T08:00:00.000Z' }
            : { state: 'absent' as const },
        install: () => new Promise(() => undefined),
        remove: async () => undefined,
      },
      openSession: null,
    });
  }),
);

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div style={{ margin: '0 auto', maxWidth: 760, padding: '16px 16px 160px' }}>
    <DictationSettings
      settings={{ ...DEFAULT_STT_SETTINGS, engine }}
      update={() => undefined}
      persisted
      recognitionSupport={AVAILABLE_RECOGNITION}
      recognitionProvider={fakeRecognitionProvider()}
      voices={voices}
      speedPlanner={planner}
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
    <!-- The app shell scrolls its own panes; this page scrolls the window. Chrome paints nothing far down a tall
         overflow:hidden root, so let it overflow like an ordinary page. -->
    <style>html, body { overflow: visible !important; height: auto !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/speed-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
// The page's CSS asks for the self-hosted fonts at /assets/fonts/…; serve the real files so the shots use them.
cpSync(join(packageDir, 'src', 'assets', 'fonts'), join(outDir, 'assets', 'fonts'), { recursive: true });
await Bun.write(join(outDir, 'speed-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'speed-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 900, mobile: true },
  { name: 'desktop', width: 1280, height: 900, mobile: false },
] as const;

try {
  for (const state of STATES) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 2,
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
            return await route.continue();
          });
          const page = await context.newPage();
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          // No-data has no speed block: anchor on the engine list and prove the block is absent.
          const speed = page
            .locator(state === 'no-data' ? 'section[aria-label="Voice engine"]' : 'section[aria-label="Speed"]')
            .first();
          await speed.waitFor({ state: 'visible' });
          const blocks = await page.locator('section[aria-label="Speed"]').count();
          if ((state === 'no-data') !== (blocks === 0)) fail(`${state}: speed block count ${blocks}`);
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (sideways > 0) fail(`${state} ${scheme} ${viewport.name} scrolls sideways by ${sideways}px`);
          // Scroll so MARGIN_BELOW px of real page sit under the block (it ends in the middle of a screen, never
          // flush with its bottom edge), then take the viewport: nothing is clipped by a made-up rectangle.
          const first = await speed.boundingBox();
          if (first === null) fail('the speed block has no box');
          const wanted =
            (first as { y: number; height: number }).y + (first as { height: number }).height + MARGIN_BELOW;
          await page.evaluate(target => window.scrollTo(0, target - window.innerHeight), wanted);
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
          await page.waitForTimeout(300);
          const line = await speed.boundingBox();
          if (line === null) fail('the speed block has no box');
          const { y, height } = line as { y: number; height: number };
          const below = viewport.height - (y + height);
          if (below < MARGIN_BELOW - 1) fail(`${state} ${viewport.name} ${scheme}: only ${below}px below the block`);
          const target = join(outDir, `speed-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
          // A block with a speed block also has the dev-server link: it must be a real tap target (>= 44 px tall).
          const link = page.locator('section[aria-label="Speed"] a[data-speed-test-link]');
          if ((state === 'no-data') !== ((await link.count()) === 0)) fail(`${state}: speed test link count`);
          if (state !== 'no-data') {
            const linkBox = await link.boundingBox();
            if (linkBox === null) fail('the speed test link has no box');
            const linkHeight = (linkBox as { height: number }).height;
            if (linkHeight < 44) fail(`${state} ${scheme} ${viewport.name}: link is ${linkHeight}px tall, under 44`);
            await link.focus();
            const focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-speed-test-link'));
            if (focused !== true) fail(`${state}: the link did not take keyboard focus`);
            await page.evaluate(() => (document.activeElement as HTMLElement).blur());
            process.stdout.write(`📏 ${state} ${viewport.name} ${scheme}: link ${linkHeight} CSS px tall\n`);
          }
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
