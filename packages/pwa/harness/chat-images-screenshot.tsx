/**
 * Screenshots of pictures in the chat: a screenshot a tool returned (one collapsed row at rest, the
 * picture behind its chevron — `-open` scenes), an image a ferret shared, a photo
 * the owner attached from the composer, an image the daemon can no longer read, and the full-screen
 * viewer open on one. Phone (390) and desktop (1440), the light and dark studio themes. Review evidence;
 * nothing compares the PNGs.
 *
 *   bun harness/chat-images-screenshot.tsx    # writes harness/out/<light|dark>/<scene>-<phone|desktop>.png
 *
 * It renders the REAL `TranscriptRow` over entries projected from a fake daemon log by
 * `transcriptEntriesFromLog`, inside the real `HandoffSourceProvider` and `AttachmentGalleryProvider`.
 * The daemon is faked in the page: its loader draws each picture on a canvas, so no network is used.
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
import { turnFileInstruction } from '@ferretry/protocol';
import { AttachmentGalleryProvider } from '../../src/components/attachment-gallery.tsx';
import { HandoffSourceProvider } from '../../src/components/handoff-message.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { withAgentName } from '../../src/components/transcript.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';

const STATE = '/home/kirin/.ferretry/state/sessions/ms0v8vgc-d445a669/turns';
const SHOT = '[fy-image 4096.3145728.0 image/png]';
const CHART = '[fy-image 9000.2048.0 image/png]';
const GONE = '[fy-image 777.1024.0 image/png]';

interface Scene {
  readonly log: string;
  readonly answered: readonly number[];
}

const SCENES: Record<string, Scene> = {
  'ferret-tool-screenshot': {
    answered: [0],
    log: [
      '[10:02:00] user/message: Can you check the checkout page after your change?',
      '[10:02:20] assistant/tool-call: mcp__playwright__browser_take_screenshot({"filename":"checkout.png"})',
      '[10:02:24] tool/tool-result: Took a screenshot of the viewport',
      '    ' + SHOT,
      '[10:02:31] assistant/message: The **Pay** button now clears the keyboard and the total stays in view.',
    ].join('\\n'),
  },
  'ferret-attachment': {
    answered: [0],
    log: [
      '[10:05:00] user/message: Plot last week’s p95 latency for me',
      '[10:05:40] assistant/message: Here is the chart. The spike on Thursday is the deploy.',
      '[10:05:41] assistant/attachment: image ' + CHART,
    ].join('\\n'),
  },
  'owner-photo': {
    answered: [0],
    log: [
      '[10:08:10] user/message: ' + turnFileInstruction(STATE + '/turn-008.md'),
      '[10:08:44] assistant/message: Thanks — the photo shows the **Continue** button under the keyboard. Fixing the inset now.',
    ].join('\\n'),
  },
  'image-error': {
    answered: [],
    log: [
      '[10:12:00] assistant/message: Earlier I attached the failing run. It has since been pruned from the transcript.',
      '[10:12:01] assistant/attachment: image ' + GONE,
    ].join('\\n'),
  },
};
SCENES['ferret-tool-screenshot-open'] = SCENES['ferret-tool-screenshot'] as Scene;
SCENES['read-image'] = {
  answered: [0],
  log: [
    '[10:20:00] user/message: Here is the checkout screenshot, can you look?',
    '[10:20:10] assistant/tool-call: Read({"file_path":"/tmp/image.png"})',
    '[10:20:11] tool/tool-result: ',
    '    ' + SHOT,
    '[10:20:20] assistant/message: I see it — the **Pay** button sits under the keyboard.',
  ].join('\\n'),
};
SCENES['read-image-open'] = SCENES['read-image'] as Scene;
SCENES['viewer'] = SCENES['ferret-tool-screenshot'] as Scene;

const HANDOFF = {
  name: 'turn-008',
  message: 'Is this one legit?\\n\\nOn my phone the **Continue** button is hidden behind the keyboard.',
  attachments: [{ attachmentId: 'att_1', filename: 'onboarding.png', mime: 'image/png' }],
};

const canvasPng = async (width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): Promise<Blob> => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  paint(ctx);
  return await new Promise<Blob>((done, refuse) =>
    canvas.toBlob(blob => (blob === null ? refuse(new Error('no PNG')) : done(blob)), 'image/png'),
  );
};

const checkout = (): Promise<Blob> =>
  canvasPng(1280, 800, ctx => {
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, 1280, 800);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 1280, 64);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 24px sans-serif';
    ctx.fillText('Shop / Checkout', 32, 40);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#cbd5e1';
    for (const y of [112, 232, 352]) {
      ctx.fillRect(160, y, 640, 96);
      ctx.strokeRect(160, y, 640, 96);
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(184, y + 20, 56, 56);
      ctx.fillStyle = '#0f172a';
      ctx.font = '20px sans-serif';
      ctx.fillText('Item ' + (y / 120 | 0), 264, y + 40);
      ctx.fillStyle = '#ffffff';
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(840, 112, 280, 336);
    ctx.strokeRect(840, 112, 280, 336);
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 22px sans-serif';
    ctx.fillText('Total  $128.00', 864, 168);
    ctx.fillStyle = '#6366f1';
    ctx.fillRect(864, 384, 232, 48);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 20px sans-serif';
    ctx.fillText('Pay', 954, 415);
  });

const chart = (): Promise<Blob> =>
  canvasPng(900, 520, ctx => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 520);
    ctx.strokeStyle = '#e2e8f0';
    for (let y = 60; y < 460; y += 80) {
      ctx.beginPath();
      ctx.moveTo(60, y);
      ctx.lineTo(860, y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 4;
    ctx.beginPath();
    const points = [300, 280, 310, 270, 120, 260, 290];
    points.forEach((value, index) => ctx[index === 0 ? 'moveTo' : 'lineTo'](60 + index * 133, value + 60));
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 22px sans-serif';
    ctx.fillText('p95 latency (ms), last 7 days', 60, 36);
    ctx.font = '16px sans-serif';
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((day, index) => ctx.fillText(day, 50 + index * 133, 500));
  });

const phone = (): Promise<Blob> =>
  canvasPng(390, 844, ctx => {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 390, 844);
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(24, 96, 342, 56);
    ctx.fillStyle = '#334155';
    ctx.fillRect(24, 180, 342, 48);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '18px sans-serif';
    ctx.fillText('Name', 40, 210);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(0, 520, 390, 324);
    ctx.fillStyle = '#0f172a';
    ctx.font = '22px sans-serif';
    ctx.fillText('keyboard', 140, 690);
    ctx.fillStyle = 'rgba(99,102,241,0.35)';
    ctx.fillRect(24, 560, 342, 52);
  });

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'harness' });
const source = {
  daemon,
  sessionId: 'ms0v8vgc-d445a669',
  read: async (name: string) => {
    if (name === 'turn-008') return HANDOFF;
    throw new Error('no hand-off document ' + name);
  },
};

const load = async (_daemon: unknown, scope: { attachmentId: string }): Promise<Blob> => {
  if (scope.attachmentId === 'att_1') return await phone();
  if (scope.attachmentId.endsWith('4096.3145728.0')) return await checkout();
  if (scope.attachmentId.endsWith('9000.2048.0')) return await chart();
  throw new DaemonResponseError(404, '/home/kirin/secret/transcript.jsonl');
};

const params = new URLSearchParams(location.search);
const sceneName = params.get('scene') ?? 'ferret-tool-screenshot';
const scene = SCENES[sceneName] ?? SCENES['ferret-tool-screenshot']!;
const now = Date.UTC(2026, 9, 18, 3, 0, 0);
const base = { acceptedAt: '2026-10-18T01:45:00.000Z', attachmentIds: ['att_1'], fate: 'delivered' };
const entries: TranscriptEntry[] = transcriptEntriesFromLog(scene.log, now).map((entry, index) => {
  const named = withAgentName(entry, 'Janella');
  return sceneName === 'owner-photo' && index === 0
    ? ({ ...named, send: { ...base, sendId: 's8', message: HANDOFF.message, turn: 8 } } as TranscriptEntry)
    : named;
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <AttachmentGalleryProvider load={load as never}>
    <HandoffSourceProvider source={source}>
      <main style={{ margin: '0 auto', maxWidth: 760, padding: '12px 16px' }}>
        <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
          <div className="fy-transcript-content" data-chat-images="">
            {entries.map((entry, index) => (
              <TranscriptRow
                answered={scene.answered.includes(index)}
                entry={entry}
                key={entry.id}
                previous={entries[index - 1]}
              />
            ))}
          </div>
        </div>
      </main>
    </HandoffSourceProvider>
  </AttachmentGalleryProvider>,
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/chat-images-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'chat-images-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'chat-images-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
] as const;
const SCENE_NAMES = [
  'ferret-tool-screenshot',
  'ferret-tool-screenshot-open',
  'read-image',
  'read-image-open',
  'ferret-attachment',
  'owner-photo',
  'image-error',
  'viewer',
] as const;
const COLLAPSED_SCENES: readonly string[] = ['ferret-tool-screenshot', 'read-image'];
const OPENED_SCENES: readonly string[] = ['ferret-tool-screenshot-open', 'read-image-open', 'viewer'];

try {
  for (const scheme of ['light', 'dark'] as const) {
    mkdirSync(join(outDir, scheme), { recursive: true });
    for (const viewport of VIEWPORTS) {
      for (const scene of SCENE_NAMES) {
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
          await page.locator('[data-chat-images]').waitFor({ state: 'visible' });
          if (COLLAPSED_SCENES.includes(scene)) {
            await page.locator('.kt-chrome button').first().waitFor({ state: 'visible' });
            await page.waitForTimeout(300);
            const drawn = await page.locator('img, [data-transcript-image-state]').count();
            if (drawn > 0) fail(`${scheme} ${viewport.name} ${scene} draws a picture before it is opened`);
          } else {
            if (OPENED_SCENES.includes(scene)) await page.locator('.kt-chrome button').first().click();
            const settled = scene === 'image-error' ? 'failed' : 'loaded';
            await page.locator(`[data-transcript-image-state="${settled}"], .fy-handoff img`).first().waitFor({
              state: 'visible',
            });
          }
          if (scene === 'owner-photo')
            await page.locator('[data-handoff-state="read"] img').waitFor({ state: 'visible' });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scheme} ${viewport.name} ${scene} scrolls sideways by ${overflow}px`);
          const target = join(outDir, scheme, `${scene}-${viewport.name}.png`);
          if (scene === 'viewer') {
            await page.locator('[aria-label^="Expand"]').first().click();
            await page.locator('dialog[open]').waitFor({ state: 'visible' });
            await page.screenshot({ path: target });
          } else {
            await page.screenshot({ path: target, fullPage: true });
          }
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
