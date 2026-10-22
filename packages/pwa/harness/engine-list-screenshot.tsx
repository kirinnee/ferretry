/**
 * Screenshots of Settings › Voice › Engine: every catalog model and browser voice, one model installed
 * with a finished Try it, one mid-download, phone (390) and desktop (1440), the light and dark studio
 * themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/engine-list-screenshot.tsx    # writes harness/out/engine-list-*.png
 *   ENGINE_LIST_FOCUS=vosk-small-en bun harness/engine-list-screenshot.tsx
 *                                             # that model installed, in use and tried: engine-list-vosk-small-en-*.png
 *
 * It renders the REAL `DictationSettings` and its REAL engine list. The installs and the trial's
 * session are fakes built on the page — nothing is downloaded, no microphone opens, and no request
 * leaves the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { ON_DEVICE_MODELS } from '../src/lib/stt/model-catalog.ts';

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

/** A model to show installed, in use and tried, instead of the round-robin's first installed one. */
const focus = process.env.ENGINE_LIST_FOCUS?.trim() ?? '';

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { DictationSettings } from '../../src/features/settings/dictation-settings.tsx';
import { ON_DEVICE_MODELS, modelDownloadBytes } from '../../src/lib/stt/model-catalog.ts';
import type { ModelStoreStatus } from '../../src/lib/stt/model-store.ts';
import { OnDeviceVoice } from '../../src/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../src/lib/stt/on-device-voices.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { AVAILABLE_RECOGNITION, fakeRecognitionProvider } from '../../tests/support/browser-recognition.ts';

/** Installed, part-way down, not installed — round-robin over the catalog. */
const stateOf = (index: number, bytes: number, version: string): ModelStoreStatus =>
  index % 3 === 0
    ? { state: 'installed', version, bytes, installedAt: '2026-10-22T08:00:00.000Z' }
    : index % 3 === 1
      ? { state: 'partial', downloadedBytes: Math.round(bytes * 0.4) }
      : { state: 'absent' };

const FOCUS = ${JSON.stringify(focus)};

const voices = new OnDeviceVoices(
  ON_DEVICE_MODELS.map((model, index) => {
    const totalBytes = modelDownloadBytes(model);
    const status = stateOf(model.id === FOCUS ? 0 : index, totalBytes, model.versionLabel);
    return new OnDeviceVoice({
      model,
      support: { available: true },
      store: {
        totalBytes,
        status: async () => status,
        install: () => new Promise(() => undefined),
        remove: async () => undefined,
      },
      openSession: options => ({
        start: () => {
          options.onStart();
          setTimeout(() => options.onLive?.({ committed: 'restart the', interim: 'daemon', paused: false }), 60);
        },
        finish: () => new Promise(done => setTimeout(() => done('Restart the daemon on the build box.'), 80)),
        cancel: () => undefined,
      }),
    });
  }),
);
(window as unknown as { voices: OnDeviceVoices }).voices = voices;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div style={{ margin: '0 auto', maxWidth: 760, padding: 16 }}>
    <DictationSettings
      settings={{ ...DEFAULT_STT_SETTINGS, engine: ON_DEVICE_MODELS.find(model => model.id === FOCUS)?.id ?? ON_DEVICE_MODELS[0]?.id ?? 'browser' }}
      update={() => undefined}
      persisted
      recognitionSupport={AVAILABLE_RECOGNITION}
      recognitionProvider={fakeRecognitionProvider()}
      voices={voices}
      trialClock={{
        now: () => performance.now(),
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: handle => clearTimeout(handle as number),
        recordMs: 200,
      }}
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/engine-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'engine-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'engine-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
  // Tall enough to paint the whole section: the app's shell pins the body to the viewport.
  { name: 'phone', width: 390, height: 3200, mobile: true },
  { name: 'desktop', width: 1440, height: 1800, mobile: false },
] as const;

try {
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
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        const section = page.locator('section[aria-label="Voice engine"]');
        await section.waitFor({ state: 'visible' });
        const installed = page.locator('[data-model-phase="installed"]').first();
        await installed.waitFor({ state: 'visible' });
        const focused = ON_DEVICE_MODELS.find(model => model.id === focus);
        await page
          .getByRole('button', { name: focused === undefined ? /^Try / : `Try ${focused.shortName}` })
          .first()
          .click();
        await page.locator('[data-trial="done"]').first().waitFor({ state: 'visible' });
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (sideways > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${sideways}px`);
        const target = join(outDir, `engine-list-${focus === '' ? '' : `${focus}-`}${viewport.name}-${scheme}.png`);
        await section.screenshot({ path: target });
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
