/**
 * Screenshots of the device outbox (tick 1) and the queue views, at phone 390 and desktop 1280, in the
 * light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/outbox-screenshot.tsx          # writes harness/out/outbox-*.png
 *
 * Views: `chat` (the four ticks, with a "waiting for connection" pair and the legend), `ferret` (one
 * ferret's queue), `all` (every queue on every machine). It renders the REAL `TranscriptRow`,
 * `QueuePageView` and `MessageMarksLegend`; the outbox rows are ledger rows carrying an `outbox` view,
 * exactly as `joinOutbox` makes them. A final shot opens an outbox message's ⋯ menu and its editor.
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
import { MessageMarksLegend } from '../../src/features/settings/message-marks-legend.tsx';
import { QueuePageView } from '../../src/components/queue-page.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { QueueActionsContext } from '../../src/components/queue-actions-context.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { outboxRowOf, queueRowOf } from '../../src/lib/queue-view.ts';

const view = new URLSearchParams(location.search).get('view') ?? 'chat';
const at = '2026-10-30T01:49:00.000Z';
const base = { acceptedAt: '2026-10-30T01:45:00.000Z', attachmentIds: [] as string[] };
const queue = (state: string, extra: object = {}) => ({ queue: { state, stateAt: at, revision: 1, ...extra } });
const outbox = (position: number, of: number, extra: object = {}) => ({
  fate: 'accepted',
  queue: { state: 'queued', stateAt: at, revision: 0 },
  outbox: { reason: 'waiting for connection', position, of, ...extra },
});

const LOG = [
  '[01:45:10] user/message: Saved on this device only, no signal yet',
  '[01:45:20] user/message: Also saved here, second in line',
  '[01:45:30] user/message: On the machine’s queue, waiting for its turn',
  '[01:45:40] user/message: Typed into the ferret',
  '[01:45:50] user/message: Read by the ferret',
].join('\\n');
const FATES: Record<number, object> = {
  0: outbox(1, 2),
  1: outbox(2, 2),
  2: { fate: 'accepted', ...queue('queued', { waitReason: 'busy' }) },
  3: { fate: 'delivered', ...queue('delivered') },
  4: { fate: 'delivered', ...queue('read') },
};
const WAITING = new Set([0, 1, 2]);
const entries = transcriptEntriesFromLog(LOG, Date.UTC(2026, 9, 30, 2, 0, 0)).map((entry, index) => {
  const record = { ...base, sendId: 's' + index, message: entry.text, ...FATES[index] };
  return (WAITING.has(index)
    ? { id: 'send:s' + index, kind: 'ledger', text: entry.text, ledger: record, placement: 'chronological' }
    : { ...entry, send: record }) as never;
});

const message = (id: string, text: string, extra: object = {}) => ({
  v: 1, id, sender: 'human', text, attachmentIds: [], state: 'queued', stateAt: at, revision: 1, enqueuedAt: at, ...extra,
});
const entry = (id: string, daemonId: string, sessionId: string, text: string, createdAt: string) => ({
  id, daemonId, sessionId, message: text, attachmentIds: [], files: [], now: false, createdAt, seq: 1,
});
const group = (key: string, machine: string, ferret: string, messages: any[], entries: any[]) => ({
  key, daemonId: key.split('/')[0] as string, machine, sessionId: key.split('/')[1] as string, ferret,
  rows: [...messages.map(m => queueRowOf(key.split('/')[0] as string, key.split('/')[1] as string, ferret, m)), ...entries.map(e => outboxRowOf(ferret, e))],
});
const casen = group('laptop/s1', 'Laptop', 'Casen',
  [message('q1', 'Please re-run CI', { waitReason: 'busy' }), message('q2', 'Typed already', { state: 'delivered' })],
  [entry('o1', 'laptop', 's1', 'thank you', '2026-10-30T01:50:00.000Z')]);
const mira = group('workshop/s2', 'Workshop', 'Mira',
  [message('q3', 'Review the board', { by: { kind: 'ferret', name: 'Sada' }, waitReason: 'draft' })], []);
const waiting = (g: any) => ({ ...g, rows: g.rows.filter((r: any) => r.state === 'saved' || r.state === 'queued') });
const handlers = { edit: async () => undefined, cancel: async () => undefined };
const inert = async () => true;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  view === 'chat' ? (
    <QueueActionsContext.Provider value={{ edit: async () => true, cancel: async () => true }}>
      <main style={{ margin: '0 auto', maxWidth: 560, padding: '12px 16px' }}>
        <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
          <div className="fy-transcript-content" data-marks="">
            {entries.map((e: any, i: number) => (
              <TranscriptRow answered={false} entry={e} key={e.id} onCancel={inert} onRetry={inert} onSubmit={inert} previous={entries[i - 1]} />
            ))}
          </div>
        </div>
        <section data-legend="" style={{ marginTop: 16 }}>
          <h2 className="text-ui font-semibold text-fg">Message marks</h2>
          <MessageMarksLegend />
        </section>
      </main>
    </QueueActionsContext.Provider>
  ) : view === 'ferret' ? (
    <div data-marks="" style={{ display: 'flex', height: '100vh' }}>
      <QueuePageView groups={[casen]} handlers={handlers} loading={false} onOpenFerret={() => undefined} onShowAll={() => undefined} showMachine={false} title="Queue — Casen" />
    </div>
  ) : (
    <div data-marks="" style={{ display: 'flex', height: '100vh' }}>
      <QueuePageView groups={[waiting(casen), waiting(mira)]} handlers={handlers} loading={false} onOpenFerret={() => undefined} showMachine title="All queues" />
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/outbox-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'outbox-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'outbox-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
        for (const view of ['chat', 'ferret', 'all'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${view}`);
          await page.locator('[data-marks]').waitFor({ state: 'visible' });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${view} ${device.name} ${scheme} scrolls sideways by ${overflow}px`);
          const target = join(outDir, `outbox-${view}-${device.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
          process.stdout.write(`📸 ${target}\n`);
          if (view === 'chat') {
            const more = page
              .getByText('Also saved here, second in line')
              .first()
              .locator('xpath=ancestor::*[.//*[@data-ledger-more]][1]')
              .locator('[data-ledger-more]')
              .first();
            await more.scrollIntoViewIfNeeded();
            await more.click();
            await page.getByRole('menuitem', { name: 'Edit' }).waitFor({ state: 'visible' });
            await page.getByRole('menuitem', { name: 'Cancel' }).first().waitFor({ state: 'visible' });
            await page.waitForTimeout(250);
            const menu = join(outDir, `outbox-menu-${device.name}-${scheme}.png`);
            await page.screenshot({ path: menu });
            process.stdout.write(`📸 ${menu}\n`);
            await page.getByRole('menuitem', { name: 'Edit' }).click();
            const editor = join(outDir, `outbox-edit-${device.name}-${scheme}.png`);
            await page.screenshot({ path: editor });
            process.stdout.write(`📸 ${editor}\n`);
          }
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
