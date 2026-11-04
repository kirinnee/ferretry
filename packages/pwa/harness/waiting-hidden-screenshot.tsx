/**
 * Screenshots of waiting messages hidden from the chat (F955), at phone 390 and desktop 1280, in the light
 * and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/waiting-hidden-screenshot.tsx [outDir]     # default harness/out/waiting-*.png
 *
 * Views: `chat` (the REAL `TranscriptRow` over `hideWaiting`: a delivered message and a failed one are
 * drawn, a queued one, a held ferret note and one saved on this device are not) and `queue` (the REAL
 * `QueuePageView` for the same ferret, where those three are, with their send times).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
const shotDir = process.argv[2] === undefined ? outDir : resolve(process.argv[2]);

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
import { QueuePageView } from '../../src/components/queue-page.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { QueueActionsContext } from '../../src/components/queue-actions-context.tsx';
import { outboxRowOf, queueRowOf } from '../../src/lib/queue-view.ts';
import { hideWaiting } from '../../src/lib/waiting-fold.ts';

const view = new URLSearchParams(location.search).get('view') ?? 'chat';
const NOW = Date.parse('2026-10-30T02:00:00.000Z');
const at = '2026-10-30T01:49:00.000Z';
const base = { acceptedAt: '2026-10-30T01:45:00.000Z', attachmentIds: [] as string[] };
const queue = (state: string, extra: object = {}) => ({ queue: { state, stateAt: at, revision: 1, ...extra } });

const records: Record<string, object> = {
  delivered: { fate: 'delivered', ...queue('read') },
  failed: { fate: 'timed_out', retryable: true, ...queue('failed', { failure: 'it never reached the ferret' }) },
  queued: { fate: 'accepted', ...queue('queued', { waitReason: 'busy' }) },
  held: { fate: 'accepted', from: 'tomi', fromName: 'tomi', ...queue('queued') },
  saved: {
    fate: 'accepted',
    queue: { state: 'queued', stateAt: at, revision: 0 },
    outbox: { reason: 'waiting for connection', position: 1, of: 1 },
  },
};
const texts: Record<string, string> = {
  delivered: 'This one reached the ferret and was read',
  failed: 'This one failed, so it stays in the chat',
  queued: 'Queued on the machine: hidden here',
  held: 'A ferret’s held note: hidden here',
  saved: 'Saved on this device only: hidden here',
};
const all = Object.keys(records).map(key => {
  const record = { ...base, sendId: key, message: texts[key], ...records[key] };
  return key === 'delivered'
    ? ({ id: 'send:' + key, kind: 'user', text: texts[key], send: record } as never)
    : ({ id: 'send:' + key, kind: 'ledger', text: texts[key], ledger: record, placement: 'chronological' } as never);
});
const shown = hideWaiting(all);

const message = (id: string, text: string, extra: object = {}) => ({
  v: 1, id, sender: 'human', text, attachmentIds: [], state: 'queued', stateAt: at, revision: 1, enqueuedAt: at, ...extra,
});
const rows = [
  queueRowOf('laptop', 's1', 'Casen', message('q1', texts.queued as string, { waitReason: 'busy' }) as never),
  queueRowOf('laptop', 's1', 'Casen', message('q2', texts.held as string, {
    sender: 'ferret', by: { kind: 'ferret', name: 'tomi' }, label: 'fyi', holdUntil: '2026-10-30T02:20:00.000Z',
  }) as never),
  queueRowOf('laptop', 's1', 'Casen', message('q3', 'A second held note', {
    sender: 'ferret', by: { kind: 'ferret', name: 'avary' }, label: 'action', holdUntil: '2026-10-30T02:08:00.000Z',
  }) as never),
  outboxRowOf('Casen', {
    id: 'o1', daemonId: 'laptop', sessionId: 's1', message: texts.saved as string, attachmentIds: [], files: [],
    now: false, createdAt: '2026-10-30T01:50:00.000Z', seq: 1,
  }),
];
const casen = { key: 'laptop/s1', daemonId: 'laptop', machine: 'Laptop', sessionId: 's1', ferret: 'Casen', rows };
const handlers = { edit: async () => undefined, cancel: async () => undefined };
const inert = async () => true;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  view === 'chat' ? (
    <QueueActionsContext.Provider value={{ edit: async () => true, cancel: async () => true }}>
      <main data-marks="" style={{ margin: '0 auto', maxWidth: 560, padding: '12px 16px' }}>
        <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
          <div className="fy-transcript-content">
            {shown.map((e: any, i: number) => (
              <TranscriptRow answered={false} entry={e} key={e.id} onCancel={inert} onRetry={inert} onSubmit={inert} previous={shown[i - 1]} />
            ))}
          </div>
        </div>
      </main>
    </QueueActionsContext.Provider>
  ) : (
    <div data-marks="" style={{ display: 'flex', height: '100vh' }}>
      <QueuePageView groups={[casen]} handlers={handlers} loading={false} now={NOW} onOpenFerret={() => undefined} onShowAll={() => undefined} showMachine={false} title="Queue — Casen" />
    </div>
  ),
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/waiting-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });
await Bun.write(join(outDir, 'waiting-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'waiting-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
      { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true },
      { name: 'desktop', viewport: { width: 1280, height: 900 }, isMobile: false },
    ] as const) {
      const context = await browser.newContext({
        viewport: device.viewport,
        deviceScaleFactor: 2,
        isMobile: device.isMobile,
        hasTouch: device.isMobile,
        timezoneId: 'Asia/Tokyo',
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        for (const view of ['chat', 'queue'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${view}`);
          await page.locator('[data-marks]').waitFor({ state: 'visible' });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${view} ${device.name} ${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotDir, `waiting-${view}-${device.name}-${scheme}.png`);
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
