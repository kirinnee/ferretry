/**
 * Screenshots of the shared draft (&F331): the REAL `Composer`, kept in step with another of the owner's
 * devices, at phone 390 and desktop 1280, in the light and dark studio themes. Review evidence; nothing
 * compares the PNGs.
 *
 *   bun harness/shared-draft-screenshot.tsx   # writes harness/out/shared-draft-<scene>-<phone|desktop>-<scheme>.png
 *
 * Scenes:
 * - `typing` — the other device is typing: the "also typing on <device>" hint, and its sentence arriving
 *   in this composer while this one's own words stay put.
 * - `conflict` — this device held words the daemon's draft did not: the daemon's draft is shown, and the
 *   person is offered theirs back ("Restore them").
 * - `files` — another device attached a screenshot and a PDF (their chips, the picture drawn from the
 *   daemon's copy) and is still uploading a third (a placeholder nobody here can remove).
 *
 * The daemon is faked IN THE PAGE: its stream answers with a snapshot, the other device's presence and
 * one edit, exactly in the frames `shared-draft.ts` defines. No network is used.
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
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'typing';
const other = params.get('other') ?? 'Kirin’s iPhone';
const at = '2026-11-01T06:00:00.000Z';
const theirs = 'Keep the 5 minute grace window, but log every reuse.';
const arriving = '\\nScreenshot attached shows the 401 on refresh';

class Memory {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const machine = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'device' });
const drafts = new DaemonDraftStore(new Memory());
if (scene === 'conflict') drafts.save(daemonSessionScope(machine, 's1'), 'Also check the refresh token expiry on Safari', 1);

const files = scene === 'files'
  ? [
      { kind: 'attachment', id: 'att_shot', name: 'login-error.png', mime: 'image/png', bytes: 412_000 },
      { kind: 'attachment', id: 'att_pdf', name: 'auth-flow.pdf', mime: 'application/pdf', bytes: 1_200_000 },
    ]
  : [];

/** The daemon's copy of the screenshot: drawn here, so no network is used. */
const screenshot = (): string => {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const paint = canvas.getContext('2d');
  if (paint !== null) {
    const fill = paint.createLinearGradient(0, 0, 96, 96);
    fill.addColorStop(0, '#7c8cf8');
    fill.addColorStop(0.55, '#c084fc');
    fill.addColorStop(1, '#f9a8d4');
    paint.fillStyle = fill;
    paint.fillRect(0, 0, 96, 96);
    paint.fillStyle = '#ffffff';
    paint.font = 'bold 22px sans-serif';
    paint.fillText('401', 26, 56);
  }
  return canvas.toDataURL('image/png').split(',')[1] as string;
};
const fetcher = async (input: RequestInfo | URL) => {
  const id = String(input).split('/').at(-1);
  return Response.json({
    attachment: { id, filename: 'login-error.png', mime: 'image/png', size: 412000, sha256: 'a'.repeat(64), createdAt: at },
    base64: screenshot(),
  });
};

const open = async (_daemon: unknown, request: { onData: (frame: { kind: 'text'; text: string }) => void }) => {
  const down = (frame: object, after = 0) =>
    setTimeout(() => request.onData({ kind: 'text', text: JSON.stringify(frame) }), after);
  down({ kind: 'snapshot', snapshot: { v: 1, sessionId: 's1', generation: 'g', epoch: 0, rev: 1, text: theirs, items: files, updatedAt: at } });
  down({ kind: 'ready' });
  if (scene === 'files') down({ kind: 'presence', peer: 'other', device: other, typing: false, uploading: ['network-trace.png'] }, 10);
  if (scene === 'typing') {
    down({ kind: 'presence', peer: 'other', device: other, typing: true }, 10);
    down({
      kind: 'edit',
      applied: { generation: 'g', epoch: 0, rev: 2, text: [theirs.length, arriving], add: [], remove: [] },
      epoch: 0,
      rev: 2,
    }, 40);
  }
  return { sendStream() {}, closeStream() {}, onStreamClosed() {} } as never;
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-shared-draft="" style={{ margin: '0 auto', maxWidth: 760, padding: '24px 12px' }}>
    <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible', marginBottom: 16 }}>
      <p className="text-muted" style={{ fontSize: 13, margin: '0 4px 12px' }}>
        Tokens now rotate on refresh. Keep the old session cookie for the 5 minute grace window?
      </p>
    </div>
    <Composer
      api={{ send: async () => ({}) } as never}
      autocompleteFetcher={fetcher as never}
      daemon={machine}
      draftStore={drafts}
      openDraftStream={open as never}
      sessionId="s1"
    />
  </main>,
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/shared-draft-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'shared-draft-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'shared-draft-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const device of [
      // The phone shows the laptop typing, and the laptop shows the phone.
      { name: 'phone', other: 'Desktop (Chrome)', viewport: { width: 390, height: 640 }, isMobile: true },
      { name: 'desktop', other: 'Kirin’s iPhone', viewport: { width: 1280, height: 520 }, isMobile: false },
    ] as const) {
      const context = await browser.newContext({
        viewport: device.viewport,
        deviceScaleFactor: 2,
        isMobile: device.isMobile,
        hasTouch: device.isMobile,
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        for (const scene of ['typing', 'conflict', 'files'] as const) {
          const other = encodeURIComponent(device.other);
          await page.goto(`${server.url}?theme=studio-${scheme}&scene=${scene}&other=${other}`);
          await page.locator('[data-shared-draft]').waitFor({ state: 'visible' });
          if (scene === 'typing') {
            await page.locator('[data-composer-presence]').waitFor({ state: 'visible' });
            await page.waitForFunction(() =>
              (document.querySelector('textarea')?.value ?? document.body.innerText).includes('401 on refresh'),
            );
          } else if (scene === 'conflict') await page.locator('[data-composer-conflict]').waitFor({ state: 'visible' });
          else {
            await page.getByText(`uploading on ${device.other}`).waitFor({ state: 'visible' });
            await page.locator('img[src^="blob:"]').first().waitFor({ state: 'visible' });
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scene} ${device.name} ${scheme} scrolls sideways by ${overflow}px`);
          const target = join(outDir, `shared-draft-${scene}-${device.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
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
