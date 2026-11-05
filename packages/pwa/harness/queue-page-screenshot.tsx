/**
 * Screenshots of the Queue page as the app mounts it (&B160), at phone 390 and desktop 1280, in the light and
 * dark studio themes, plus Find answering "Queue". Review evidence; nothing compares the PNGs.
 *
 *   bun harness/queue-page-screenshot.tsx [out-dir]     # default: harness/out/queue-page-*.png
 *
 * Unlike `outbox-screenshot.tsx`, which draws the bare `QueuePageView`, this renders the REAL `QueuePage`
 * container inside the REAL `createAppStore` — its fleet store seeded, its outbox holding a message — because
 * the container is what crashed: it handed the fleet store's methods to React detached from the store. Each
 * capture waits for the page's own `[data-queue-page]`, so a page that fails to mount fails the run.
 *
 * Views: `all` (every queue on two machines), `ferret` (one ferret's queue), `find` (the REAL
 * `CommandPalette` with "Queue" typed).
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
const QUEUES: Record<string, object> = {
  '/v1/sessions/s1/queue': {
    messages: [
      message('q1', 'Please re-run CI once the flaky test is fixed', 40, { waitReason: 'busy' }),
      message('q2', 'Held to combine with the next update', 41, {
        sender: 'agent', from: 'lead', fromName: 'Lead', by: { kind: 'ferret', name: 'Lead' },
        label: 'fyi', holdUntil: at(46),
      }),
      message('q3', 'Card &F12 moved to Review/CI', 42, {
        sender: 'daemon', by: { kind: 'ferretry', feature: 'Board' }, waitReason: 'draft', waitBehind: 'earlier',
      }),
      message('q4', 'Typed, waiting for proof', 39, { state: 'unconfirmed' }),
      message('q5', 'Already read', 30, { state: 'read' }),
      message('q7', 'Blocked: the deploy needs your approval before I can continue with the rollout. See https://github.com/kirinnee/ferretry/actions/runs/123456789012345678901234567890/job/98765432109876543210/attempts/3?pr=1481&check_suite_focus=true and @packages/pwa/src/components/queue-page.tsx:120-140 for the failing step.', 44, {
        sender: 'agent', from: 'mira', fromName: 'Mira', by: { kind: 'ferret', name: 'Mira' },
        label: 'blocker', waitReason: 'busy',
      }),
      message('q8', [
        '## Review notes',
        '',
        'I went through the diff and found **three** things worth a look:',
        '',
        '1. The retry loop never backs off',
        '2. \\u0060readSessionQueue\\u0060 swallows the error',
        '3. Card &F7 is still open',
        '',
        '\\u0060\\u0060\\u0060ts',
        'export const backoff = (attempt: number): number => Math.min(30_000, 2 ** attempt * 250);',
        'const veryLongLineThatShouldScrollInsideTheCodeBlockAndNeverPushThePageSideways = await fetchEverything(abc, def, ghi);',
        '\\u0060\\u0060\\u0060',
        '',
        'Then a long paragraph so the clamp has something to cut: ' + 'the queue holds each message until the ferret is idle and its input box is empty, and only then types it in. '.repeat(6),
        '',
        'Last line after the long paragraph.',
      ].join('\\n'), 45, {
        sender: 'agent', from: 'mira', fromName: 'Mira', by: { kind: 'ferret', name: 'Mira' },
        label: 'action', waitReason: 'busy',
      }),
      message('q9', '/home/kirin/Workspace/personal/ferretry/packages/pwa/src/components/very/deeply/nested/directory/structure/with/a/really/long/path/name/queue-page-view-component-final-v2.tsx', 46, {
        sender: 'agent', from: 'lead', fromName: 'Lead', by: { kind: 'ferret', name: 'Lead' },
        label: 'fyi', holdUntil: at(50),
      }),
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
await store.outbox.submit({ daemonId: 'laptop', sessionId: 's1', message: 'thank you — saved while offline' });

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  view === 'empty' ? (
    <RouterProvider>
      <StoreProvider store={store}>
        <div style={{ display: 'flex', minHeight: '100vh' }}>
          <QueuePage daemonId={laptop.daemonId} sessionId="s2" />
        </div>
      </StoreProvider>
    </RouterProvider>
  ) : view === 'find' ? (
    <CommandPalette open focusSignal={0} onClose={() => {}} daemon={laptop.daemonId} sessions={[]} onNavigate={() => {}} />
  ) : (
    <RouterProvider>
      <StoreProvider store={store}>
        <div style={{ display: 'flex', minHeight: '100vh' }}>
          {view === 'ferret' ? <QueuePage daemonId={laptop.daemonId} sessionId="s1" /> : <QueuePage daemonId={laptop.daemonId} />}
        </div>
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
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
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
        for (const view of ['all', 'ferret', 'expanded', 'empty', 'find'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${view === 'expanded' ? 'ferret' : view}`);
          if (view === 'find') {
            await page.getByRole('combobox').first().fill('Queue');
            await page.getByText('All queues').first().waitFor({ state: 'visible' });
          } else if (view === 'empty') {
            await page.locator('[data-queue-empty]').waitFor({ state: 'visible' });
          } else {
            await page.locator('[data-queue-page]').waitFor({ state: 'visible' });
            await page.locator('[data-queue-row]').first().waitFor({ state: 'visible' });
            if (view === 'expanded') await page.locator('[data-queue-more]').first().click();
          }
          await page.waitForTimeout(250);
          if (errors.length > 0) fail(`${view} ${device.name} ${scheme} threw: ${errors.join(' | ')}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${view} ${device.name} ${scheme} scrolls sideways by ${overflow}px`);
          const target = join(outDir, `queue-page-${view}-${device.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: view !== 'find' });
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
