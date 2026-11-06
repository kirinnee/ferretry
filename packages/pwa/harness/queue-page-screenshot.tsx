/**
 * Screenshots of the Queue page as the app mounts it (&B160), at phone 390 and desktop 1280, in the light and
 * dark studio themes, plus Find answering "Queue". Review evidence; nothing compares the PNGs.
 *
 *   bun harness/queue-page-screenshot.tsx [out-dir]     # default: harness/out/queue-page-*.png
 *
 * This renders the REAL `QueuePage` container inside the REAL `createAppStore` — its fleet store seeded, its
 * outbox holding a message — wrapped in the app's own shell boxes (a fixed `kt-shell` that clips, a flex column,
 * the pane that is a plain block), because the page sits inside a clipped pane and that is where it once could
 * not scroll. The shots are therefore VIEWPORT shots: what a person sees, not a stretched full page. Each capture
 * waits for the page's own `[data-queue-page]`, so a page that fails to mount fails the run.
 *
 * Fixture (fake data): one ferret with three undelivered messages (Waiting, Sending, Failed) and 56 sent ones
 * (Delivered and Read, several senders, some long and multi-line, a few days old).
 *
 * Views: `waiting` (the default list), `sent` (the Sent list), `scrolled` (Sent, scrolled down — it scrolls),
 * `search` (a search typed into the Sent list), `expanded` (one row opened), `all` (every queue on two
 * machines), `empty`, `find` (the REAL `CommandPalette` with "Queue" typed).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

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
import { QueuePage } from '../../src/components/queue-page.tsx';
import { createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { MemoryOutboxBackend } from '../../src/lib/send-outbox.ts';
import { RouterProvider } from '../../src/lib/router.tsx';
import { CommandPalette } from '../../src/shell/command-palette.tsx';

const view = new URLSearchParams(location.search).get('view') ?? 'all';
const at = (minute: number) => new Date(Date.now() - (60 - minute) * 60000).toISOString();
const message = (id: string, text: string, minute: number, extra: object = {}) => ({
  v: 1, id, sender: 'human', text, attachmentIds: [], state: 'queued', stateAt: at(minute), revision: 1,
  enqueuedAt: at(minute), ...extra,
});
// ago(days, minutes): an instant that long before now.
const ago = (days: number, minutes: number) => new Date(Date.now() - days * 86400000 - minutes * 60000).toISOString();
const SENDERS = [
  { name: 'Mira', id: 'mira' },
  { name: 'Lead', id: 'lead' },
  { name: 'Ferretry · Board', id: 'board', daemon: true },
  { name: 'Tomi', id: 'tomi' },
  { name: 'you', id: 'human', owner: true },
];
const LINES = [
  'Green and CLEAN, ready for you: #1020 (on your hold), #1015 lanes-follow-facts (merge on green), #1011 B62 scroll (approved).',
  'Plan: build the daemon half first, then the app half. Both start once S5 lands.',
  '[board] &F149 done: PR https://github.com/kirinnee/ferretry/pull/1015 — GREEN, MERGEABLE/CLEAN, not merged.',
  'Please re-run CI once the flaky test is fixed.',
  'Watching live deliveries for 30 min; I will report anything that sticks or goes twice.',
  'Merged. Next I open the small follow-up: the empty slot folds when it fits.',
];
const HISTORY = Array.from({ length: 56 }, (_, index) => {
  const who = SENDERS[index % SENDERS.length] as (typeof SENDERS)[number];
  const base = LINES[index % LINES.length] as string;
  // Every fifth one is long and multi-line, so an opened row has something to show.
  const text = index % 5 === 0
    ? [base, '', 'Details:', '- the first thing, with enough words to wrap on a phone when the row is opened', '- the second thing', '', base.repeat(2)].join('\\n')
    : base;
  return message('h' + index, text, 0, {
    ...(who.owner ? {} : who.daemon
      ? { sender: 'daemon', by: { kind: 'ferretry', feature: 'Board' } }
      : { sender: 'agent', from: who.id, fromName: who.name, by: { kind: 'ferret', name: who.name } }),
    state: index % 3 === 0 ? 'delivered' : 'read',
    enqueuedAt: ago(Math.floor(index / 9), 70 + index * 7),
    stateAt: ago(Math.floor(index / 9), 60 + index * 7),
  });
});
const QUEUES: Record<string, object> = {
  '/v1/sessions/s1/queue': {
    messages: [
      // Not delivered yet: Waiting, Sending, Failed.
      message('q1', 'Please re-run CI once the flaky test is fixed', 40, { waitReason: 'busy' }),
      message('q4', 'Typed into the pane, waiting for proof it arrived', 39, { state: 'typing' }),
      message('q11', 'Roll back the migration if the canary fails', 38, {
        state: 'failed', failure: 'the ferret\u2019s pane closed before it could be typed',
      }),
      // Delivered and Read — the history behind the Sent toggle, a few days old, edge cases included.
      message('q7', 'Blocked: the deploy needs your approval before I can continue with the rollout. See https://github.com/kirinnee/ferretry/actions/runs/123456789012345678901234567890/job/98765432109876543210/attempts/3?pr=1481&check_suite_focus=true and @packages/pwa/src/components/queue-page.tsx:120-140 for the failing step.', 0, {
        enqueuedAt: ago(1, 50), sender: 'agent', from: 'mira', fromName: 'Mira', by: { kind: 'ferret', name: 'Mira' },
        label: 'blocker', state: 'read',
      }),
      message('q8', [
        '## Review notes',
        '',
        'I went through the diff and found **three** things worth a look:',
        '',
        '1. The retry loop never backs off',
        '2. \u0060readSessionQueue\u0060 swallows the error',
        '3. Card &F7 is still open',
        '',
        '\u0060\u0060\u0060ts',
        'export const backoff = (attempt: number): number => Math.min(30_000, 2 ** attempt * 250);',
        'const veryLongLineThatShouldScrollInsideTheCodeBlockAndNeverPushThePageSideways = await fetchEverything(abc, def, ghi);',
        '\u0060\u0060\u0060',
        '',
        'Then a long paragraph so the row has something to open: ' + 'the queue holds each message until the ferret is idle and its input box is empty, and only then types it in. '.repeat(4),
        '',
        'Last line after the long paragraph.',
      ].join('\\n'), 0, {
        enqueuedAt: ago(1, 55), sender: 'agent', from: 'mira', fromName: 'Mira', by: { kind: 'ferret', name: 'Mira' },
        label: 'action', state: 'read',
      }),
      message('q9', '/home/kirin/Workspace/personal/ferretry/packages/pwa/src/components/very/deeply/nested/directory/structure/with/a/really/long/path/name/queue-page-view-component-final-v2.tsx', 0, {
        enqueuedAt: ago(2, 58), sender: 'agent', from: 'lead', fromName: 'Lead', by: { kind: 'ferret', name: 'Lead' },
        label: 'fyi', state: 'delivered',
      }),
      // A callsign with no break opportunity: it must ellipsize inside its column, never widen a 390px page.
      message('q10', 'Sender name has no spaces at all', 0, {
        enqueuedAt: ago(2, 59), sender: 'agent', from: 'wide', fromName: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', by: { kind: 'ferret', name: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW' },
        label: 'fyi', state: 'read',
      }),
      ...HISTORY,
    ],
  },
  '/v1/sessions/s2/queue': { messages: [] },
  '/v1/sessions/s3/queue': {
    messages: [message('q6', 'Review the board when you are free', 43, { waitReason: 'stopped' })],
  },
};

class Memory {
  values = new Map<string, string>();
  async load(key: string) { return this.values.get(key) ?? null; }
  async save(key: string, value: string) { this.values.set(key, value); }
}
const laptop = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'device', daemonName: 'Laptop' });
const workshop = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 'device', daemonName: 'Workshop' });
const store = await createAppStore({
  repository: new Memory() as never,
  // An offline send, so the device's own message reads as it does on a plane: "waiting for connection".
  connectClient: async () => ({
    request: async (path: string) => QUEUES[path] ?? { messages: [] },
    send: async () => { throw new TypeError('Failed to fetch'); },
  }) as never,
  fetcher: (async () => Response.json({})) as never,
  outboxBackend: new MemoryOutboxBackend(),
});
store.connections.add(laptop);
store.connections.add(workshop);
const session = (id: string, name: string, teammate?: string) =>
  ({ config: { id, name, agent: 'claude', mode: 'auto', cwd: '/work', ...(teammate ? { teammate } : {}) },
     state: { id, status: 'running', turn: 1 } }) as never;
store.fleet.seed(laptop, [session('s1', 'one', 'Casen'), session('s2', 'two', 'Idle')], Date.now());
store.fleet.seed(workshop, [session('s3', 'three', 'Mira')], Date.now());
if (view === 'all') await store.outbox.submit({ daemonId: 'laptop', sessionId: 's1', message: 'thank you — saved while offline' });

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
// The app's own boxes around a page: a fixed shell that clips, a flex column, and the pane — a plain block.
const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="kt-shell flex flex-row overflow-hidden">
    <div data-shell-main="" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3">
        <div className="contents">{children}</div>
      </div>
    </div>
  </div>
);
createRoot(root).render(
  view === 'find' ? (
    <CommandPalette open focusSignal={0} onClose={() => {}} daemon={laptop.daemonId} sessions={[]} onNavigate={() => {}} />
  ) : (
    <RouterProvider>
      <StoreProvider store={store}>
        <Shell>
          {view === 'empty' ? (
            <QueuePage daemonId={laptop.daemonId} sessionId="s2" />
          ) : view === 'all' ? (
            <QueuePage daemonId={laptop.daemonId} />
          ) : (
            <QueuePage daemonId={laptop.daemonId} sessionId="s1" />
          )}
        </Shell>
      </StoreProvider>
    </RouterProvider>
  ),
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/queue-page-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'queue-page-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'queue-page-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    // The stylesheet names its fonts at `/assets/fonts/…`; they live in the source tree, not the build folder.
    if (url.pathname.startsWith('/assets/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
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
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const rows = page.locator('[data-queue-row]');
        for (const view of ['waiting', 'sent', 'scrolled', 'search', 'expanded', 'all', 'empty', 'find'] as const) {
          const entry = view === 'all' || view === 'empty' || view === 'find' ? view : 'ferret';
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${entry}`);
          if (view === 'find') {
            await page.getByRole('combobox').first().fill('Queue');
            await page.getByText('All queues').first().waitFor({ state: 'visible' });
          } else if (view === 'empty') {
            await page.locator('[data-queue-empty]').waitFor({ state: 'visible' });
          } else {
            await page.locator('[data-queue-page]').waitFor({ state: 'visible' });
            await rows.first().waitFor({ state: 'visible' });
          }
          if (view === 'sent' || view === 'scrolled' || view === 'search' || view === 'expanded')
            await page.locator('[data-queue-listing="sent"]').click();
          if (view === 'search') await page.locator('[data-queue-search]').fill('mira');
          if (view === 'expanded') await page.locator('[data-queue-row="q8"] [data-queue-line]').click();
          if (view === 'scrolled') {
            const scrolled = await page.locator('[data-queue-page]').evaluate(node => {
              const before = node.scrollTop;
              node.scrollTop = node.scrollHeight / 2;
              return { before, after: node.scrollTop, room: node.scrollHeight - node.clientHeight };
            });
            if (scrolled.room <= 0 || scrolled.after <= scrolled.before)
              fail(`scrolled ${device.name} ${scheme}: the page did not scroll (${JSON.stringify(scrolled)})`);
          }
          await page.waitForTimeout(250);
          if (errors.length > 0) fail(`${view} ${device.name} ${scheme} threw: ${errors.join(' | ')}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${view} ${device.name} ${scheme} scrolls sideways by ${overflow}px`);
          if (view === 'waiting' || view === 'sent') {
            // A compact row is ONE line: no row may be taller than a thumb's worth of text.
            const tall = await rows.evaluateAll(
              nodes =>
                nodes.filter(node => !node.hasAttribute('data-queue-open') && node.getBoundingClientRect().height > 60)
                  .length,
            );
            if (tall > 0) fail(`${view} ${device.name} ${scheme}: ${tall} collapsed rows are taller than one line`);
          }
          const target = join(outDir, `queue-${view}-${device.name}-${scheme}.png`);
          await page.screenshot({ path: target });
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
