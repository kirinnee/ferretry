/**
 * Screenshots of the composer's model chip in its three switch states — switching, confirmed and
 * unconfirmed — at a 390px phone and a 1440px desktop, in the light and dark studio themes. Review
 * evidence; nothing compares the PNGs.
 *
 *   bun harness/runtime-switch-screenshot.tsx [out-dir]   # writes runtime-switch-*.png (default harness/out)
 *
 * It renders the REAL `ComposerRuntimeWithKeyboard` and drives it through the same lifecycle a picker
 * body is handed: a switch is submitted, then the observed model either moves (confirmed) or the
 * confirmation bound passes with no evidence (unconfirmed). Like `screenshot.ts` it drives the system
 * Chrome through playwright-core, aborts every request off the loopback origin, and asserts every
 * width fits without sideways scroll.
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
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SessionView } from '@ferretry/protocol';
import { ComposerRuntimeWithKeyboard, type RuntimeSwitchLifecycle } from '../../src/components/composer-runtime.tsx';

const view = (observedModel: string, observedModelAt: string): SessionView =>
  ({
    config: {
      id: 'harness-session',
      name: 'Hadi',
      agent: 'claude-anthropic',
      harness: 'claude',
      cwd: '/work/ferretry',
      model: 'claude-sonnet-5',
      modelHint: 'claude-sonnet-5',
      harnessFlags: [],
      launchReasoningEffort: 'high',
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
    },
    state: { status: 'running', promptReady: true, turnState: 'your-turn', observedModel, observedModelAt },
  }) as unknown as SessionView;

type Outcome = 'pending' | 'confirmed' | 'unconfirmed';

/** One bar, switched once from claude-sonnet-5 toward claude-opus-5-5, ending in the named outcome. */
function SwitchedBar({ outcome }: { readonly outcome: Outcome }) {
  const lifecycle = useRef<RuntimeSwitchLifecycle | undefined>(undefined);
  const [observed, setObserved] = useState({ model: 'claude-sonnet-5', at: '2026-10-18T00:00:00.000Z' });
  useEffect(() => {
    lifecycle.current?.onSwitchSubmitted();
    if (outcome === 'confirmed')
      setTimeout(() => setObserved({ model: 'claude-opus-5-5', at: '2026-10-18T00:00:05.000Z' }), 30);
  }, [outcome]);
  return (
    <ComposerRuntimeWithKeyboard
      busy={false}
      canControl
      keyboardOpen={false}
      presentation="popover"
      renderModelControls={handed => {
        lifecycle.current = handed;
        return null;
      }}
      switchConfirmMs={outcome === 'unconfirmed' ? 20 : 3_600_000}
      view={view(observed.model, observed.at)}
    />
  );
}

const ROWS: readonly { readonly outcome: Outcome; readonly caption: string }[] = [
  { outcome: 'pending', caption: 'Switching — waiting for Claude to confirm' },
  { outcome: 'confirmed', caption: 'Confirmed — Claude answered /model' },
  { outcome: 'unconfirmed', caption: 'Unconfirmed — no answer within the bound' },
];

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col gap-panel bg-bg p-panel"><div className="flex w-full max-w-xl flex-col gap-panel" data-rows="">
    {ROWS.map(row => (
      <section aria-label={row.caption} className="kt-panel flex flex-col gap-1 p-panel" data-row={row.outcome} key={row.outcome}>
        <p className="kt-label m-0">{row.caption}</p>
        <div className="flex min-w-0 items-center border-t border-border-soft pt-1">
          <SwitchedBar outcome={row.outcome} />
        </div>
      </section>
    ))}
  </div></div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/runtime-switch-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'runtime-switch-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'runtime-switch-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1_440, height: 900, touch: false },
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
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        // Each row has reached its outcome: switching stands, confirmed cleared, unconfirmed said so.
        await page.locator('[data-row="pending"] [data-switch-state="pending"]').waitFor({ state: 'visible' });
        await page.locator('[data-row="unconfirmed"] [data-switch-state="unconfirmed"]').waitFor({ state: 'visible' });
        await page.locator('[data-row="confirmed"] [data-switch-state]').waitFor({ state: 'detached' });
        const where = `${viewport.name}/${scheme}`;
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
        const target = join(outDir, `runtime-switch-${viewport.name}-${scheme}.png`);
        const height = await page.evaluate(() =>
          Math.ceil((document.querySelector('[data-rows]')?.getBoundingClientRect().bottom ?? 0) + 16),
        );
        await page.screenshot({
          path: target,
          clip: { x: 0, y: 0, width: viewport.width, height: Math.min(Math.max(height, 200), viewport.height) },
        });
        process.stdout.write(`📸 ${target}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
