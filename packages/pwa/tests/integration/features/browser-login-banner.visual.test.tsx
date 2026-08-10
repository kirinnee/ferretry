/** Pixel comparison against the original BrowserLoginBanner JSX at phone and desktop widths. */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChevronDown, Copy, KeyRound } from 'lucide-react';
import type { Browser } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { BrowserLoginBanner, type BrowserLoginView } from '../../../src/features/browser/browser-login-banner.tsx';
import { sharedChromium } from '../support/chromium.ts';

const packageDir = resolve(import.meta.dir, '../../..');
const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const login: BrowserLoginView = {
  state: 'open',
  profilePrimed: false,
  expiresAt: '2026-07-31T12:02:00.000Z',
  connection: {
    host: '127.0.0.1',
    port: 5951,
    password: 'temporary-password',
    sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 reader@example.test',
  },
};

/** Verbatim initial (closed-menu) markup from kteam BrowserLoginBanner. */
function OriginalBrowserLoginBanner() {
  if (login.state !== 'open') throw new Error('visual fixture must be open');
  const connection = login.connection;
  if (connection === undefined) throw new Error('visual fixture requires connection details');
  return (
    <aside
      className="shrink-0 border-b border-warn/30 bg-warn-soft px-panel py-1.5 text-ui text-warn"
      aria-label="Browser login window"
    >
      <div className="flex min-w-0 items-center gap-xs">
        <KeyRound size={15} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">Browser login window open · closes in 2:00</span>
        <button
          type="button"
          className="kt-btn kt-btn--sm min-h-[32px] shrink-0 border-warn/40 bg-surface px-2 text-warn hover:text-fg"
          aria-expanded={false}
        >
          Close <ChevronDown size={13} aria-hidden="true" />
        </button>
      </div>
      <details className="mt-1 border-t border-warn/30 pt-1 text-fg">
        <summary className="cursor-pointer select-none text-meta font-medium text-warn">Connection details</summary>
        <div className="mt-1 max-h-36 overflow-auto rounded-control border border-warn/30 bg-surface px-2 py-1">
          {[
            ['VNC', `${connection.host}:${connection.port}`],
            ['Password', connection.password],
            ['SSH', connection.sshTunnel],
          ].map(([label, value]) => (
            <div key={label} className="grid min-w-max grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-xs py-1">
              <span className="font-medium text-muted">{label}</span>
              <code className="select-all font-mono text-meta text-fg">{value}</code>
              <button type="button" data-variant="ghost" className="kt-btn kt-btn--sm min-h-[32px] px-2">
                <Copy size={13} aria-hidden="true" />
                <span>Copy</span>
              </button>
            </div>
          ))}
        </div>
      </details>
    </aside>
  );
}

const documentFor = (css: string, port: string, reference: string): string => `<!doctype html>
<html data-theme="studio-dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style><style>.vis-pane { position:absolute; inset:0 0 auto 0; } .vis-hidden { display:none; }</style></head>
<body><div id="root" class="relative p-panel"><div class="vis-pane" id="port">${port}</div><div class="vis-pane vis-hidden" id="reference">${reference}</div></div></body></html>`;

const reveal = (id: string): string =>
  `(() => { for (const pane of document.querySelectorAll('.vis-pane')) pane.classList.toggle('vis-hidden', pane.id !== ${JSON.stringify(id)}); return true; })()`;
const viewports = [
  { width: 390, height: 844 },
  { width: 1_440, height: 900 },
] as const;

let browser: Browser;
let workspace = '';
let css = '';

describe('BrowserLoginBanner visual contract', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    workspace = await mkdtemp(join(tmpdir(), 'fy-browser-login-visual-'));
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
  }, 120_000);

  afterAll(async () => {
    if (workspace !== '') await rm(workspace, { recursive: true, force: true });
  });

  it('matches the original at both responsive viewports without horizontal overflow', async () => {
    const pageHtml = documentFor(
      css,
      renderToStaticMarkup(
        <BrowserLoginBanner
          status={login}
          now={NOW}
          onClose={async () => ({ state: 'closed', profilePrimed: false })}
        />,
      ),
      renderToStaticMarkup(<OriginalBrowserLoginBanner />),
    );
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(pageHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    try {
      for (const viewport of viewports) {
        const context = await browser.newContext({
          viewport,
          colorScheme: 'dark',
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) return route.abort();
            return route.continue();
          });
          const page = await context.newPage();
          await page.goto(server.url.toString());
          await page.evaluate<boolean>(reveal('port'));
          const metrics = await page.evaluate<{ inner: number; scroll: number }>(
            '({ inner: innerWidth, scroll: document.documentElement.scrollWidth })',
          );
          should(metrics.scroll).be.belowOrEqual(metrics.inner);
          const port = await page.locator('#port').screenshot({ animations: 'disabled' });
          await page.evaluate<boolean>(reveal('reference'));
          const reference = await page.locator('#reference').screenshot({ animations: 'disabled' });
          should(port.equals(reference)).be.true();
        } finally {
          await context.close();
        }
      }
    } finally {
      server.stop(true);
    }
  }, 120_000);
});
