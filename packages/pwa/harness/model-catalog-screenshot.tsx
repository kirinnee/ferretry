/**
 * Screenshots of the model picker on three logins — an Anthropic sign-in, a GLM / Z.ai login and a
 * DeepSeek login — at a 390px phone and a 1440px desktop, in the light and dark studio themes
 * (docs/model-catalog.md). Review evidence; nothing compares the PNGs.
 *
 *   bun harness/model-catalog-screenshot.tsx [out-dir]   # writes model-catalog-*.png (default harness/out)
 *
 * The lists are the REAL built-in catalogs, run through the fleet library's own `runtimeModels` and
 * restated the way the daemon's runtime-model route restates a published account — so the picture is
 * what a session on that login offers. It renders the REAL `RuntimeModelControls` (the composer chip and
 * Info › Runtime share it) beside `RuntimeEffortControls` for the model in force: a popover on desktop,
 * a sheet body on the phone. Like `screenshot.ts` it drives the system Chrome through playwright-core
 * and aborts every request off the loopback origin; every width — 320px included — is asserted to fit
 * without sideways scroll.
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
import type { SessionView } from '@ferretry/protocol';
import { builtInModelCatalogs } from '../../../fleet/src/lib/models/catalog.ts';
import { runtimeModels } from '../../../fleet/src/lib/models/runtime.ts';
import { RuntimeEffortControls, RuntimeModelControls } from '../../src/components/runtime-controls.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { RuntimeModelCatalog } from '../../src/lib/runtime-models.ts';

const params = new URLSearchParams(location.search);
const provider = params.get('provider') ?? 'anthropic';
const presentation = params.get('presentation') === 'popover' ? 'popover' : 'sheet';
const catalogs = builtInModelCatalogs();
const derived = runtimeModels({ harness: 'claude', modelSet: undefined, catalog: catalogs[provider] });
const catalog: RuntimeModelCatalog = {
  harness: 'claude',
  source: 'wrapper-inventory',
  catalog: { id: provider, label: derived.catalog?.label ?? provider, customIds: derived.catalog?.customIds ?? false },
  choices: derived.models.map(model => ({
    value: model.id,
    label: model.label,
    ...(model.tier === undefined ? {} : { tier: model.tier }),
    ...(model.context === undefined ? {} : { context: model.context }),
    ...(model.id === derived.default ? { isDefault: true } : {}),
    reasoningEfforts: model.efforts.map(value => ({ value })),
    ...(model.defaultEffort === undefined ? {} : { defaultReasoningEffort: model.defaultEffort }),
  })),
};
const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'http://127.0.0.1', deviceId: 'harness' });
const view = {
  config: {
    id: 'harness-session',
    name: 'Hadi',
    agent: 'claude-' + provider,
    harness: 'claude',
    cwd: '/work/ferretry',
    model: derived.default,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  },
  state: { status: 'running', promptReady: true, turnState: 'your-turn', observedModel: derived.default },
} as unknown as SessionView;
const common = {
  api: { runtime: async () => undefined },
  canControl: true,
  catalogs: { load: async () => catalog },
  daemon,
  onClose: () => undefined,
  presentation,
  view,
} as const;
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-wrap items-start gap-panel bg-bg p-panel" data-provider={provider}>
    <section aria-label="Model" className={presentation === 'popover' ? 'kt-panel w-[340px] max-w-full p-1.5' : 'kt-panel w-full p-panel'} data-picker="">
      <p className="kt-label m-0 px-cell-x pb-1">{catalog.catalog?.label} · Model</p>
      <RuntimeModelControls {...common} open={true} />
    </section>
    <section aria-label="Reasoning effort" className={presentation === 'popover' ? 'kt-panel w-[300px] max-w-full p-1.5' : 'kt-panel w-full p-panel'} data-picker="">
      <p className="kt-label m-0 px-cell-x pb-1">Reasoning effort</p>
      <RuntimeEffortControls {...common} />
    </section>
  </div>,
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
  <body><div id="root"></div><script type="module" src="/model-catalog-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'model-catalog-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'model-catalog-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
  { name: 'phone', width: 390, height: 844, touch: true, shoot: true, presentation: 'sheet' },
  { name: 'narrow', width: 320, height: 640, touch: true, shoot: false, presentation: 'sheet' },
  { name: 'desktop', width: 1_440, height: 900, touch: false, shoot: true, presentation: 'popover' },
] as const;
const PROVIDERS = ['anthropic', 'zai', 'deepseek'] as const;

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
        for (const provider of PROVIDERS) {
          await page.goto(
            `${server.url}?theme=studio-${scheme}&provider=${provider}&presentation=${viewport.presentation}`,
          );
          await page.locator('[role="menuitemradio"]').first().waitFor({ state: 'visible' });
          const where = `${provider} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (!viewport.shoot) continue;
          const target = join(outDir, `model-catalog-${provider}-${viewport.name}-${scheme}.png`);
          const height = await page.evaluate(() => document.getElementById('root')?.scrollHeight ?? 0);
          await page.screenshot({
            path: target,
            clip: { x: 0, y: 0, width: viewport.width, height: Math.min(Math.max(height, 200), viewport.height) },
          });
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
