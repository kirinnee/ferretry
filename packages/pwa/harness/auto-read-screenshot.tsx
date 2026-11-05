/**
 * Screenshots of AUTO-READ REPLIES (F137 slice 2): the Settings › Voice › "Read replies aloud" section (off, on,
 * the voice list with local / remote labels, a remote voice chosen, Preview going) and the "Reading the reply"
 * chip. Phone (390) and desktop (1280), light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/auto-read-screenshot.tsx             # writes <out>/<light|dark>/<scene>-<phone|desktop>[-partN].png
 *   FY_AUTO_READ_SHOTS_DIR=/tmp/shots bun harness/auto-read-screenshot.tsx
 *
 * It renders the REAL settings section and chip with a controller over a FAKE speaker that makes no sound.
 * Everything on screen is invented. A page taller than the viewport is cut into
 * viewport-high parts so every part can be read at full size.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = process.env.FY_AUTO_READ_SHOTS_DIR ?? join(buildDir, 'auto-read');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AutoReadChip } from '../../src/components/auto-read-chip.tsx';
import { AutoReadSettings } from '../../src/features/settings/auto-read-settings.tsx';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsProvider } from '../../src/hooks/use-live-voice-settings.ts';
import type { SpeakerEvent, SpeakerPort, SpeakerVoice } from '../../src/lib/voice-chat/ports.ts';
import { createReadAloud } from '../../src/lib/voice-chat/read-aloud.ts';
import { LiveVoiceSettingsStore } from '../../src/lib/voice-chat/live-settings.ts';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'off';

const VOICES: readonly SpeakerVoice[] = [
  { id: 'a', name: 'Samantha', lang: 'en-US', local: true, isDefault: true },
  { id: 'b', name: 'Daniel', lang: 'en-GB', local: true, isDefault: false },
  { id: 'c', name: 'Karen', lang: 'en-AU', local: true, isDefault: false },
  { id: 'g', name: 'Google US English', lang: 'en-US', local: false, isDefault: false },
];

// A speaker that makes no sound: it only reports the first sentence as being said.
const quiet = (): SpeakerPort => {
  let hear: ((event: SpeakerEvent) => void) | null = null;
  return {
    supported: true,
    voices: () => VOICES,
    unlock: () => undefined,
    speak: (_request, onEvent) => {
      hear = onEvent;
      onEvent({ type: 'segment', index: 0 });
    },
    stop: () => hear?.({ type: 'stopped' }),
  };
};

const controller = createReadAloud({ speaker: quiet(), language: () => 'en-US' });
const memory = new Map<string, string>();
const store = new LiveVoiceSettingsStore({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => void memory.set(key, value) });
if (scene !== 'off') store.update({ autoRead: true });
if (scene === 'remote') store.update({ voiceId: 'g', rate: 1.4 });
if (scene === 'voices' || scene === 'preview') store.update({ voiceId: 'b', rate: 1.3, maxSeconds: 120, whatToRead: 'every' });

function Driver() {
  useEffect(() => {
    if (scene === 'voices') {
      const select = document.querySelector<HTMLSelectElement>('#auto-read-voice');
      if (select) select.size = 7;
    }
    if (scene === 'preview') document.querySelector<HTMLButtonElement>('[data-preview]')?.click();
    if (scene === 'chip') controller.read('a1', 'The fix is in. All tests pass.');
    document.body.dataset.ready = '1';
  }, []);
  return null;
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <LiveVoiceSettingsProvider store={store}>
    <ReadAloudProvider controller={controller}>
      <Driver />
      <main data-auto-read-scene="" style={{ margin: '0 auto', maxWidth: 760, padding: '12px 16px' }}>
        {scene === 'chip' ? <AutoReadChip onStop={() => controller.stop()} reading /> : <AutoReadSettings />}
      </main>
    </ReadAloudProvider>
  </LiveVoiceSettingsProvider>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/auto-read-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
await Bun.write(join(buildDir, 'auto-read-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'auto-read-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
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
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1280, height: 800, mobile: false },
] as const;
const SCENES = ['off', 'on', 'voices', 'remote', 'preview', 'chip'] as const;

try {
  for (const scheme of ['light', 'dark'] as const) {
    mkdirSync(join(outDir, scheme), { recursive: true });
    for (const viewport of VIEWPORTS) {
      for (const scene of SCENES) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 2,
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
          timezoneId: 'Asia/Tokyo',
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
            return await route.continue();
          });
          const page = await context.newPage();
          page.on('pageerror', error => fail(`page error in ${scene}: ${error.message}`));
          await page.goto(`${server.url}?theme=studio-${scheme}&scene=${scene}`);
          await page.locator('body[data-ready="1"]').waitFor({ state: 'attached' });
          await page.locator('[data-auto-read-scene]').waitFor({ state: 'visible' });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scheme} ${viewport.name} ${scene} scrolls sideways by ${overflow}px`);
          await page.waitForTimeout(200);
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          const parts = Math.max(1, Math.ceil(height / viewport.height));
          for (let part = 0; part < parts; part += 1) {
            const suffix = parts === 1 ? '' : `-part${part + 1}`;
            const target = join(outDir, scheme, `${scene}-${viewport.name}${suffix}.png`);
            await page.screenshot({
              path: target,
              fullPage: true,
              clip: {
                x: 0,
                y: part * viewport.height,
                width: viewport.width,
                height: Math.min(viewport.height, height - part * viewport.height),
              },
            });
            process.stdout.write(`📸 ${target}\n`);
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
