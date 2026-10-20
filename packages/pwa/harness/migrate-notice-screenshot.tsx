/**
 * Screenshots of the two chat fixes in one transcript: (1) the delivery note ("via turn file") now shares ONE
 * meta row with the time and ticks of an owner bubble instead of sitting on a line of its own, and (2) the
 * notice Ferretry sends after a restart that interrupted work renders as a compact system row
 * ("Restarted mid-turn — 1 command was interrupted · details") rather than an owner bubble. Phone (390) and
 * desktop (1440), light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/migrate-notice-screenshot.tsx            # writes harness/out/migrate-notice-after-*.png
 *   bun harness/migrate-notice-screenshot.tsx --before   # the OLD notice text, which a pre-fix tree draws as an owner bubble
 *
 * It renders the REAL `TranscriptRow` over entries projected from a real daemon log, inside the real
 * `HandoffSourceProvider`, with the daemon's answer faked in the page — no network.
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

const OLD_NOTICE =
  'You were migrated mid-turn. Read /home/kirin/.ferretry/state/sessions/ms0v8vgc-d445a669/migration-inflight.md — it lists what was running and what to check before re-running anything.';
const NEW_NOTICE = [
  '[ferretry] Restarted mid-turn — 1 command was interrupted.',
  '',
  'This notice is from Ferretry, not from the owner. Before re-running anything, read /home/kirin/.ferretry/state/sessions/ms0v8vgc-d445a669/migration-inflight.md: it lists what was running and what to check.',
].join('\n');

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { turnFileInstruction } from '@ferretry/protocol';
import { HandoffSourceProvider } from '../../src/components/handoff-message.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { withAgentName } from '../../src/components/transcript.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';

const STATE = '/home/kirin/.ferretry/state/sessions/ms0v8vgc-d445a669';
const LOG = [
  '[01:44:02] user/message: Can you check the onboarding screen?',
  '[01:44:30] assistant/message: Sure — what looks wrong?',
  '[01:45:10] user/message: ' + turnFileInstruction(STATE + '/turns/turn-008.md'),
  '[01:45:44] assistant/message: The **Continue** button sits under the keyboard at 390px. Fixing the inset now.',
  '[01:47:02] user/message: ' + turnFileInstruction(STATE + '/turns/turn-009.md'),
  '[01:47:40] assistant/message: I am back on the same conversation and carrying on with the inset fix.',
  '[01:49:00] user/message: ' + turnFileInstruction(STATE + '/turns/turn-010.md'),
].join('\\n');

const NOTICE = ${JSON.stringify(BEFORE ? OLD_NOTICE : NEW_NOTICE)};
const DOCUMENTS = {
  'turn-008': 'Is this turn-based system legit?\\n\\nOn my phone the **Continue** button is hidden:\\n\\n- open onboarding\\n- tap the name field\\n- the keyboard covers the button',
  'turn-009': NOTICE,
  'turn-010': 'Thanks — also check the landscape layout when you are done.',
};

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'harness' });
const source = {
  daemon,
  sessionId: 'ms0v8vgc-d445a669',
  read: async (name: string) => {
    const message = DOCUMENTS[name as keyof typeof DOCUMENTS];
    if (message === undefined) throw new Error('no hand-off document ' + name);
    return { name, message, attachments: [] };
  },
};

const now = Date.UTC(2026, 9, 18, 2, 0, 0);
const ticks = { acceptedAt: '2026-10-18T01:45:00.000Z', attachmentIds: [], fate: 'delivered' };
const entries: TranscriptEntry[] = transcriptEntriesFromLog(LOG, now).map((entry, index) => {
  const named = withAgentName(entry, 'Janella');
  return index === 2 ? ({ ...named, send: { ...ticks, sendId: 's8', message: DOCUMENTS['turn-008'], turn: 8 } } as TranscriptEntry) : named;
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
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
  </HandoffSourceProvider>,
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/migrate-notice-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'migrate-notice-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'migrate-notice-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
        await page.waitForFunction(() => document.querySelector('[data-handoff-state="reading"]') === null);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `migrate-notice-${tag}-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: target, fullPage: true });
        process.stdout.write(`📸 ${target}\n`);
        if (!BEFORE) {
          await page.locator('[data-system-notice] .fy-system-details').click();
          await page.locator('.fy-handoff-via-button').first().click();
          const opened = join(outDir, `migrate-notice-opened-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: opened, fullPage: true });
          process.stdout.write(`📸 ${opened}\n`);
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
