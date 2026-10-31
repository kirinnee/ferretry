/**
 * Screenshots of Change model or account refused only by the agent's own background jobs — the card that
 * offers "Ask the agent to stop its background jobs" — at a 390px phone and a 1440px desktop, in the light
 * and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/migrate-ask-screenshot.tsx      # writes harness/out/migrate-ask-<state>-<viewport>-<scheme>.png
 *
 * It renders the REAL `MigrateSheet` with a canned refusal and a canned ask, in three states: the refusal
 * offering the ask, the same refusal once the agent has been asked, and the refusal from a daemon too old
 * to offer it (`update`), which says to update the machine instead. `SHOTS_DIR` sends the PNGs
 * elsewhere. No real path, name or credential appears. Like `screenshot.ts` it drives the system Chrome
 * through playwright-core and aborts every request off the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
const shotsDir = process.env.SHOTS_DIR ?? outDir;

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
import { FyHttpError } from '@ferretry/protocol/client';
import { MigrateSheet } from '../../src/components/migrate-sheet.tsx';

const daemon = { daemonId: 'fy_daemon_harness', baseUrl: 'https://harness.invalid', deviceId: 'harness', carriers: [] };
const scope = { daemonId: 'fy_daemon_harness', sessionId: 'harness-session' };
const view = {
  config: { id: 'harness-session', name: 'Tidy the release notes', harness: 'claude', agent: 'claude-work', teammate: 'hadi', model: 'claude-opus-5-5', modelHint: 'claude-opus-5-5' },
  state: { id: 'harness-session', status: 'waiting', turn: 12, contextTokens: 80000, contextWindow: 200000 },
  directory: '/work/harness',
};
const shell = "/usr/bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'bash ./merge-all.sh 765'";
const job = (pid, detail) => ({
  kind: 'process', verdict: 'unknown', title: 'A program Ferretry doesn’t recognise is running',
  detail, age: '4m', blocks: true, backgroundJob: true, pid,
});
const message = [
  'refused: A program Ferretry doesn’t recognise is running — ' + shell.slice(0, 80) + '… (and 1 more)',
  'in-flight inventory — status waiting, turn 12, worst: UNKNOWN',
  '  proc  [safe] pid 5010 (2h): fy mcp serve',
  '  proc  [UNKNOWN] pid 5100 (4m): ' + shell.slice(0, 89) + '…',
  '  proc  [UNKNOWN] pid 5101 (4m): bash ./merge-all.sh 765',
  '  proc  [safe] pid 5102 (5s): sleep 5',
].join('\\n');
const refusal = {
  error: message, code: 'migration_refused',
  inflight: { status: 'waiting', turn: 12, blockedBy: 'unknown', restartsWithCli: 1, items: [
    job(5100, shell), job(5101, 'bash ./merge-all.sh 765'),
    { kind: 'process', verdict: 'safe_to_kill', title: 'A short read-only command is running', detail: 'sleep 5', age: '5s', blocks: false, backgroundJob: true, pid: 5102 },
  ] },
};
// state=update: the same refusal from a daemon older than the ask, which marks no job and says its version.
const older = new URLSearchParams(location.search).get('state') === 'update';
const unmarked = {
  ...refusal,
  inflight: { ...refusal.inflight, items: refusal.inflight.items.map(({ backgroundJob, pid, ...item }) => item) },
};
const migrateSession = async () => {
  if (older) throw new FyHttpError(message, 409, 'migration_refused', unmarked, '4.152.0');
  throw new FyHttpError(message, 409, 'migration_refused', refusal);
};
const askToStopJobs = async () => ({
  messageId: 'migrate-jobs-5100-5101',
  jobs: [{ pid: 5100, command: shell, age: '4m' }, { pid: 5101, command: 'bash ./merge-all.sh 765', age: '4m' }],
  alreadyAsked: false,
});
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex flex-col bg-bg">
    <MigrateSheet
      askToStopJobs={askToStopJobs}
      canMutate
      connection={daemon}
      migrateSession={migrateSession}
      onClose={() => undefined}
      onMigrated={() => undefined}
      open
      scope={scope}
      view={view}
    />
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg"><div id="root"></div><script type="module" src="/migrate-ask-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
await Bun.write(join(outDir, 'migrate-ask-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'migrate-ask-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
    // The stylesheet names the app's fonts under `/assets/fonts`; they are served from source.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const STATES = ['offer', 'asked', 'update'] as const;
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1_440, height: 900, touch: false },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const state of STATES) {
    for (const viewport of VIEWPORTS) {
      for (const scheme of ['light', 'dark'] as const) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
          reducedMotion: 'reduce',
          hasTouch: viewport.touch,
          isMobile: viewport.touch,
        });
        try {
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
            return await route.continue();
          });
          const page = await context.newPage();
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          await page.locator('input.kt-input').first().fill('claude-home');
          await page.getByRole('button', { name: 'Review migration' }).click();
          await page.getByRole('button', { name: 'Migrate and relaunch' }).click();
          const selector = state === 'update' ? '[data-agent-jobs-update]' : '[data-agent-jobs-ask]';
          const ask = page.locator(selector);
          await ask.waitFor({ state: 'visible' });
          if (state === 'asked') {
            await page.locator('[data-agent-jobs-ask-button]').click();
            await ask.getByRole('status').waitFor({ state: 'visible' });
          }
          // The card is what the shot is for: bring it into view on a phone, where it sits below the fold.
          await ask.scrollIntoViewIfNeeded();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${state}/${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          // The card must keep the sheet's side gutter: a grid track that grows to its longest unbroken line
          // pushes it past the edge while the page itself never scrolls sideways.
          const edges = await page.evaluate(card => {
            const box = document.querySelector(card)?.closest('section')?.getBoundingClientRect();
            return box === undefined ? null : { left: box.left, right: window.innerWidth - box.right };
          }, selector);
          process.stdout.write(`   card gutter ${state}/${viewport.name}/${scheme}: ${JSON.stringify(edges)}\n`);
          if (edges === null || edges.left < 8 || edges.right < 8)
            fail(`${state}/${viewport.name}/${scheme} card runs into the edge: ${JSON.stringify(edges)}`);
          // Nothing inside the card may be wider than the card: a nowrap button label is the usual offender.
          const spill = await page.evaluate(within => {
            const card = document.querySelector(within);
            if (card === null) return [];
            const right = card.getBoundingClientRect().right;
            return [...card.querySelectorAll<HTMLElement>('button, p')]
              .filter(node => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > right + 1)
              .map(node => (node.textContent ?? '').trim().slice(0, 30));
          }, selector);
          if (spill.length > 0) fail(`${state}/${viewport.name}/${scheme} spills out of the card: ${spill.join(', ')}`);
          const floor = viewport.touch ? 44 : 24;
          const small = await page.evaluate(
            ({ minimum, within }) =>
              [...document.querySelectorAll<HTMLElement>(`${within} button`)]
                .filter(node => node.offsetParent !== null)
                .filter(node => node.getBoundingClientRect().height < minimum)
                .map(node => (node.textContent ?? '').trim().slice(0, 30)),
            { minimum: floor, within: selector },
          );
          if (small.length > 0)
            fail(`${state}/${viewport.name}/${scheme} has controls under ${floor}px: ${small.join(', ')}`);
          const target = join(shotsDir, `migrate-ask-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
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
