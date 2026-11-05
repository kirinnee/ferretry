/**
 * Screenshots of READ ALOUD on an assistant message (F137 slice 1): idle, reading with the sentence
 * highlighted, stopped, and the remote-voice note. Phone (390) and desktop (1280), light and dark. Review
 * evidence; nothing compares the PNGs.
 *
 *   bun harness/read-aloud-screenshot.tsx             # writes <out>/<light|dark>/<scene>-<phone|desktop>[-partN].png
 *   FY_READ_ALOUD_SHOTS_DIR=/tmp/shots bun harness/read-aloud-screenshot.tsx
 *
 * It renders the REAL `TranscriptRow` (so the real markdown, the real Read aloud control and its captions)
 * with a controller over a FAKE speaker that makes no sound: the scene decides which sentence is "being
 * said". Everything on screen is invented text. A page taller than the viewport is cut into
 * viewport-high parts so every part can be read at full size.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = process.env.FY_READ_ALOUD_SHOTS_DIR ?? join(buildDir, 'read-aloud');

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
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import type { SpeakerEvent, SpeakerPort, SpeakerVoice } from '../../src/lib/voice-chat/ports.ts';
import { createReadAloud } from '../../src/lib/voice-chat/read-aloud.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'idle';

const LOCAL: SpeakerVoice = { id: 'local', name: 'Samantha', lang: 'en-US', local: true, isDefault: true };
const REMOTE: SpeakerVoice = { id: 'remote', name: 'Google US English', lang: 'en-US', local: false, isDefault: false };

// A speaker that makes no sound: it only reports the sentence the scene says is being read.
const quiet = (voices: readonly SpeakerVoice[], current: number): SpeakerPort => {
  let hear: ((event: SpeakerEvent) => void) | null = null;
  return {
    supported: true,
    voices: () => voices,
    unlock: () => undefined,
    speak: (_request, onEvent) => {
      hear = onEvent;
      onEvent({ type: 'segment', index: current });
    },
    stop: () => hear?.({ type: 'stopped' }),
  };
};

const controller = createReadAloud({
  speaker: quiet(scene === 'remote-voice' ? [REMOTE] : [LOCAL], scene === 'reading-late' ? 3 : 1),
  language: () => 'en-US',
});

const REPLY = [
  'I found the bug. The login form read the token before the page had finished loading, so the first tap did nothing.',
  '',
  'I made it wait for the page and queue the first tap, see \`login-form.tsx\`.',
  '',
  '\`\`\`ts',
  'await ready();',
  'submit(form);',
  '\`\`\`',
  '',
  'Run the tests next.',
].join('\\n');

const AT = Date.UTC(2026, 9, 18, 3, 0, 0);
const entries: TranscriptEntry[] = [
  { id: 'u1', kind: 'user', text: 'The login button needs two taps. Can you fix it?', at: AT - 120000 },
  { id: 'a1', kind: 'assistant', text: REPLY, label: 'Janella', at: AT },
];

function Driver() {
  useEffect(() => {
    if (scene !== 'idle') controller.read('a1', REPLY);
    if (scene === 'stopped') controller.stop();
    document.body.dataset.ready = '1';
  }, []);
  return null;
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <ReadAloudProvider controller={controller}>
    <Driver />
    <main style={{ margin: '0 auto', maxWidth: 760, padding: '12px 16px' }}>
      <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
        <div className="fy-transcript-content" data-read-aloud-scene="">
          {entries.map((entry, index) => (
            <TranscriptRow answered entry={entry} key={entry.id} previous={entries[index - 1]} />
          ))}
        </div>
      </div>
    </main>
  </ReadAloudProvider>,
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/read-aloud-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
await Bun.write(join(buildDir, 'read-aloud-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'read-aloud-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
const SCENES = ['idle', 'reading', 'reading-late', 'stopped', 'remote-voice'] as const;

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
          await page.locator('[data-read-aloud-scene] .fy-read-aloud-button').first().waitFor({ state: 'visible' });
          const expectCaptions = scene !== 'idle' && scene !== 'stopped';
          const captions = await page.locator('[data-read-captions]').count();
          if (expectCaptions !== (captions === 1))
            fail(`${scheme} ${viewport.name} ${scene}: captions shown = ${captions}`);
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
