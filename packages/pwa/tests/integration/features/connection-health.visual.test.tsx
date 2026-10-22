/**
 * The connection notice in a real browser, at a phone and a desktop, light and dark.
 *
 * What is asserted: no horizontal page scroll, every control meets the touch floor in the phone
 * context (44px, pointer-derived) and WCAG 2.5.8's 24px on a desktop, and the walk's technical text
 * reaches the page only inside the details sheet. Set `FY_CONNECTION_SHOTS_DIR` to also keep the
 * captures for review; every name and sentence in them is fake.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import {
  ConnectionDetailsSheet,
  ConnectionHealthNoticeView,
} from '../../../src/features/connection/connection-health-notice.tsx';
import type { ConnectionHealthState } from '../../../src/lib/connection-health.ts';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import { sharedChromium } from '../support/chromium.ts';

type Reconnecting = Extract<ConnectionHealthState, { kind: 'reconnecting' }>;

const packageDir = resolve(import.meta.dir, '../../..');
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const MACHINE = 'workbench';
const shotsDir = process.env.FY_CONNECTION_SHOTS_DIR ?? '';

const outage = (overrides: Partial<Reconnecting> = {}): Reconnecting => ({
  kind: 'reconnecting',
  since: NOW - 14_000,
  attempt: 3,
  nextAttemptAt: NOW + 4_000,
  failures: [
    { label: 'Direct', detail: 'direct was not reachable (the socket closed before it opened, 1006)' },
    {
      label: 'Hosted relay',
      detail: 'the browser could not open a connection to wss://hosted-relay.example.workers.dev (1006)',
    },
  ],
  cause: 'relay-unreachable',
  stalled: false,
  ...overrides,
});

/** A stand-in for the page under the notice: the session's bar and the transcript it keeps showing. */
const scene = (notice: ReactElement): string =>
  renderToStaticMarkup(
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex items-center gap-md border-b border-border-strong bg-[var(--bar-bg)] px-panel py-md font-ui text-ui">
        <span className="truncate font-semibold">Fix the flaky test</span>
      </header>
      {notice}
      <main className="flex flex-col gap-3 p-panel text-ui leading-base">
        <p className="m-0 text-muted">You · 11:58</p>
        <p className="m-0">Run the suite again and tell me which test is flaky.</p>
        <p className="m-0 text-muted">Agent · 11:59</p>
        <p className="m-0">The retry test waits on a real timer; I am replacing it with an injected clock.</p>
      </main>
    </div>,
  );

const machine = (state: ConnectionHealthState) => ({ daemonId: daemonId('workbench-daemon'), name: MACHINE, state });
const second = (state: ConnectionHealthState) => ({ daemonId: daemonId('studio-daemon'), name: 'studio', state });

const view = (state: ConnectionHealthState, other: ConnectionHealthState = { kind: 'connected' }): ReactElement => (
  <ConnectionHealthNoticeView machines={[machine(state), second(other)]} now={NOW} onRetryNow={() => {}} />
);

const sheet = renderToStaticMarkup(
  <ConnectionDetailsSheet
    id="connection-sheet"
    open={true}
    onClose={() => {}}
    machines={[machine(outage()), second({ kind: 'connected' })]}
    now={NOW}
    onRetryNow={() => {}}
  />,
);

/** Server rendering never runs the sheet's entry effect, so the capture shows it at rest, fully in. */
const SHEET_AT_REST =
  '[data-bottom-sheet] [role="dialog"] { transform: none !important; } [data-bottom-sheet] > button { opacity: 1 !important; }';

const documentFor = (css: string, theme: string, body: string): string => `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style><style>${SHEET_AT_REST}</style></head>
<body>${body}</body></html>`;

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

interface Capture {
  readonly name: string;
  readonly body: string;
  readonly device: 'phone' | 'desktop';
  readonly mode: 'light' | 'dark';
  /** The technical text may appear only where the reader asked for it. */
  readonly technical: boolean;
}

const pill = scene(view(outage()));
// Stalled: the SAME compact pill, now naming the machine — there is no banner any more.
const offline = scene(view(outage({ stalled: true, since: NOW - 42_000, cause: 'daemon-unreachable' })));
const twoOffline = scene(view(outage({ stalled: true, since: NOW - 42_000 }), outage({ stalled: true })));
const withSheet = `${scene(view(outage()))}${sheet}`;

const captures: readonly Capture[] = [
  { name: 'pill-phone-light', body: pill, device: 'phone', mode: 'light', technical: false },
  { name: 'pill-phone-dark', body: pill, device: 'phone', mode: 'dark', technical: false },
  { name: 'pill-desktop-light', body: pill, device: 'desktop', mode: 'light', technical: false },
  { name: 'pill-desktop-dark', body: pill, device: 'desktop', mode: 'dark', technical: false },
  { name: 'sheet-phone-light', body: withSheet, device: 'phone', mode: 'light', technical: true },
  { name: 'sheet-phone-dark', body: withSheet, device: 'phone', mode: 'dark', technical: true },
  { name: 'offline-phone-light', body: offline, device: 'phone', mode: 'light', technical: false },
  { name: 'offline-phone-dark', body: offline, device: 'phone', mode: 'dark', technical: false },
  { name: 'offline-desktop-light', body: offline, device: 'desktop', mode: 'light', technical: false },
  { name: 'offline-desktop-dark', body: offline, device: 'desktop', mode: 'dark', technical: false },
  { name: 'two-offline-phone-light', body: twoOffline, device: 'phone', mode: 'light', technical: false },
];

let browser: Browser;
let workspace = '';
let css = '';

describe('Connection notice visual contract', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    workspace = await mkdtemp(join(tmpdir(), 'fy-connection-visual-'));
    const stylesheet = join(workspace, 'app.css');
    const result = spawnSync(
      './node_modules/.bin/tailwindcss',
      [
        '--config',
        'tailwind.config.ts',
        '--input',
        'src/styles/index.css',
        '--output',
        stylesheet,
        '--content',
        './src/**/*.{ts,tsx},./tests/integration/features/*.tsx',
      ],
      { cwd: packageDir, stdio: 'pipe' },
    );
    if (result.status !== 0) throw new Error(`tailwind build failed: ${result.stderr?.toString() ?? ''}`);
    css = await readFile(stylesheet, 'utf8');
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    if (workspace !== '') await rm(workspace, { recursive: true, force: true });
  });

  it('fits a phone and a desktop in both modes, meets the touch floor, and keeps the walk in the sheet', async () => {
    let page = '';
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    try {
      for (const capture of captures) {
        page = documentFor(css, `studio-${capture.mode}`, capture.body);
        const phone = capture.device === 'phone';
        const context = await browser.newContext({
          viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
          colorScheme: capture.mode,
          reducedMotion: 'reduce',
          deviceScaleFactor: 2,
          ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
        });
        try {
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) return route.abort();
            return route.continue();
          });
          const tab = await context.newPage();
          await tab.goto(server.url.toString());
          const metrics = await tab.evaluate<{
            inner: number;
            scroll: number;
            smallest: number;
            technical: boolean;
          }>(`(() => {
            const controls = [...document.querySelectorAll('[data-connection-pill], [data-connection-dismiss], [data-connection-retry]')];
            const heights = controls.map(control => control.getBoundingClientRect().height);
            return {
              inner: innerWidth,
              scroll: document.documentElement.scrollWidth,
              smallest: Math.min(...heights),
              technical: document.body.innerText.includes('1006'),
            };
          })()`);
          should(metrics.scroll).be.belowOrEqual(metrics.inner, `${capture.name} scrolls sideways`);
          should(metrics.smallest).be.aboveOrEqual(phone ? 44 : 24, `${capture.name} has a control under the floor`);
          should(metrics.technical).equal(capture.technical, `${capture.name} technical text`);
          if (shotsDir !== '') {
            const image = await tab.screenshot({
              animations: 'disabled',
              ...(phone || capture.technical ? {} : { clip: { x: 0, y: 0, width: 1_440, height: 360 } }),
            });
            await writeFile(join(shotsDir, `${capture.name}.png`), image);
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      server.stop(true);
    }
  }, 120_000);
});
