/**
 * Screenshots of a conversation with a message in every state that can be stuck, and the way out of each:
 * sending (with its guarded "Retry…" open), queued, typed into the composer but not sent (Press Enter),
 * two cancelled messages that say what the cancel did, and one that timed out — plus the "Clear stuck
 * messages" confirm in the Actions menu. Desktop 1440 and phone 390, light and dark studio themes.
 * Review evidence only; nothing compares the PNGs.
 *
 *   bun harness/stuck-messages-screenshot.tsx   # writes harness/out/stuck-messages-*.png
 *
 * It renders the REAL `TranscriptRow` (so `LedgerMessage`) and `ActionsMenu` over the real registry
 * entry, with fake message text only. On the phone it also asserts every action is at least 44px high.
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
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { ActionsMenu } from '../../src/features/session-actions/actions-menu.tsx';
import { sessionActionSections } from '../../src/features/session-actions/registry.ts';
import { clearStuckMessagesContribution, stuckSends } from '../../src/features/stuck-messages/use-stuck-message-actions.tsx';

const at = (minute: number): string => '2026-10-19T07:' + String(minute).padStart(2, '0') + ':00.000Z';
const base = { attachmentIds: [] };
const sends: LedgerSendRecord[] = [
  { ...base, sendId: 'cancelled-cleared', acceptedAt: at(1), fate: 'cancelled', cancelEffect: 'cleared', message: 'rename the staging bucket to match the new naming scheme' },
  { ...base, sendId: 'cancelled-queue', acceptedAt: at(2), fate: 'cancelled', cancelEffect: 'left_in_queue', message: 'also bump the retry budget to five attempts' },
  { ...base, sendId: 'timed-out', acceptedAt: at(3), fate: 'timed_out', retryable: true, unaccountedReason: 'not_delivered', attempt: 2, message: 'summarise the failing checks on the open branch' },
  { ...base, sendId: 'typed', acceptedAt: at(4), fate: 'accepted', typedNotSent: true, message: 'continue with the second half of the plan, keeping the tests green' },
  { ...base, sendId: 'queued', acceptedAt: at(5), fate: 'queued', message: 'after that, tidy the changelog entry' },
  { ...base, sendId: 'sending', acceptedAt: at(6), fate: 'accepted', message: 'one more thing: please double-check the migration order' },
];
const entries: TranscriptEntry[] = sends.map((record): TranscriptEntry => ({ id: 'ledger:' + record.sendId, kind: 'ledger', text: record.message, ledger: record, placement: 'chronological' }));
const compact = new URLSearchParams(location.search).get('compact') === '1';
const stuck = stuckSends(sends, Date.parse('2026-10-19T07:30:00.000Z'));
const sections = sessionActionSections([clearStuckMessagesContribution(stuck, async () => undefined)], { canControl: true });

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-stuck-scene="" style={{ margin: '0 auto', maxWidth: 760, padding: '12px 0' }}>
    <header style={{ alignItems: 'flex-start', display: 'flex', gap: 12, height: compact ? 300 : 190, justifyContent: 'space-between', padding: '0 16px' }}>
      <strong>Hadi · staging cleanup</strong>
      <ActionsMenu compact={compact} form={null} name="Hadi" onFormChange={() => undefined} sections={sections} />
    </header>
    <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible', padding: '12px 16px' }}>
      <div className="fy-transcript-content">
        {entries.map((entry, index) => (
          <TranscriptRow
            entry={entry}
            key={entry.id}
            onCancel={async () => true}
            onRetry={async () => true}
            onSubmit={async () => true}
            previous={entries[index - 1]}
            isLast={index === entries.length - 1}
          />
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/stuck-messages-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'stuck-messages-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'stuck-messages-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true },
] as const;

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const { name, viewport, mobile } of VIEWPORTS) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 2,
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: scheme,
        reducedMotion: 'reduce',
        ...(mobile
          ? {
              userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            }
          : {}),
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}&compact=${mobile ? 1 : 0}`);
        await page.locator('[data-stuck-scene]').waitFor({ state: 'visible' });
        // The guarded retry for the message that is still sending, and what each cancel did.
        await page.locator('[data-ledger-action="retry-open"]').first().click();
        for (const receipt of await page.locator('[data-send-fate="cancelled"]').all()) await receipt.click();
        if (mobile) {
          const short = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('[data-ledger-action]')]
              .map(button => ({ action: button.dataset.ledgerAction, height: button.getBoundingClientRect().height }))
              .filter(button => button.height < 44),
          );
          if (short.length > 0) fail(`${name} ${scheme}: actions under 44px: ${JSON.stringify(short)}`);
        }
        // The menu closes on any resize, which a full-page capture performs; so size the viewport to the
        // page first and capture it as it stands.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width: viewport.width, height });
        await page.locator('[data-session-actions-trigger]').click();
        await page.locator('[data-session-action-item="clear-stuck-messages"]').click();
        await page.locator('[data-menu-confirm="clear-stuck-messages"]').waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${name} ${scheme} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `stuck-messages-${name}-${scheme}.png`);
        await page.screenshot({ path: target });
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
