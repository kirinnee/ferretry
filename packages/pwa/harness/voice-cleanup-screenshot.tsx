/**
 * Screenshots of Settings › Dictation › Cleanup style (the prompt editor and the conversation-context
 * switch) at a 390px phone and a 1440px desktop, in the light and dark studio themes. Review evidence
 * for dictation cleanup; nothing compares the PNGs.
 *
 *   bun harness/voice-cleanup-screenshot.tsx          # writes harness/out/voice-cleanup-*.png
 *
 * It renders the REAL `DictationSettings` with Groq selected and the machine's cleanup settings injected,
 * so nothing reaches a daemon. Like `screenshot.ts` it drives the system Chrome through playwright-core
 * and aborts every request off the loopback origin.
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
import { DictationSettings } from '../../src/features/settings/dictation-settings.tsx';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
const state = new URLSearchParams(location.search).get('state');
const cleanup = state === 'edited'
  ? {
      style: 'polish',
      prompts: { polish: 'Rewrite this into short, plain sentences. Keep every name exactly as spoken. Same meaning, nothing added.' },
      useConversation: true,
      conversationMessages: 6,
    }
  : { style: 'fix', prompts: {}, useConversation: false, conversationMessages: 8 };
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex flex-col bg-bg p-4" style={{ maxWidth: 720, margin: '0 auto' }}>
    <DictationSettings
      settings={{ ...DEFAULT_STT_SETTINGS, enhancementProvider: 'groq', engine: 'browser' }}
      update={() => undefined}
      persisted
      recognitionSupport={{ available: true, availability: 'available', implementation: 'standard' }}
      voice={null}
      voiceCleanup={{ cleanup, loaded: true, save: async () => ({ kind: 'applied' }) }}
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/voice-cleanup-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'voice-cleanup-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'voice-cleanup-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
  { name: 'mobile', width: 390, height: 2_400 },
  { name: 'desktop', width: 1_440, height: 2_400 },
] as const;

const shotsDir = process.env.VOICE_CLEANUP_SHOTS ?? outDir;
mkdirSync(shotsDir, { recursive: true });
const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        for (const state of ['default', 'edited'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          const section = page.locator('[data-voice-cleanup]');
          await section.waitFor({ state: 'visible' });
          // A control wider than a phone would hide its own last words off-screen.
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${state} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `voice-cleanup-${state}-${viewport.name}-${scheme}.png`);
          const box = await section.boundingBox();
          if (box === null) fail(`${state} at ${viewport.name}/${scheme} has no box`);
          const { x, y, width, height } = box ?? { x: 0, y: 0, width: 0, height: 0 };
          await page.screenshot({
            path: target,
            clip: { x: Math.max(0, x - 16), y: Math.max(0, y - 16), width: width + 32, height: height + 32 },
          });
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
