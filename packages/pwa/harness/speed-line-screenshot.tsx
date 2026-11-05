/**
 * Screenshots of Settings › Voice › the engine list and the read-only Speed line under it, in the three
 * states a person can see: the app as it ships (single-thread, this page is not isolated), a device that
 * would run multi-thread (isolated, cores and memory to spare), and one where threads failed and are
 * skipped. Phone (390) and desktop (1440), the light and dark studio themes. Review evidence; nothing
 * compares the PNGs.
 *
 *   bun harness/speed-line-screenshot.tsx    # writes harness/out/speed-line-<state>-<viewport>-<scheme>.png
 *
 * It renders the REAL `DictationSettings` with the REAL `SpeedLine`. The installs are fakes built on the
 * page and the planner is given fixed signals — nothing is downloaded, no microphone opens, and no request
 * leaves the loopback origin.
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

const STATES = ['shipped', 'threads', 'skipped'] as const;

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

const state = new URLSearchParams(location.search).get('state') ?? 'shipped';
const ISOLATED = { ...NO_SIGNALS, crossOriginIsolated: true, hardwareConcurrency: 8, deviceMemoryGb: 8 };
const planner = new SpeedPlanner({
  signals: state === 'shipped' ? { ...NO_SIGNALS, hardwareConcurrency: 8, deviceMemoryGb: 8 } : ISOLATED,
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
  <div style={{ margin: '0 auto', maxWidth: 760, padding: 16 }}>
    <DictationSettings
      settings={{ ...DEFAULT_STT_SETTINGS, engine: 'parakeet' }}
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
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/speed-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
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
  { name: 'phone', width: 390, height: 3200, mobile: true },
  { name: 'desktop', width: 1440, height: 1800, mobile: false },
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
          const speed = page.locator('section[aria-label="Speed"]');
          await speed.waitFor({ state: 'visible' });
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (sideways > 0) fail(`${state} ${scheme} ${viewport.name} scrolls sideways by ${sideways}px`);
          // The line with the last engine rows above it, scrolled into the viewport: a clip is viewport-relative.
          await speed.evaluate(element => element.scrollIntoView({ block: 'end' }));
          const line = await speed.boundingBox();
          if (line === null) fail('the speed line has no box');
          const { y, height } = line as { y: number; height: number };
          const top = Math.max(0, y - 520);
          const target = join(outDir, `speed-line-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({
            path: target,
            clip: {
              x: 0,
              y: top,
              width: viewport.width,
              height: Math.min(page.viewportSize()?.height ?? 900, y + height + 16) - top,
            },
          });
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
