/**
 * Screenshots of browser-side dictation clean-up: Settings › This device › Speed-up keys (one key saved
 * and tested, one not), and the review box after a take cleaned straight from the browser with that key
 * and after a take with no key anywhere. Phone (390) and desktop (1440), light and dark studio themes.
 * Review evidence; nothing compares the PNGs.
 *
 *   bun harness/device-cleanup-screenshot.tsx    # writes harness/out/device-cleanup-*.png
 *
 * It renders the REAL settings section and the REAL `Composer`, with a real vault in the browser's own
 * IndexedDB holding a FAKE key. Groq, Cerebras and the daemon are Playwright routes: every request to
 * them is answered here, and anything else is aborted, so nothing leaves the machine.
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
import { Composer } from '../../src/components/composer.tsx';
import { SETTINGS_DEFINITIONS } from '../../src/features/settings/settings-catalog.ts';
import { SettingsScope, SettingsSection } from '../../src/features/settings/settings-page.tsx';
import { SpeedupKeysSettings } from '../../src/features/settings/speedup-keys-settings.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { browserFetch } from '../../src/lib/runtime-models.ts';
import { type AppStore, StoreProvider } from '../../src/lib/store.tsx';
import { DeviceSpeedupKeys, IndexedDbSpeedupKeyRecords } from '../../src/lib/stt/speedup-keys.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { fakeRecognitionProvider } from '../../tests/support/browser-recognition.ts';

const params = new URLSearchParams(window.location.search);
const view = params.get('view') ?? 'settings';
const keys = new DeviceSpeedupKeys(new IndexedDbSpeedupKeyRecords(indexedDB), crypto.subtle, browserFetch);
// A FAKE key: the provider is a route in this harness, and this value is spent nowhere.
if (params.get('key') === 'groq') await keys.save('groq', 'gsk_harness_fake_key_not_real_00ab');
else await keys.remove('groq');

const compact = window.matchMedia('(max-width: 600px)').matches;
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

if (view === 'settings') {
  const definition = SETTINGS_DEFINITIONS.find(setting => setting.id === 'speedup-keys');
  if (definition === undefined) throw new Error('no speed-up keys setting');
  createRoot(root).render(
    <div style={{ margin: '0 auto', maxWidth: 760, padding: compact ? 16 : 32 }}>
      <h2 className="m-0 text-title font-bold text-fg">This device</h2>
      <SettingsScope scope="device" />
      <div style={{ marginTop: 16 }}>
        <SettingsSection definition={definition}>
          <SpeedupKeysSettings keys={keys} />
        </SettingsSection>
      </div>
    </div>,
  );
} else {
  writeMdComposePref('off');
  const provider = fakeRecognitionProvider({ endsOnStop: true });
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
    enhancementProvider: 'groq' as const,
  };
  // Only what dictation reads from the app store: this device's keys, and a carrier for the daemon call.
  const appStore = {
    speedupKeys: keys,
    carrier: { fetch: browserFetch },
    clients: { client: async () => { throw new Error('no daemon client in this harness'); } },
  } as unknown as AppStore;
  createRoot(root).render(
    <StoreProvider store={appStore}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', justifyContent: 'flex-end', padding: compact ? 4 : 24 }}>
        <div style={{ margin: '0 auto', width: '100%', maxWidth: 760 }}>
          <Composer
            api={{ send: async () => ({}) as never }}
            compact={compact}
            daemon={daemon}
            dictationRecognition={provider}
            dictationSettings={settings}
            dictationConversation={() => ['Can you restart the fyd daemon on ferretry?']}
            draftStore={store}
            sessionId="harness-dictation"
          />
        </div>
      </div>
    </StoreProvider>,
  );
}
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/device-cleanup-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'device-cleanup-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'device-cleanup-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, accept',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
/** A cross-origin call is preflighted; answer it as the real hosts do, or the browser reports a network failure. */
const PREFLIGHT = { status: 204, headers: CORS, body: '' };
const json = (status: number, body: unknown) => ({
  status,
  contentType: 'application/json',
  headers: CORS,
  body: JSON.stringify(body),
});
const MODELS = json(200, { data: Array.from({ length: 18 }, (_, index) => ({ id: `model-${index}` })) });
const SPOKEN = 'um can you restart the fide daemon on ferretree';
const CLEANED = 'Can you restart the fyd daemon on Ferretry?';
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
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
          const origin = new URL(route.request().url()).origin;
          if (origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        await context.route('https://api.groq.com/**', async route =>
          route.request().method() === 'OPTIONS'
            ? await route.fulfill(PREFLIGHT)
            : route.request().url().endsWith('/models')
              ? await route.fulfill(MODELS)
              : await route.fulfill(json(200, { choices: [{ message: { content: CLEANED }, finish_reason: 'stop' }] })),
        );
        // The daemon holds no key either, so the take with no device key says where to add one.
        // A daemon call carries credentials, so it is answered for the page's own origin rather than `*`.
        const daemonCors = {
          ...CORS,
          'access-control-allow-origin': server.url.origin,
          'access-control-allow-credentials': 'true',
        };
        await context.route('https://harness.invalid/v1/stt/enhance', async route =>
          route.request().method() === 'OPTIONS'
            ? await route.fulfill({ ...PREFLIGHT, headers: daemonCors })
            : await route.fulfill({
                ...json(503, { code: 'secret_missing', error: 'enhancement provider is not configured' }),
                headers: daemonCors,
              }),
        );
        const page = await context.newPage();
        page.on('pageerror', error => fail(`page error: ${error.message}`));
        if (process.env.DEBUG_SHOTS)
          page.on('request', request => process.stdout.write(`→ ${request.method()} ${request.url()}\n`));
        if (process.env.DEBUG_SHOTS)
          page.on('requestfailed', request =>
            process.stdout.write(`✗ ${request.url()} ${request.failure()?.errorText}\n`),
          );
        const shot = async (name: string): Promise<void> => {
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (sideways > 0) fail(`${scheme} ${viewport.name} ${name} scrolls sideways by ${sideways}px`);
          const target = join(outDir, `device-cleanup-${name}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        };

        // The setting: a Groq key saved and tested, Cerebras not saved.
        await page.goto(`${server.url}?theme=studio-${scheme}&view=settings&key=groq`);
        await page.locator('[data-device-key-saved]').waitFor({ state: 'visible' });
        await page.locator('button[aria-label="Test the Groq key"]').click();
        await page.locator('[data-device-key-test]').waitFor({ state: 'visible' });
        await shot('settings');
        // A phone shows the top of the section first; the second shot is the two key cards.
        if (viewport.mobile) {
          await page.locator('[data-device-key="groq"]').evaluate(card => card.scrollIntoView({ block: 'start' }));
          await shot('settings-keys');
        }

        for (const take of [
          { name: 'review-cleaned', key: 'groq', ready: 'button:has-text("Raw")' },
          { name: 'review-no-key', key: 'none', ready: '[data-review-notice="cleanup-failed"]' },
        ]) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=review&key=${take.key}`);
          await page.locator('textarea').fill('Please look at the daemon logs. ');
          const mic = page.locator('button[aria-label="Dictate a message"]');
          await mic.waitFor({ state: 'visible' });
          await mic.click();
          await page.evaluate(() => (window as unknown as { provider: { begin(): void } }).provider.begin());
          await page.evaluate(
            text => (window as unknown as { provider: { speak(text: string): void } }).provider.speak(text),
            SPOKEN,
          );
          await page.locator('[data-dictation-panel]').waitFor({ state: 'visible' });
          await page.locator('button[aria-label^="Stop recording"]').click();
          await page.locator(take.ready).first().waitFor({ state: 'visible' });
          await shot(take.name);
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
