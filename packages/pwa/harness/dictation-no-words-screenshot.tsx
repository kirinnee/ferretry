/**
 * Screenshots of the browser-voice "no words" failure on Android: the strip's wording and the inline
 * "Use Parakeet and record again" offer. Phone (390) and desktop (1440), light and dark. Review evidence;
 * nothing compares the PNGs.
 *
 *   bun harness/dictation-no-words-screenshot.tsx    # writes harness/out/dictation-no-words-*.png
 *
 * It renders the REAL `Composer` and its REAL `DictationControl` inside a store that holds only the
 * dictation settings; the browser's SpeechRecognition is the test fake (flagged Android), driven from the page.
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
import { StoreProvider } from '../../src/lib/store.tsx';
import { SttSettingsStore } from '../../src/lib/stt/stt-settings.ts';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { fakeRecognitionProvider } from '../../tests/support/browser-recognition.ts';

// The plain textarea: the draft is read back from it, and the live editor has its own harness.
writeMdComposePref('off');
const provider = Object.assign(fakeRecognitionProvider({ endsOnStop: true }), { android: true });
const sttStore = new SttSettingsStore({ getItem: () => null, setItem: () => undefined });
(window as unknown as { provider: typeof provider }).provider = provider;

const entries = new Map<string, string>();
const store = new DaemonDraftStore({
  getItem: key => entries.get(key) ?? null,
  setItem: (key, value) => void entries.set(key, value),
});
const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'harness' });
const settings = {
  ...DEFAULT_STT_SETTINGS,
  engine: 'browser' as const,
  enhancement: true,
  dictionary: ['ferretry = ferretree', 'fyd = fide'],
};
const compact = window.matchMedia('(max-width: 600px)').matches;
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StoreProvider store={{ stt: sttStore } as never}>
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', justifyContent: 'flex-end', padding: compact ? 4 : 24 }}>
      <div style={{ margin: '0 auto', width: '100%', maxWidth: 760 }}>
        <Composer
          api={{ send: async () => ({}) as never }}
          compact={compact}
          daemon={daemon}
          dictationRecognition={provider}
          dictationSettings={settings}
          draftStore={store}
          sessionId="harness-dictation"
        />
      </div>
    </div>
  </StoreProvider>,
  );
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/no-words-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'no-words-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'no-words-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
// A synthetic microphone, so the real input meter draws a real wave without any hardware.
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 640, mobile: true },
  { name: 'desktop', width: 1440, height: 700, mobile: false },
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
        permissions: ['microphone'],
        reducedMotion: 'reduce',
        userAgent: viewport.mobile
          ? 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
          : undefined,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        const shot = async (name: string): Promise<void> => {
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (sideways > 0) fail(`${scheme} ${viewport.name} ${name} scrolls sideways by ${sideways}px`);
          const target = join(outDir, `dictation-no-words-${name}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        };
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('textarea').fill('Please look at the daemon logs. ');
        const mic = page.locator('button[aria-label="Dictate a message"]');
        await mic.waitFor({ state: 'visible' });
        await mic.click();
        await page.evaluate(() => (window as unknown as { provider: { begin(): void } }).provider.begin());
        await page.locator('[data-dictation-panel]').waitFor({ state: 'visible' });
        await page.evaluate(() => (window as unknown as { provider: { nomatch(): void } }).provider.nomatch());
        await shot('1-recording');

        await page.locator('button[aria-label^="Stop recording"]').click();
        await page.getByRole('button', { name: 'Use Parakeet and record again' }).waitFor({ state: 'visible' });
        await shot('2-no-words-offer');
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
