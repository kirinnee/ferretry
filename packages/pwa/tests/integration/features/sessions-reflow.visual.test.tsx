/**
 * Two things a phone must never do, measured in a real browser on the shipped stylesheet:
 *
 * 1. THE SESSIONS PAGE NEVER SCROLLS SIDEWAYS. Across paired machines the page is nested CSS grids, and a
 *    grid with one implicit `auto` column is as wide as its widest unbreakable line — one session card's
 *    meta row ("id · account · model") pushed the whole machine section past the phone and the cards ran
 *    off the right edge. The page is rendered here WITHOUT the app's fixed, clipping shell, so any element
 *    wider than the window shows up as `document.scrollWidth > clientWidth`, and every card is also held
 *    inside the window by its own rectangle.
 * 2. THE CONNECTION NOTICE NEVER MOVES THE PAGE. The reconnect pill and the offline pill are overlays: the
 *    header's and the content's boxes are identical connected, reconnecting and stalled.
 *
 * Set `FY_REFLOW_SHOTS_DIR` to keep the captures (written BEFORE the assertions, so a failing run still
 * leaves its evidence). Every name, id and path in them is fake.
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

import { SessionDashboard } from '../../../src/components/session-dashboard.tsx';
import { ConnectionHealthNoticeView } from '../../../src/features/connection/connection-health-notice.tsx';
import { allMachinesView, type MachineSource } from '../../../src/lib/all-machines.ts';
import type { ConnectionHealthState } from '../../../src/lib/connection-health.ts';
import { type DaemonId, daemonConnection, daemonId } from '../../../src/lib/daemon-connection.ts';
import { sessionView } from '../../support/sessions.ts';
import { wardenAccount, wardenFailover, wardenStatus } from '../../support/warden.ts';
import { sharedChromium } from '../support/chromium.ts';

type Reconnecting = Extract<ConnectionHealthState, { kind: 'reconnecting' }>;

const packageDir = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_REFLOW_SHOTS_DIR ?? '';
const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/** The widths a phone spans, the owner's Android (412) and an iPhone (390) among them, and a desktop. */
const PHONES = [320, 390, 412] as const;
const DESKTOP = 1_440;

const LONG_ID = 'mvgrig6j-51ec0eb3-0000-4000-8000-0123456789abcdef0123456789abcdef';
const LONG_MODEL = 'claude-opus-5-5-with-an-unreasonably-long-model-identifier-1m-context';
const LONG_LABEL = 'a-very-long-unbroken-task-label-that-keeps-going-and-going-past-any-phone-width';
const LONG_AGENT = 'claude-an-account-wrapper-with-a-very-long-unbroken-name-kirin';
const LONG_PATH = '/Users/erng/Workspace/work/vungle/a-deeply-nested-folder/with/many/segments/that/never/ends/PE';

const row = (id: string, cwd: string, config: Record<string, unknown>, state: Record<string, unknown> = {}) =>
  sessionView(id, {
    config: { teammate: 'Aarya', name: 'Valkey Leader', cwd, ...config },
    state: { status: 'awaiting_user', lastActivityAt: ago(2), contextPercent: 54, ...state },
  });

const LAPTOP = 'laptop' as DaemonId;
const sources: readonly MachineSource[] = [
  {
    daemonId: LAPTOP,
    name: 'Liftoff MBP',
    reach: 'online',
    projects: [{ name: 'PE', path: LONG_PATH }],
    slice: {
      sessions: [
        row(LONG_ID, LONG_PATH, { agent: 'claude-kirin', model: LONG_MODEL, label: LONG_LABEL }, { status: 'running' }),
        row(
          'mvgrig6j-51ec0eb3',
          LONG_PATH,
          { agent: LONG_AGENT, model: 'claude-opus-5-5', mode: 'interactive' },
          { status: 'running' },
        ),
        row('mvgrig6k-77aa1100', LONG_PATH, { agent: 'claude-kirin', model: 'claude-opus-5-5' }),
        row('mvheb7uf-08a09950', LONG_PATH, { agent: 'claude-kirin', model: 'claude-opus-5-5' }, { status: 'running' }),
      ],
      byId: new Map(),
      status: 'ready',
      error: null,
      readAt: NOW,
    },
  },
];

const connection = daemonConnection({ daemonId: LAPTOP, baseUrl: 'https://laptop.invalid', deviceId: 'on-laptop' });

const sessionsPage = (): ReactElement => (
  <div className="flex min-h-dvh flex-col bg-bg text-fg">
    <main className="min-w-0 flex-1 px-1 sm:px-3">
      <SessionDashboard
        accounts={[]}
        allMachines={allMachinesView(sources)}
        connection={connection}
        dashboardView="cards"
        density="full"
        error={null}
        groups={[]}
        narrow
        now={NOW}
        onEnterScope={() => undefined}
        onExitScope={() => undefined}
        onFocusMachine={() => undefined}
        onOpenWardenReport={() => undefined}
        onSetView={() => undefined}
        scope={null}
        scopeName=""
        scopeRecovered={false}
        sessions={null}
        usage={null}
        wardenStatus={wardenStatus({
          failover: wardenFailover({
            accounts: [
              wardenAccount({ agent: 'claude-default' }),
              wardenAccount({ agent: 'claude-a-very-long-unbroken-warden-account-wrapper-name' }),
            ],
          }),
        })}
        wardenVerdicts={[]}
      />
    </main>
  </div>
);

const outage = (overrides: Partial<Reconnecting> = {}): Reconnecting => ({
  kind: 'reconnecting',
  since: NOW - 14_000,
  attempt: 6,
  nextAttemptAt: NOW + 4_000,
  failures: [{ label: 'Direct', detail: 'direct was not reachable (1006)' }],
  cause: 'relay-unreachable',
  stalled: false,
  ...overrides,
});

/** A session page: its own header and tabs, a transcript, and the connection notice mounted where the shell mounts it. */
const sessionScene = (state: ConnectionHealthState): ReactElement => (
  <div className="flex min-h-dvh flex-col bg-bg text-fg">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ConnectionHealthNoticeView
        machines={[{ daemonId: daemonId('workbench-daemon'), name: 'workbench', state }]}
        now={NOW}
        onRetryNow={() => {}}
      />
      <header
        data-scene-header=""
        className="flex items-center gap-md border-b border-border-strong bg-[var(--bar-bg)] px-panel py-md font-ui text-ui"
      >
        <span className="truncate font-semibold">Lizzette</span>
      </header>
      <main data-scene-main="" className="flex flex-col gap-3 p-panel text-ui leading-base">
        <p className="m-0">Also merged since the last update: the cached-data copying cost is gone.</p>
        <p className="m-0">The app checks in less often while idle.</p>
      </main>
    </div>
  </div>
);

const documentFor = (css: string, theme: string, body: string): string => `<!doctype html>
<html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head>
<body>${body}</body></html>`;

let browser: Browser;
let workspace = '';
let css = '';

const withPage = async <T,>(
  html: (theme: string) => string,
  options: { readonly width: number; readonly mode: 'light' | 'dark' },
  run: (page: import('playwright-core').Page) => Promise<T>,
): Promise<T> => {
  let served = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(served, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  const phone = options.width < 1_000;
  const context = await browser.newContext({
    viewport: { width: options.width, height: phone ? 860 : 900 },
    colorScheme: options.mode,
    reducedMotion: 'reduce',
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
  });
  try {
    served = html(`studio-${options.mode}`);
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === server.url.origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    await page.goto(server.url.toString());
    await page.evaluate('document.fonts.ready.then(() => undefined)');
    return await run(page);
  } finally {
    await context.close();
    server.stop(true);
  }
};

const keep = async (page: import('playwright-core').Page, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await writeFile(join(shotsDir, `${name}.png`), await page.screenshot({ animations: 'disabled' }));
};

describe('Sessions page and connection notice never reflow a phone', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    workspace = await mkdtemp(join(tmpdir(), 'fy-reflow-visual-'));
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

  const sessionsMarkup = renderToStaticMarkup(sessionsPage());

  for (const mode of ['light', 'dark'] as const) {
    for (const width of [...PHONES, DESKTOP]) {
      it(`the Sessions page fits a ${width}px window in ${mode}, long names and ids included`, async () => {
        await withPage(
          theme => documentFor(css, theme, sessionsMarkup),
          { width, mode },
          async page => {
            const measured = await page.evaluate<{
              inner: number;
              scroll: number;
              sawLongId: boolean;
              cards: number;
              outside: string[];
            }>(`(() => {
            const inner = document.documentElement.clientWidth;
            const cards = [...document.querySelectorAll('a.kt-panel')];
            return {
              inner,
              scroll: document.documentElement.scrollWidth,
              sawLongId: document.body.innerText.includes('mvgrig6j-51ec0eb3-0000'),
              cards: cards.length,
              outside: [...document.querySelectorAll('main *')]
                .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > inner + 1 || r.left < -1); })
                .slice(0, 6)
                .map(el => el.tagName + '.' + String(el.className).slice(0, 48)),
            };
          })()`);
            await keep(page, `sessions-${width}-${mode}`);
            should(measured.cards).equal(3, 'the three running sessions rendered as cards');
            should(measured.sawLongId).equal(true, 'the long-id fixture rendered');
            should(measured.scroll).be.belowOrEqual(
              measured.inner,
              `the page scrolls sideways at ${width}px: ${measured.outside.join(' | ')}`,
            );
            should(measured.outside).deepEqual([], `elements outside the ${width}px window`);
          },
        );
      });
    }

    it(`the connection notice moves nothing at 412px in ${mode}: header and content keep their boxes`, async () => {
      const states: ReadonlyArray<readonly [string, ConnectionHealthState]> = [
        ['connected', { kind: 'connected' }],
        ['pill', outage()],
        ['offline', outage({ stalled: true, since: NOW - 42_000 })],
      ];
      const boxes = new Map<string, { header: string; main: string; fixed: boolean; passes: string }>();
      for (const [name, state] of states) {
        const markup = renderToStaticMarkup(sessionScene(state));
        await withPage(
          theme => documentFor(css, theme, markup),
          { width: 412, mode },
          async page => {
            boxes.set(
              name,
              await page.evaluate(`(() => {
              const box = el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(','); };
              const region = document.querySelector('[data-connection-health]');
              const shown = region.firstElementChild;
              const style = getComputedStyle(region);
              const top = shown === null ? 0 : shown.getBoundingClientRect().top;
              return {
                header: box(document.querySelector('[data-scene-header]')),
                main: box(document.querySelector('[data-scene-main]')),
                fixed: style.position === 'fixed' && document.documentElement.scrollHeight <= innerHeight,
                passes: style.pointerEvents + ':' + (shown === null ? 'none' : top >= 0 ? 'in-window' : 'above-window'),
              };
            })()`),
            );
            await keep(page, `notice-${name}-412-${mode}`);
          },
        );
      }
      const rest = must(boxes.get('connected'));
      for (const name of ['pill', 'offline'] as const) {
        const now = must(boxes.get(name));
        should(now.header).equal(rest.header, `${name} moved the header`);
        should(now.main).equal(rest.main, `${name} moved the content`);
        should(now.fixed).equal(true, `${name} is not a fixed overlay that leaves the page height alone`);
        should(now.passes).equal('none:in-window', `${name} must pass touches through everywhere but itself`);
      }
    });
  }
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing measurement');
  return value;
}
