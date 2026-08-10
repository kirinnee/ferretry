import { describe, it } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ShieldCheck } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  type WardenConfigurationProps,
  WardenPage,
  type WardenPageSlots,
  type WardenSurfaceProps,
} from '../../../src/lib/pages/warden-page.tsx';
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
  deviceToken: 'visual-only-token',
});

function AttentionSurface(_: WardenSurfaceProps) {
  return (
    <section className="fixture-card">
      <h2>Who needs you</h2>
      <p>One agent needs a decision before it can continue.</p>
      <div className="fixture-actions">
        <button type="button" data-focus="attention">
          Review request
        </button>
      </div>
    </section>
  );
}

function StatusSurface(_: WardenSurfaceProps) {
  return (
    <section className="fixture-card">
      <h2>Sweeps</h2>
      <p>Last sweep completed just now · no stalled sessions.</p>
      <div className="fixture-actions">
        <button type="button" data-focus="refresh">
          Run sweep
        </button>
      </div>
    </section>
  );
}

function ConfigurationSurface({ id }: WardenConfigurationProps) {
  return (
    <section id={id} className="fixture-card">
      <h2>Failover configuration</h2>
      <p>Choose the account used when an agent reaches its quota.</p>
      <div className="fixture-actions">
        <input aria-label="Fallback account" data-focus="account" defaultValue="claude-auto-loge5" />
        <button type="button" data-focus="save">
          Save configuration
        </button>
      </div>
    </section>
  );
}

function VerdictsSurface(_: WardenSurfaceProps) {
  return (
    <section className="fixture-card">
      <h2>Recent verdicts</h2>
      <p>LEAVE · healthy progress confirmed · 2 minutes ago.</p>
      <div className="fixture-actions">
        <a href="#config" data-focus="verdict">
          View configuration
        </a>
      </div>
    </section>
  );
}

const slots: WardenPageSlots = {
  Attention: AttentionSurface,
  Status: StatusSurface,
  Configuration: ConfigurationSurface,
  Verdicts: VerdictsSurface,
};

/** Verbatim route-shell structure from the legacy Warden page, with deterministic surfaces. */
function OriginalWardenReference() {
  return (
    <div className="h-full min-h-0 w-full overflow-y-auto scroll-thin pb-4">
      <div className="mx-auto flex w-full max-w-[980px] flex-col gap-3 py-2">
        <div className="min-w-0">
          <h1 className="m-0 flex items-center gap-sm font-display text-display font-bold tracking-display">
            <ShieldCheck size={20} className="text-accent" aria-hidden="true" />
            Warden
          </h1>
          <p className="mt-0.5 text-ui text-muted">Who needs you, then sweeps, accounts, and recent verdicts.</p>
        </div>
        <AttentionSurface connection={connection} />
        <StatusSurface connection={connection} />
        <ConfigurationSurface id="config" connection={connection} />
        <VerdictsSurface connection={connection} />
      </div>
    </div>
  );
}

const documentFor = (body: string): string => `<!doctype html>
<html data-theme="studio-dark">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${fixtureCss}</style></head>
  <body><div id="root">${body}</div></body>
</html>`;

const targetDocument = documentFor(renderToStaticMarkup(<WardenPage connection={connection} slots={slots} />));
const referenceDocument = documentFor(renderToStaticMarkup(<OriginalWardenReference />));

describe('Warden page visual contract', () => {
  it('should match the original shell at mobile and desktop viewports', async () => {
    const artifactDirectory = resolve(import.meta.dir, '../../../.artifacts/visual');
    await mkdir(artifactDirectory, { recursive: true });
    const browser = await sharedChromium();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const body = path === '/reference' ? referenceDocument : targetDocument;
        return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      },
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
          await page.goto(new URL('/target', server.url).toString());
          const metrics = await page.evaluate<{
            innerWidth: number;
            scrollWidth: number;
            bodyOverflow: string;
            pageOverflowY: string;
          }>(
            `({
              innerWidth: window.innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
              bodyOverflow: getComputedStyle(document.body).overflow,
              pageOverflowY: getComputedStyle(document.querySelector('#root > div')).overflowY,
            })`,
          );
          should(metrics.scrollWidth).be.belowOrEqual(metrics.innerWidth);
          should(metrics.bodyOverflow).equal('hidden');
          should(metrics.pageOverflowY).equal('auto');

          const target = await page.screenshot({
            path: resolve(artifactDirectory, `warden-target-${viewport.name}.png`),
            animations: 'disabled',
          });

          const focusOrder: Array<string | null> = [];
          for (let index = 0; index < 5; index += 1) {
            await page.keyboard.press('Tab');
            focusOrder.push(await page.locator(':focus').getAttribute('data-focus'));
          }
          should(focusOrder).deepEqual(['attention', 'refresh', 'account', 'save', 'verdict']);

          if (viewport.name === 'mobile') {
            const controls = page.locator('button, input, a[data-focus]');
            for (let index = 0; index < (await controls.count()); index += 1) {
              const box = await controls.nth(index).boundingBox();
              if (box === null) throw new Error('a mobile control is not visible');
              should(box.height).be.aboveOrEqual(44);
            }
          } else {
            const save = page.locator('[data-focus="save"]');
            const saveBackground = `getComputedStyle(document.querySelector('[data-focus="save"]')).backgroundColor`;
            const before = await page.evaluate<string>(saveBackground);
            await save.hover();
            await page.waitForFunction(`${saveBackground} !== ${JSON.stringify(before)}`);
            const after = await page.evaluate<string>(saveBackground);
            should(after).not.equal(before);
          }

          await page.goto(new URL('/reference', server.url).toString());
          const reference = await page.screenshot({
            path: resolve(artifactDirectory, `warden-reference-${viewport.name}.png`),
            animations: 'disabled',
          });
          should(target.equals(reference)).be.true();
        } finally {
          await context.close();
        }
      }
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
