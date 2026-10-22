/**
 * Screenshots of the dictation TIMING views: the transcription log with its median / p90 summary and a
 * stacked bar on each dictation, and the debug sheet's Timeline section. Phone (390) and desktop (1440),
 * the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/dictation-timing-screenshot.tsx [outDir]   # writes <outDir>/dictation-timing-<view>-<viewport>-<scheme>.png
 *
 * It renders the REAL `TranscriptionLogSettings` and `DictationDebugSheet` over made-up numbers and an
 * invented dictation. No credential exists here and every request off the loopback origin is aborted.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const bundleDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? bundleDir);

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
import type { CleanupTrace } from '@ferretry/protocol';
import { DictationDebugSheet } from '../../src/components/dictation-debug-sheet.tsx';
import { TranscriptionLogSettings } from '../../src/features/settings/transcription-log-settings.tsx';
import type { DictationTimeline } from '../../src/lib/stt/dictation-timeline.ts';
import { TranscriptionLog } from '../../src/lib/stt/transcription-log.ts';

const startedAt = Date.UTC(2026, 9, 21, 9, 30, 15);

const timeline = (speechMs: number, cleanupMs: number, extra: Partial<DictationTimeline> = {}): DictationTimeline => ({
  totalMs: speechMs + cleanupMs + 60,
  audio: { ms: 6_200, bytes: 396_800 },
  prepareMs: 38,
  speech: { engine: 'parakeet', provider: 'on-device', model: 'parakeet-tdt-0.6b-v3', totalMs: speechMs },
  contextMs: 12,
  cleanup: {
    provider: 'groq',
    model: 'example-model-8b',
    via: 'device',
    outcome: 'cleaned',
    attempts: 1,
    firstByteMs: Math.round(cleanupMs * 0.8),
    promptTokens: 212,
    completionTokens: 11,
    totalMs: cleanupMs,
  },
  insertMs: 5,
  reviewMs: 4_100,
  ...extra,
});

const view = new URLSearchParams(location.search).get('view') ?? 'log';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

if (view === 'sheet') {
  const trace: CleanupTrace = {
    via: 'device',
    provider: 'groq',
    model: 'example-model-8b',
    host: 'api.example.invalid',
    startedAt,
    totalMs: 1_380,
    outcome: 'cleaned',
    finalText: 'Ask Ferretry to restart the daemon.',
    attempts: [{
      withContext: true,
      request: {
        host: 'api.example.invalid',
        path: '/openai/v1/chat/completions',
        headers: { authorization: '[redacted]' },
        params: { model: 'example-model-8b' },
        messages: [{ role: 'user', content: 'um ask ferretree to restart the the daemon' }],
      },
      status: 200,
      response: { raw: '{}', content: 'Ask Ferretry to restart the daemon.', verdict: 'cleaned', steps: [] },
      timings: { firstByteMs: 1_100, totalMs: 1_380 },
    }],
  };
  createRoot(root).render(
    <DictationDebugSheet
      record={{ id: 'debug-1', at: startedAt, trace, timeline: timeline(640, 1_380, { speech: { engine: 'parakeet', provider: 'on-device', model: 'parakeet-tdt-0.6b-v3', totalMs: 640, loadMs: 2_300 } }) }}
      copy={async () => undefined}
      onClose={() => undefined}
    />,
  );
} else {
  let issued = 0;
  const log = new TranscriptionLog(undefined, {
    storage: { getItem: () => null, setItem: () => undefined },
    now: () => startedAt,
    newId: () => 'entry-' + String((issued += 1)),
  });
  const rows: [string, DictationTimeline | undefined][] = [
    ['Ask Ferretry to restart the daemon.', timeline(640, 1_380)],
    ['Please look at the daemon logs.', timeline(540, 410)],
    ['Add a test for the relay carrier.', timeline(2_900, 380)],
    ['Rename the branch before pushing.', timeline(610, 460, { cleanup: { provider: 'cerebras', model: 'example-model', via: 'daemon', outcome: 'cleaned', attempts: 1, providerMs: 290, totalMs: 520 } })],
    ['Done, thanks.', undefined],
  ];
  [...rows].reverse().forEach(([text, tl], index) => {
    log.add({ at: startedAt - (rows.length - index) * 60_000, engine: 'parakeet', raw: text.toLowerCase(), cleaned: text, prompt: 'polish', outcome: 'inserted', durationMs: 6_200, ...(tl === undefined ? {} : { timeline: tl }) });
  });
  createRoot(root).render(
    <div style={{ margin: '0 auto', maxWidth: 760, padding: 16 }}>
      <TranscriptionLogSettings log={log} debug={null} />
    </div>,
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/timing-entry.js"></script></body>
</html>`;

mkdirSync(bundleDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(bundleDir, 'timing-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(bundleDir, 'timing-entry.tsx'), '--outdir', bundleDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(bundleDir, 'app.css'),
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
    return new Response(Bun.file(join(bundleDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 900, mobile: true },
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
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        for (const view of ['log', 'sheet'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${view}`);
          if (view === 'log') await page.locator('[data-timing-summary]').waitFor({ state: 'visible' });
          else await page.locator('[data-debug-section="Timeline"]').waitFor({ state: 'visible' });
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (sideways > 0) fail(`${scheme} ${viewport.name} ${view} scrolls sideways by ${sideways}px`);
          const target = join(outDir, `dictation-timing-${view}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
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
