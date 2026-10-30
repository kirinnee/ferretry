/**
 * Screenshots of an agenda card that confirms a held configuration change (docs/agenda.md § Confirming a
 * configuration change) — Allow, Deny and Discard change under the change itself — at a 390px phone and a
 * 1440px desktop, light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/allow-confirm-screenshot.tsx [out-dir]   # writes allow-confirm-*.png (default harness/out)
 *
 * It renders the REAL `AttentionCard` with `AttentionConfigChange` spliced in at the top of the card's
 * scroll by a build plugin, which stands in for the one-line wiring the agenda v2 card adds; the item is the
 * one `fy agenda add --confirms warden.yaml` raises (the daemon's own ask, answers and premise). Two states:
 * the change as raised, and the card restated after the file was edited. Every width — 320px included — is
 * asserted to fit without sideways scroll. Like `approval-card-screenshot.tsx` it drives the system Chrome
 * through playwright-core and aborts every request off the loopback origin.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import type { AttentionItem } from '@ferretry/protocol';
import { AttentionCard } from '../../src/features/attention/attention-card.tsx';

const NOW = Date.parse('2026-10-30T09:00:00.000Z');
const PRICE = 'the Jev price the cap counts with goes down from 2 to 0.042';
const allow = { label: 'Allow', description: 'Apply this change to warden.yaml now' };
const deny = { label: 'Deny', description: 'Keep it held: nothing changes, nothing is lost' };
const discard = { label: 'Discard change', description: 'Put warden.yaml back to the version in effect' };
const item = (restated: boolean): AttentionItem => ({
  id: 'A47',
  source: 'agent-raised',
  sourceRef: null,
  title: 'Jev price correction',
  subject: 'Allow the corrected Jev price in warden.yaml?',
  why: 'The daily Jev cap counts with a price 50 times too high.',
  howToResolve: 'Allow, Deny or Discard change',
  waitingSince: new Date(NOW - 6 * 60_000).toISOString(),
  kind: 'choice',
  ask: { kind: 'multiple-choice', options: [allow, deny, discard] },
  answers: [
    { direction: 'right', does: 'choose', ...allow },
    { direction: 'left', does: 'choose', ...deny },
    { direction: 'up', does: 'choose', ...discard },
  ],
  premise: '- ' + PRICE + '\\n- Allow applies this change to warden.yaml.',
  confirms: {
    path: 'warden.yaml',
    etag: 'a'.repeat(64),
    changes: restated ? [PRICE, 'the daily Jev cap in dollars goes up from 1 to 2'] : [PRICE],
    ...(restated ? { restated: true } : {}),
  },
  raisedBy: 'agent',
  raisedBySession: 'mvu8ndqh-c9707612',
  raisedByName: 'franklin',
});
const restated = new URLSearchParams(location.search).get('state') === 'restated';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full justify-center bg-bg p-4">
    <div className="w-full" style={{ maxWidth: 560 }}>
      <AttentionCard item={item(restated)} now={NOW} onAct={() => undefined} swipeHints />
    </div>
  </div>,
);
`;

/** The one-line wiring the agenda v2 card adds, spliced in for the capture: the change, first in the card. */
const SCROLL = '<div className="fy-attn-card__scroll" data-attention-scroll="">';
const wiring = {
  name: 'allow-confirm-wiring',
  setup(build: Bun.PluginBuilder) {
    build.onLoad({ filter: /attention-card\.tsx$/u }, async args => {
      const text = await Bun.file(args.path).text();
      if (!text.includes(SCROLL)) fail('the card has no scroll to put the change in');
      return {
        loader: 'tsx',
        contents: `import { AttentionConfigChange } from './attention-config-change.tsx';\n${text.replace(
          SCROLL,
          `${SCROLL}\n<AttentionConfigChange item={item} />`,
        )}`,
      };
    });
  },
};

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/allow-confirm-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'allow-confirm-entry.tsx'), PAGE_ENTRY);
const built = await Bun.build({
  entrypoints: [join(buildDir, 'allow-confirm-entry.tsx')],
  outdir: buildDir,
  target: 'browser',
  plugins: [wiring],
});
if (!built.success) fail(built.logs.map(String).join('\n'));
const css = spawnSync(
  './node_modules/.bin/tailwindcss',
  ['--config', 'tailwind.config.ts', '--input', 'src/styles/index.css', '--output', join(buildDir, 'app.css')],
  { cwd: packageDir, stdio: 'inherit' },
);
if (css.status !== 0) fail('tailwindcss failed');

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
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, touch: true, shoot: true },
  { name: 'narrow', width: 320, height: 640, touch: true, shoot: false },
  { name: 'desktop', width: 1_440, height: 900, touch: false, shoot: true },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
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
        for (const state of ['raised', 'restated'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          const change = page.locator('[data-attention-confirms]');
          await change.waitFor({ state: 'visible' });
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (!viewport.shoot) continue;
          const target = join(outDir, `allow-confirm-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
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
