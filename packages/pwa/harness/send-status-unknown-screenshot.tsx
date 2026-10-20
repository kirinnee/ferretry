/**
 * Screenshots of a message whose ledger this browser can no longer read: the receipt says
 * "status unknown" with since-when and why, instead of "Sending" for as long as anyone looks. Desktop
 * 1440 and phone 390, light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/send-status-unknown-screenshot.tsx   # writes harness/out/send-status-unknown-*.png
 *
 * It renders the REAL `TranscriptRow` over entries projected from a daemon log by
 * `transcriptEntriesFromLog`, with the unread rows built by the real `markLedgerUnread`.
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
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { withAgentName } from '../../src/components/transcript.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { markLedgerUnread, LEDGER_UNREAD_GRACE_MS, type LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';

const LOG = [
  '[03:26:50] user/message: Run the migration on staging',
  '[03:27:05] assistant/message: Done — 14 tables migrated, no data loss.',
  '[03:27:37] user/message: hi',
  '[03:28:02] user/message: hello',
].join('\\n');

const now = Date.UTC(2026, 9, 20, 3, 33, 0);
const rows: LedgerSendRecord[] = [
  { sendId: 's0', acceptedAt: '2026-10-20T03:26:50.000Z', message: 'Run the migration on staging', attachmentIds: [], fate: 'delivered' },
  { sendId: 's2', acceptedAt: '2026-10-20T03:27:37.000Z', message: 'hi', attachmentIds: [], fate: 'accepted' },
  { sendId: 's3', acceptedAt: '2026-10-20T03:28:02.000Z', message: 'hello', attachmentIds: [], fate: 'queued' },
];
const unread = markLedgerUnread(rows, {
  reason: 'fyd did not answer /v1/sessions/fy_s_zarah/sends within 20s; it may still have applied the request',
  lastReadAt: Date.UTC(2026, 9, 20, 3, 28, 10),
  nowMs: Date.UTC(2026, 9, 20, 3, 28, 10) + LEDGER_UNREAD_GRACE_MS,
});
const SENDS: Record<number, LedgerSendRecord | undefined> = { 0: unread[0], 2: unread[1], 3: unread[2] };

const entries: TranscriptEntry[] = transcriptEntriesFromLog(LOG, now).map((entry, index) => {
  const named = withAgentName(entry, 'Zarah');
  const send = SENDS[index];
  return send === undefined ? named : ({ ...named, send } as TranscriptEntry);
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px' }}>
    <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="fy-transcript-content" data-marks="">
        {entries.map((entry, index) => (
          <TranscriptRow answered={index === 0} entry={entry} key={entry.id} previous={entries[index - 1]} />
        ))}
      </div>
    </div>
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/send-status-unknown-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'send-status-unknown-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'send-status-unknown-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
] as const;

try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
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
        await page.locator('[data-marks]').waitFor({ state: 'visible' });
        // Open the reason on the "hi" row — the tap a phone reader makes.
        const unknown = page.locator('[data-send-receipt="unconfirmed"]').first();
        if ((await unknown.count()) === 0) fail('no status-unknown receipt rendered');
        await unknown.click();
        const chip = await page.locator('[data-send-chip="unconfirmed"]').first().textContent();
        if (chip?.trim() !== 'status unknown') fail(`chip reads ${JSON.stringify(chip)}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${viewport.name} ${scheme} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `send-status-unknown-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: target, fullPage: true });
        process.stdout.write(`📸 ${target}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
