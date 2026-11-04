/**
 * Screenshots of a direct send the harness wrote twice (&B157): Claude Code 2.1.317 writes an UNTIMED copy
 * of each message before the real, timed record, and the chat drew both — a bare bubble with no time or
 * ticks above the ticked one. Phone 390 and desktop 1440, light and dark. Review evidence; nothing
 * compares the PNGs.
 *
 *   bun harness/double-bubble-screenshot.tsx [outDir] [tag]
 *
 * It renders the REAL `TranscriptRow` over entries projected by `transcriptEntriesFromLog` and placed by
 * `placeLedgerRows`, so the capture is what the reader sees. It fails if "moved" — sent once — is not
 * exactly one bubble, or if "ok" — sent twice on purpose — is not exactly two.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);
const tag = process.argv[3] ?? 'after';

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
import { placeLedgerRows } from '../../src/lib/ledger-placement.ts';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';

// The shape of the incident's log: each message the harness was given has an untimed copy first.
const LOG = [
  '[04:38:58] assistant/message: Move the card to Implement on the Board, then I close the item.',
  '[04:39:00] system/turn: completed',
  'user/message: moved',
  '[04:39:30] user/message: moved',
  '[04:39:33] assistant/tool-call: Bash({"command":"fy task show F1"})',
  '[04:39:34] tool/tool-result: lane Implement',
  '[04:39:40] assistant/message: Done. The card is in Implement and the item is closed.',
  'user/message: ok',
  '[04:40:10] user/message: ok',
  '[04:40:12] assistant/message: Noted.',
  'user/message: ok',
  '[04:40:20] user/message: ok',
  '[04:40:22] assistant/message: Noted again.',
].join('\\n');

const delivered = (sendId: string, message: string, acceptedAt: string, observedAt: string): LedgerSendRecord => ({
  sendId, message, acceptedAt, attachmentIds: [], path: 'direct', fate: 'delivered', fateAt: observedAt,
  evidence: { key: 'key-' + sendId, observedAt },
});
const SENDS = [
  delivered('moved', 'moved', '2026-11-04T04:39:30.495Z', '2026-11-04T04:39:30.653Z'),
  delivered('ok-1', 'ok', '2026-11-04T04:40:10.100Z', '2026-11-04T04:40:10.300Z'),
  delivered('ok-2', 'ok', '2026-11-04T04:40:20.100Z', '2026-11-04T04:40:20.300Z'),
];

const now = Date.parse('2026-11-04T04:41:00.000Z');
const entries = placeLedgerRows(transcriptEntriesFromLog(LOG, now), SENDS, now).map(entry => withAgentName(entry, 'Lizzette'));

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
const inert = async () => true;
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 760, padding: '12px 16px' }}>
    <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="fy-transcript-content" data-chat="">
        {entries.map((entry, index) => (
          <TranscriptRow entry={entry} key={entry.id} onCancel={inert} onRetry={inert} onSubmit={inert} previous={entries[index - 1]} />
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/double-bubble-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'double-bubble-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'double-bubble-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    // The stylesheet names its fonts as `../assets/fonts/…`: serve them from src, so the shots use the app's typefaces.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const device of [
      { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true },
      { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false },
    ] as const) {
      const context = await browser.newContext({
        viewport: device.viewport,
        deviceScaleFactor: 2,
        isMobile: device.isMobile,
        hasTouch: device.isMobile,
        timezoneId: 'America/Los_Angeles',
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
        await page.locator('[data-chat]').waitFor({ state: 'visible' });
        await page.evaluate(async () => await document.fonts.ready);
        const bubbles = await page.evaluate(() =>
          [...document.querySelectorAll('.fy-message-user p')].map(node => (node.textContent ?? '').trim()),
        );
        const moved = bubbles.filter(text => text === 'moved').length;
        const ok = bubbles.filter(text => text === 'ok').length;
        process.stdout.write(`${tag} ${device.name} ${scheme}: "moved" ×${moved}, "ok" ×${ok}\n`);
        if (tag === 'after' && (moved !== 1 || ok !== 2))
          fail(`expected "moved" once and "ok" twice, got ${moved} and ${ok}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${device.name} ${scheme} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `double-bubble-${tag}-${device.name}-${scheme}.png`);
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
