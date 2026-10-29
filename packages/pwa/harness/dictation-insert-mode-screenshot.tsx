/**
 * Screenshots of the "After dictating" device setting (Review first / Insert straight away) in
 * Settings › Voice, and of the "Inserted · Undo" note the Insert straight away choice leaves above the
 * composer. Phone (390) and desktop (1440), the light and dark studio themes. Review evidence; nothing
 * compares the PNGs.
 *
 *   bun harness/dictation-insert-mode-screenshot.tsx    # writes harness/out/dictation-insert-mode-*.png
 *
 * It renders the REAL `DictationSettings` and the REAL `Composer` with its REAL `DictationControl`; only
 * the browser's SpeechRecognition is the test fake, driven from the page, and no request leaves the
 * loopback origin.
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
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../src/components/composer.tsx';
import { DictationSettings } from '../../src/features/settings/dictation-settings.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../src/lib/stt/stt-settings.ts';
import { fakeRecognitionProvider } from '../../tests/support/browser-recognition.ts';

const params = new URLSearchParams(location.search);
const view = params.get('view');
const choice: 'insert' | 'review' = params.get('choice') === 'insert' ? 'insert' : 'review';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

function SettingsView() {
  const [settings, setSettings] = useState<SttSettings>({ ...DEFAULT_STT_SETTINGS, engine: 'browser', afterDictation: choice });
  return (
    <div className="flex flex-col bg-bg p-4" style={{ maxWidth: 720, margin: '0 auto' }}>
      <DictationSettings
        settings={settings}
        update={patch => setSettings(current => ({ ...current, ...patch }))}
        persisted
        recognitionSupport={{ available: true, availability: 'available', implementation: 'standard' }}
        voice={null}
      />
    </div>
  );
}

if (view === 'composer') {
  writeMdComposePref('off');
  const provider = fakeRecognitionProvider({ endsOnStop: true });
  (window as unknown as { provider: typeof provider }).provider = provider;
  const entries = new Map();
  const store = new DaemonDraftStore({
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  });
  const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'harness' });
  const settings: SttSettings = { ...DEFAULT_STT_SETTINGS, engine: 'browser', enhancement: true, afterDictation: 'insert', dictionary: ['ferretry = ferretree'] };
  const compact = window.matchMedia('(max-width: 600px)').matches;
  createRoot(root).render(
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', justifyContent: 'flex-end', padding: compact ? 4 : 24 }}>
      <div style={{ margin: '0 auto', width: '100%', maxWidth: 760 }}>
        <Composer
          api={{ send: async () => ({}) as never }}
          compact={compact}
          daemon={daemon}
          dictationRecognition={provider}
          dictationSettings={settings}
          draftStore={store}
          sessionId="harness-dictation-insert"
        />
      </div>
    </div>,
  );
} else {
  createRoot(root).render(<SettingsView />);
}
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/dictation-insert-mode-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'dictation-insert-mode-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'dictation-insert-mode-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 900, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
] as const;

const shotsDir = process.env.DICTATION_INSERT_MODE_SHOTS ?? outDir;
mkdirSync(shotsDir, { recursive: true });
const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
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
        const noSideways = async (what: string): Promise<void> => {
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (sideways > 0) fail(`${what} at ${viewport.name}/${scheme} scrolls sideways by ${sideways}px`);
        };

        for (const choice of ['review', 'insert'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=settings&choice=${choice}`);
          const section = page.locator('section[aria-label="After dictating"]');
          await section.waitFor({ state: 'visible' });
          const checked = await page.locator(`input[name="stt-after-dictation"][value="${choice}"]`).isChecked();
          if (!checked) fail(`${choice} is not the selected choice`);
          await noSideways(`setting ${choice}`);
          const target = join(shotsDir, `dictation-insert-mode-setting-${choice}-${viewport.name}-${scheme}.png`);
          // The section sits far down the screen: grow the window to the whole page, then clip to the section.
          const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          await page.setViewportSize({ width: viewport.width, height: Math.max(pageHeight, 8_000) });
          await page.waitForTimeout(200);
          const box = await section.boundingBox();
          if (box === null) fail(`setting ${choice} has no box`);
          const at = box ?? { x: 0, y: 0, width: 0, height: 0 };
          await page.screenshot({
            path: target,
            clip: { x: 0, y: Math.max(0, at.y - 16), width: viewport.width, height: at.height + 32 },
          });
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          process.stdout.write(`📸 ${target}\n`);
        }

        await page.goto(`${server.url}?theme=studio-${scheme}&view=composer`);
        await page.locator('textarea').fill('Please look at the daemon logs. ');
        const mic = page.locator('button[aria-label="Dictate a message"]');
        await mic.waitFor({ state: 'visible' });
        await mic.click();
        await page.evaluate(() => (window as unknown as { provider: { begin(): void } }).provider.begin());
        await page.evaluate(() =>
          (window as unknown as { provider: { speak(text: string): void } }).provider.speak(
            'ask ferretree to restart the daemon',
          ),
        );
        await page.locator('button[aria-label^="Stop recording"]').click();
        await page.locator('[data-dictation-inserted]').waitFor({ state: 'visible' });
        const draft = await page.locator('textarea').inputValue();
        if (!draft.includes('ask ferretry to restart the daemon')) fail(`unexpected draft: ${draft}`);
        if ((await page.locator('[data-dictation-panel]').count()) !== 0) fail('the panel stayed open');
        await noSideways('inserted note');
        const target = join(shotsDir, `dictation-insert-mode-inserted-undo-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: target });
        process.stdout.write(`📸 ${target}\n`);

        await page.locator('button[aria-label="Undo the inserted dictation"]').click();
        const undone = await page.locator('textarea').inputValue();
        if (undone !== 'Please look at the daemon logs. ') fail(`undo left: ${undone}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
