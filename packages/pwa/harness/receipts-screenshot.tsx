/**
 * Screenshots of a transcript's message receipts and times on a phone: every send state, an agent's
 * reply, a peer's message and a notice, at 1×, 2× and 3× device pixel ratio, in the light and dark
 * studio themes, with the browser's timezone set to Asia/Tokyo — the owner's phone — and the daemon's
 * log printing UTC. Review evidence for the receipt marks; nothing compares the PNGs.
 *
 *   bun harness/receipts-screenshot.tsx            # writes harness/out/receipts-*.png
 *   bun harness/receipts-screenshot.tsx --before   # the same fixture without the legend, for the old tree
 *
 * It renders the REAL `TranscriptRow` over entries projected from a real daemon log by
 * `transcriptEntriesFromLog`, so the capture shows what the reader sees. It also sweeps every theme
 * family in both schemes and fails if a mark is below the 3:1 contrast WCAG asks of a graphic.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { THEME_FAMILIES } from '../src/lib/theme-preferences.ts';

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
${BEFORE ? '' : "import { MessageMarksLegend } from '../../src/features/settings/message-marks-legend.tsx';"}
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { QueueActionsContext } from '../../src/components/queue-actions-context.tsx';
import { withAgentName } from '../../src/components/transcript.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';

// The daemon prints UTC. 01:45 UTC is 10:45 in Tokyo, where the phone is.
const LOG = [
  '[01:45:10] user/message: Why is the build red?',
  '[01:45:44] assistant/message: Two tests time out on CI. The retry flag should stabilise them.',
  '[01:47:02] user/message: Try the retry flag',
  '[01:47:20] user/message: And re-run CI',
  '[01:47:31] user/message: Ping me when it is green',
  '[01:47:40] user/message: Is the cache warm?',
  '[01:47:55] user/message: Deploy to staging',
  '[01:48:03] user/message: <pasted_content id="p1">',
  '    [peer message from teammate torrey (session mvb0sw7d-27f71326) — not from the human lead]',
  '    No reply is required; torrey has carried on.',
  '    ',
  '    The staging deploy is queued behind mine.',
  '    </pasted_content id="p1">',
  '[01:48:30] user/message: [ferretry] Your message to aniya did not reach it.',
  '[01:49:00] user/message: Queued behind the running turn',
  '[01:49:05] user/message: Queued while its box holds a draft',
  '[01:49:10] user/message: Queued while a question is open',
  '[01:49:15] user/message: Being typed in right now',
  '[01:49:20] user/message: Typed and submitted',
  '[01:49:25] user/message: Read by the agent',
  '[01:49:30] user/message: The pane never came back',
  '[01:49:35] user/message: Taken back before it was typed',
  '[01:49:40] user/message: The session ended before the proof arrived',
  '[01:49:45] user/message: [ferretry] [board] Task F12 moved to review',
  '[01:49:50] user/message: [ferretry] [warden] A push to main was held for you',
  '[01:49:55] user/message: [re !A12 — Ship it?] yes, ship it',
  '[01:50:00] user/message: [message from ferret sada (session mvuzx42l-a9f7db82) — not from the owner]\\nNo reply needed. To reply: fy send sada "<reply>"\\n\\nthe build is green',
].join('\\n');

const base = { acceptedAt: '2026-10-18T01:45:00.000Z', attachmentIds: [] as string[] };
const FATES: Record<number, { fate: string; held?: boolean }> = {
  0: { fate: 'delivered' },
  2: { fate: 'delivered' },
  3: { fate: 'queued' },
  4: { fate: 'accepted' },
  5: { fate: 'unaccounted' },
  6: { fate: 'timed_out' },
};
const at = '2026-10-18T01:49:00.000Z';
const queue = (state: string, extra: object = {}) => ({ queue: { state, stateAt: at, revision: 1, ...extra } });
const QUEUED_FATES: Record<number, object> = {
  9: { fate: 'accepted', ...queue('queued', { waitReason: 'busy' }) },
  10: { fate: 'accepted', ...queue('queued', { waitReason: 'draft' }) },
  11: { fate: 'accepted', ...queue('queued', { waitReason: 'question' }) },
  12: { fate: 'accepted', ...queue('typing') },
  13: { fate: 'delivered', ...queue('delivered') },
  14: { fate: 'delivered', ...queue('read') },
  15: { fate: 'timed_out', ...queue('failed', { failure: 'the pane never came back' }) },
  16: { fate: 'cancelled', ...queue('cancelled') },
  17: { fate: 'timed_out', unaccountedReason: 'session_ended' },
  18: { fate: 'delivered', senderKind: 'daemon' },
  19: { fate: 'delivered', senderKind: 'daemon' },
  20: { fate: 'delivered' },
  21: { fate: 'delivered' },
};
Object.assign(FATES, QUEUED_FATES);
const ANSWERED = new Set([0]);

const now = Date.UTC(2026, 9, 18, 2, 0, 0);
// A message still waiting in the queue is not in the conversation yet: the app draws it as a ledger row,
// which is the row that carries the "⋯" menu (Edit / Cancel). These three are drawn exactly that way.
const WAITING = new Set([9, 10, 11]);
const entries: TranscriptEntry[] = transcriptEntriesFromLog(LOG, now).map((entry, index) => {
  const fate = FATES[index];
  const named = withAgentName(entry, 'Janella');
  if (fate === undefined) return named;
  const record = { ...base, sendId: 's' + index, message: entry.text, ...fate };
  return (WAITING.has(index)
    ? { id: 'send:s' + index, kind: 'ledger', text: entry.text, ledger: record, placement: 'chronological' }
    : { ...named, send: record }) as TranscriptEntry;
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
// Inert handlers: the menu shows what a person can do; nothing here talks to a daemon.
const QUEUE_ACTIONS = { edit: async () => true, cancel: async () => true };
const inert = async () => true;
createRoot(root).render(
  <QueueActionsContext.Provider value={QUEUE_ACTIONS}>
  <main style={{ margin: '0 auto', maxWidth: 560, padding: '12px 16px' }}>
    <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="fy-transcript-content" data-marks="">
        {entries.map((entry, index) => (
          <TranscriptRow answered={ANSWERED.has(index)} entry={entry} key={entry.id} onCancel={inert} onRetry={inert} onSubmit={inert} previous={entries[index - 1]} />
        ))}
      </div>
    </div>
    ${BEFORE ? '' : '<section data-legend="" style={{ marginTop: 16 }}><h2 className="text-ui font-semibold text-fg">Message marks</h2><MessageMarksLegend /></section>'}
  </main>
  </QueueActionsContext.Provider>,
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/receipts-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'receipts-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'receipts-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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

/** Relative luminance and the WCAG contrast ratio of two `rgb()` strings. */
const contrast = (a: string, b: string): number => {
  // `color(srgb r g b)` carries 0-1 channels, `rgb()` 0-255.
  const channels = (rgb: string): number[] =>
    (rgb.match(/[\d.]+/gu) ?? [])
      .slice(0, 3)
      .map(Number)
      .map(value => (rgb.startsWith('color(') ? value * 255 : value));
  const luminance = (rgb: string): number => {
    const [r, g, bl] = channels(rgb).map(value => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const dpr of [1, 2, 3] as const) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: dpr,
        isMobile: true,
        hasTouch: true,
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
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${dpr}x scrolls sideways by ${overflow}px`);
        const target = join(outDir, `receipts-${tag}-${dpr}x-${scheme}.png`);
        await page.screenshot({ path: target, fullPage: true });
        process.stdout.write(`📸 ${target}\n`);
        if (!BEFORE) {
          const legend = join(outDir, `receipts-legend-${dpr}x-${scheme}.png`);
          await page.locator('[data-legend]').screenshot({ path: legend });
          process.stdout.write(`📸 ${legend}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }

  // The same rows at desktop width, and — after — a queued bubble's menu (Edit / Cancel) and its inline editor.
  for (const scheme of ['light', 'dark'] as const) {
    for (const device of [
      { name: 'desktop', viewport: { width: 1280, height: 900 }, isMobile: false },
      { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true },
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
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('[data-marks]').waitFor({ state: 'visible' });
        if (device.name === 'desktop') {
          const target = join(outDir, `receipts-${tag}-desktop-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
          process.stdout.write(`📸 ${target}\n`);
        }
        if (BEFORE) continue;
        // The "⋯" of the bubble waiting for a draft: the nearest box around its words that holds one.
        const more = page
          .getByText('Queued while its box holds a draft')
          .first()
          .locator('xpath=ancestor::*[.//*[@data-ledger-more]][1]')
          .locator('[data-ledger-more]')
          .first();
        await more.scrollIntoViewIfNeeded();
        await more.click();
        // The menu draws its items a frame after it opens: the shot waits for them, then for paint.
        await page.getByRole('menuitem', { name: 'Edit' }).waitFor({ state: 'visible' });
        await page.getByRole('menuitem', { name: 'Cancel' }).first().waitFor({ state: 'visible' });
        await page.waitForTimeout(250);
        const menu = join(outDir, `receipts-menu-${device.name}-${scheme}.png`);
        await page.screenshot({ path: menu });
        process.stdout.write(`📸 ${menu}\n`);
        await page.getByRole('menuitem', { name: 'Edit' }).click();
        const editor = join(outDir, `receipts-edit-${device.name}-${scheme}.png`);
        await page.screenshot({ path: editor });
        process.stdout.write(`📸 ${editor}\n`);
      } finally {
        await context.close();
      }
    }
  }

  if (!BEFORE) {
    // Every theme family in both schemes: the mark must be a 3:1 graphic against the bubble it sits on.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      timezoneId: 'Asia/Tokyo',
      reducedMotion: 'reduce',
    });
    try {
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
      );
      const page = await context.newPage();
      const failures: string[] = [];
      for (const family of THEME_FAMILIES) {
        for (const scheme of ['light', 'dark'] as const) {
          const theme = `${family.id}-${scheme}`;
          await page.goto(`${server.url}?theme=${theme}`);
          await page.locator('[data-marks]').waitFor({ state: 'visible' });
          const marks = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('.fy-message-user .fy-receipt-mark')].map(mark => {
              let background = mark.parentElement;
              while (background !== null && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)')
                background = background.parentElement;
              return {
                kind: mark.getAttribute('data-receipt-mark') ?? '',
                color: getComputedStyle(mark).color,
                background: getComputedStyle(background ?? document.body).backgroundColor,
              };
            }),
          );
          if (marks.length === 0) failures.push(`${theme}: no marks rendered`);
          for (const mark of marks) {
            const ratio = contrast(mark.color, mark.background);
            if (ratio < 3)
              failures.push(
                `${theme}: ${mark.kind} mark is ${ratio.toFixed(2)}:1 (${mark.color} on ${mark.background})`,
              );
          }
          await page.locator('[data-marks]').screenshot({ path: join(outDir, `receipts-theme-${theme}.png`) });
        }
      }
      if (failures.length > 0) fail(`mark contrast below 3:1:\n${failures.join('\n')}`);
      process.stdout.write(`✅ every theme family keeps the marks at 3:1 or better\n`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}
