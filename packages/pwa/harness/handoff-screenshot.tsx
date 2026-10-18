/**
 * Screenshots of a message the agent was handed through a TURN FILE: the reader's bubble shows what they
 * sent — Markdown and an attached image — instead of the "Read the file …/turn-008.md now, then carefully
 * follow every instruction inside it" pointer the transcript records. Phone (390) and desktop (1440), the
 * light and dark studio themes, plus the "via turn file" explanation opened and a hand-off whose file is
 * gone. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/handoff-screenshot.tsx            # writes harness/out/handoff-after-*.png
 *   bun harness/handoff-screenshot.tsx --before   # the same log as the old tree drew it: the raw pointer
 *
 * It renders the REAL `TranscriptRow` over entries projected from a real daemon log by
 * `transcriptEntriesFromLog`, inside the real `HandoffSourceProvider`, with the daemon's answer and the
 * attachment bytes faked in the page — no network.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
const BEFORE = process.argv.includes('--before');

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
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';

const STATE = '/home/kirin/.ferretry/state/sessions/ms0v8vgc-d445a669/turns';
const LOG = [
  '[01:44:02] user/message: Can you check the onboarding screen?',
  '[01:44:30] assistant/message: Sure — what looks wrong?',
  '[01:45:10] user/message: ' + turnFileInstruction(STATE + '/turn-008.md'),
  '[01:45:44] assistant/message: The **Continue** button sits under the keyboard at 390px. Fixing the inset now.',
  '[01:47:02] user/message: ' + turnFileInstruction(STATE + '/turn-006.md'),
].join('\\n');

const HANDOFF = {
  name: 'turn-008',
  message: 'Is this turn-based system legit?\\n\\nOn my phone the **Continue** button is hidden:\\n\\n- open onboarding\\n- tap the name field\\n- the keyboard covers the button',
  attachments: [{ attachmentId: 'att_1', filename: 'onboarding.png', mime: 'image/png' }],
};

const SCREEN = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">' +
  '<rect width="390" height="844" fill="#0f172a"/><rect x="24" y="96" width="342" height="56" rx="12" fill="#1e293b"/>' +
  '<rect x="24" y="180" width="342" height="48" rx="10" fill="#334155"/><text x="40" y="210" fill="#e2e8f0" font-family="sans-serif" font-size="18">Name</text>' +
  '<rect x="0" y="520" width="390" height="324" fill="#cbd5e1"/><text x="140" y="690" fill="#0f172a" font-family="sans-serif" font-size="22">keyboard</text>' +
  '<rect x="24" y="560" width="342" height="52" rx="12" fill="#6366f1" opacity="0.35"/></svg>';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'harness' });
const source = {
  daemon,
  sessionId: 'ms0v8vgc-d445a669',
  // turn-006's file has been removed: that row shows the pointer faded, with the explanation.
  read: async (name: string) => {
    if (name === 'turn-008') return HANDOFF;
    throw new Error('no hand-off document ' + name);
  },
};
// The gallery takes only a raster image type, so the mock screenshot is drawn to a PNG in the page.
const load = async (): Promise<Blob> => {
  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SCREEN);
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 390;
  canvas.height = 844;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
  return await new Promise<Blob>((done, refuse) =>
    canvas.toBlob(blob => (blob === null ? refuse(new Error('no PNG')) : done(blob)), 'image/png'),
  );
};

const now = Date.UTC(2026, 9, 18, 2, 0, 0);
const base = { acceptedAt: '2026-10-18T01:45:00.000Z', attachmentIds: ['att_1'], fate: 'delivered' };
const entries: TranscriptEntry[] = transcriptEntriesFromLog(LOG, now).map((entry, index) => {
  const named = withAgentName(entry, 'Janella');
  const plain = ${BEFORE ? '(() => { const { handoff: _dropped, ...rest } = named; return rest as TranscriptEntry; })()' : 'named'};
  return index === 2 ? ({ ...plain, send: { ...base, sendId: 's8', message: HANDOFF.message, turn: 8 } } as TranscriptEntry) : plain;
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <AttachmentGalleryProvider load={load}>
    <HandoffSourceProvider source={source}>
      <main style={{ margin: '0 auto', maxWidth: 760, padding: '12px 16px' }}>
        <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
          <div className="fy-transcript-content" data-handoffs="">
            {entries.map((entry, index) => (
              <TranscriptRow answered={index === 0 || index === 2} entry={entry} key={entry.id} previous={entries[index - 1]} />
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/handoff-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'handoff-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'handoff-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
const tag = BEFORE ? 'before' : 'after';
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
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('[data-handoffs]').waitFor({ state: 'visible' });
        if (!BEFORE) {
          await page.locator('[data-handoff-state="read"] img').waitFor({ state: 'visible' });
          await page.locator('[data-handoff-state="gone"]').waitFor({ state: 'visible' });
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `handoff-${tag}-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: target, fullPage: true });
        process.stdout.write(`📸 ${target}\n`);
        if (!BEFORE) {
          await page.locator('.fy-handoff-via-button').first().click();
          const explained = join(outDir, `handoff-explained-${viewport.name}-${scheme}.png`);
          await page.locator('[data-handoff-state="read"]').locator('xpath=ancestor::article').screenshot({
            path: explained,
          });
          process.stdout.write(`📸 ${explained}\n`);
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
