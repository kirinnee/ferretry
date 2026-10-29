import { describe, it } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { WardenPage, type WardenSurfaceProps } from '../../../src/lib/pages/warden-page.tsx';
import { sharedChromium } from '../support/chromium.ts';

const fixtureCss = String.raw`
  :root {
    color-scheme: dark;
    --bg: #0b0b0d;
    --surface: #141418;
    --surface-2: #1c1c22;
    --fg: #f4f4f5;
    --muted: #a1a1aa;
    --faint: #71717a;
    --border: #303039;
    --accent: #6366f1;
    --accent-soft: #25264a;
    --focus-color: #a5b4fc;
    --gap-sm: 6px;
    --font-display: "Inter var", Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-body: "Inter var", Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    --text-display: 1.15rem;
  }
  * { box-sizing: border-box; }
  html, body, #root { width: 100%; height: 100%; margin: 0; }
  #root { display: flex; flex-direction: column; }
  .flex-1 { flex: 1 1 0%; }
  .overscroll-contain { overscroll-behavior: contain; }
  body {
    overflow: hidden;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-body);
    font-size: 13.5px;
    line-height: 1.45;
  }
  button, input { font: inherit; }
  button, input, a { outline: none; }
  button:focus-visible, input:focus-visible, a:focus-visible {
    outline: 2px solid var(--focus-color);
    outline-offset: 2px;
  }
  .h-full { height: 100%; }
  .min-h-0 { min-height: 0; }
  .w-full { width: 100%; }
  .overflow-y-auto { overflow-y: auto; }
  .pb-4 { padding-bottom: 1rem; }
  .mx-auto { margin-left: auto; margin-right: auto; }
  .flex { display: flex; }
  .max-w-\[980px\] { max-width: 980px; }
  .flex-col { flex-direction: column; }
  .gap-3 { gap: .75rem; }
  .py-2 { padding-top: .5rem; padding-bottom: .5rem; }
  .m-0 { margin: 0; }
  .items-center { align-items: center; }
  .gap-sm { gap: var(--gap-sm); }
  .font-display { font-family: var(--font-display); }
  .text-display { font-size: var(--text-display); }
  .font-bold { font-weight: 700; }
  .tracking-display { letter-spacing: -.015em; }
  .text-accent { color: var(--accent); }
  .mt-0\.5 { margin-top: .125rem; }
  .text-ui { font-size: .875rem; }
  .text-muted { color: var(--muted); }
  .fixture-card {
    margin-inline: max(12px, env(safe-area-inset-left));
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
    padding: 12px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 24%);
  }
  .fixture-card h2 { margin: 0 0 3px; font-size: .9rem; }
  .fixture-card p { margin: 0; color: var(--muted); }
  .fixture-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .fixture-actions input {
    min-width: 0;
    flex: 1 1 220px;
    height: 34px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-2);
    color: var(--fg);
    padding: 0 10px;
  }
  .fixture-actions button, .fixture-actions a {
    min-height: 34px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--surface-2);
    color: var(--fg);
    padding: 7px 11px;
    text-decoration: none;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  .fixture-actions button:hover, .fixture-actions a:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  @media (max-width: 640px) {
    :root { --text-display: 1.375rem; }
    .py-2 { padding-top: 8px; padding-bottom: 8px; }
    .min-w-0 { padding-inline: max(12px, env(safe-area-inset-left)); }
    .fixture-card { border-radius: 8px; }
    .fixture-actions { display: grid; grid-template-columns: 1fr; }
    .fixture-actions input, .fixture-actions button, .fixture-actions a { width: 100%; min-height: 44px; }
  }
`;

const connection = daemonConnection({
  daemonId: 'daemon-visual',
  baseUrl: 'http://127.0.0.1',
  deviceId: 'visual-only-token',
});

/**
 * A deterministic stand-in for the overview: the real body is proved in the unit suites. What this
 * file proves is the page SHELL — one labelled scroll region that owns vertical scrolling, never a
 * sideways scroll, a keyboard order that follows the reading order, and 44px touch targets on a phone.
 */
function OverviewSurface(_: WardenSurfaceProps) {
  return (
    <>
      <section className="fixture-card">
        <h2>Warden</h2>
        <p>Jev guard ≥0.85 · every 2 min · swept 1 min ago</p>
        <div className="fixture-actions">
          <button type="button" data-focus="sweep">
            Sweep now
          </button>
          <a href="#settings" data-focus="settings">
            Settings
          </a>
        </div>
      </section>
      <section className="fixture-card">
        <h2>Recent actions</h2>
        <p>Maryah moved by Jev 96% — restarted its process; its terminal had closed.</p>
        <div className="fixture-actions">
          <button type="button" data-focus="filter" aria-pressed="false">
            Jev
          </button>
          <button type="button" data-focus="toggle" aria-expanded="false">
            Details
          </button>
          <button type="button" data-focus="report" aria-label="Open report">
            Report
          </button>
        </div>
      </section>
    </>
  );
}

const documentFor = (body: string): string => `<!doctype html>
<html data-theme="studio-dark">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${fixtureCss}</style></head>
  <body><div id="root">${body}</div></body>
</html>`;

const targetDocument = documentFor(
  renderToStaticMarkup(<WardenPage connection={connection} slots={{ Overview: OverviewSurface }} />),
);

describe('Warden page visual contract', () => {
  it('should scroll in its own region, never sideways, in reading order and with phone-sized targets', async () => {
    const artifactDirectory = resolve(import.meta.dir, '../../../.artifacts/visual');
    await mkdir(artifactDirectory, { recursive: true });
    const browser = await sharedChromium();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(targetDocument, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    try {
      for (const viewport of [
        { name: 'mobile', width: 390, height: 844 },
        { name: 'desktop', width: 1_440, height: 900 },
      ]) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: 'dark',
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', async route => {
            const requested = new URL(route.request().url());
            if (requested.origin !== server.url.origin) {
              await route.abort();
              return;
            }
            await route.continue();
          });
          const page = await context.newPage();
          await page.goto(server.url.toString());
          const metrics = await page.evaluate<{
            innerWidth: number;
            scrollWidth: number;
            bodyOverflow: string;
            pageOverflowY: string;
            label: string | null;
          }>(
            `({
              innerWidth: window.innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
              bodyOverflow: getComputedStyle(document.body).overflow,
              pageOverflowY: getComputedStyle(document.querySelector('#root > main')).overflowY,
              label: document.querySelector('#root > main').getAttribute('aria-label'),
            })`,
          );
          should(metrics.scrollWidth).be.belowOrEqual(metrics.innerWidth);
          should(metrics.bodyOverflow).equal('hidden');
          should(metrics.pageOverflowY).equal('auto');
          should(metrics.label).equal('Warden');

          await page.screenshot({
            path: resolve(artifactDirectory, `warden-target-${viewport.name}.png`),
            animations: 'disabled',
          });

          const focusOrder: Array<string | null> = [];
          for (let index = 0; index < 5; index += 1) {
            await page.keyboard.press('Tab');
            focusOrder.push(await page.locator(':focus').getAttribute('data-focus'));
          }
          should(focusOrder).deepEqual(['sweep', 'settings', 'filter', 'toggle', 'report']);

          if (viewport.name === 'mobile') {
            const controls = page.locator('button, input, a[data-focus]');
            for (let index = 0; index < (await controls.count()); index += 1) {
              const box = await controls.nth(index).boundingBox();
              if (box === null) throw new Error('a mobile control is not visible');
              should(box.height).be.aboveOrEqual(44);
            }
          } else {
            const sweep = page.locator('[data-focus="sweep"]');
            const sweepBackground = `getComputedStyle(document.querySelector('[data-focus="sweep"]')).backgroundColor`;
            const before = await page.evaluate<string>(sweepBackground);
            await sweep.hover();
            await page.waitForFunction(`${sweepBackground} !== ${JSON.stringify(before)}`);
            const after = await page.evaluate<string>(sweepBackground);
            should(after).not.equal(before);
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
