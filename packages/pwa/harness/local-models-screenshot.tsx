/**
 * Ollama's detected models on the two surfaces that show them — Add a login's provider tile and form,
 * and the model picker — in three states (models found, Ollama not running, no model pulled), at a 390px
 * phone and a 1440px desktop, light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/local-models-screenshot.tsx [out-dir]   # writes local-models-<surface>-<state>-<vp>-<theme>.png
 *
 * It renders the REAL `EnvironmentLogin` (with the preset list the harness's set-up machine answers) and
 * the REAL `ModelSelect`, fed by the fleet library's own `runtimeModels` over the built-in Ollama catalog
 * — so the picker lists exactly what the daemon's fleet route would. The daemon is a fake that answers
 * `POST /v1/models/local/refresh` with the state under test; nothing touches a network (every request off
 * the loopback origin is aborted). It fails if any surface scrolls sideways, or if a control a thumb has
 * to press is under 44px on the phone.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

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
import { builtInModelCatalogs } from '../../../fleet/src/lib/models/catalog.ts';
import { runtimeModels } from '../../../fleet/src/lib/models/runtime.ts';
import { ModelSelect } from '../../src/components/model-select.tsx';
import { EnvironmentLogin } from '../../src/features/fleet/credentials/environment-login.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { localModelsFixture } from '../../tests/support/local-models.ts';
import { harnessCredentialAnswer } from '../credential-catalog.ts';

const params = new URLSearchParams(location.search);
const surface = params.get('surface') ?? 'tile';
const state = params.get('state') ?? 'found';
const local = localModelsFixture(state);
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

if (surface === 'picker') {
  const derived = runtimeModels({ harness: 'codex', modelSet: undefined, catalog: builtInModelCatalogs().ollama, local });
  const models = derived.models.map(model => ({
    id: model.id,
    label: model.label,
    available: model.available,
    ...(model.tier === undefined ? {} : { tier: model.tier }),
    ...(model.context === undefined ? {} : { context: model.context }),
    efforts: model.efforts,
    ...(model.local === true ? { local: true } : {}),
  }));
  const field = (kind) => (
    <div className="flex min-w-0 flex-col gap-1.5" data-picker={kind}>
      <label className="text-ui font-semibold text-fg" htmlFor={'model-' + kind}>
        Model override <span className="text-meta font-normal text-faint">blank = account default</span>
      </label>
      <ModelSelect
        customIds={true}
        defaultModel={derived.default ?? null}
        id={'model-' + kind}
        local={local}
        models={models}
        onChange={() => undefined}
        value=""
      />
    </div>
  );
  createRoot(root).render(
    <main data-fixture="" className="mx-auto flex max-w-[440px] flex-col gap-6 p-4">
      <p className="m-0 text-meta text-muted">Ollama (local) · new session</p>
      {field('closed')}
      <p className="m-0 text-meta text-muted">The options it lists</p>
      {field('open')}
    </main>,
  );
} else {
  const client = {
    request: async (path, schema, init) => {
      if (path === '/v1/models/local/refresh' && init?.method === 'POST') return schema.parse(local);
      const answer = harnessCredentialAnswer(path, init);
      if (answer === undefined) throw new Error('no route ' + path);
      return schema.parse(answer);
    },
  };
  const changes = {
    authority: null, busy: false, refusal: null,
    apply: async () => ({ kind: 'refused' }), stage: async () => ({ kind: 'refused' }), applyStaged: async () => ({ kind: 'refused' }),
    clear: () => undefined, refuse: () => undefined,
  };
  createRoot(root).render(
    <main data-fixture="" className="mx-auto max-w-[720px] p-4">
      <EnvironmentLogin
        machineName="studio-mac"
        connection={daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 't' })}
        createClient={async () => client}
        data={null}
        reload={async () => null}
        changes={changes}
        onAdded={() => undefined}
      />
    </main>,
  );
}
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/local-models-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'local-models-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'local-models-entry.jsx'), '--outdir', buildDir, '--target', 'browser']);
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
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const VIEWPORTS = {
  '390': { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  '1440': { viewport: { width: 1440, height: 900 } },
} as const;
const STATES = ['found', 'not-running', 'none-pulled'] as const;
const SURFACES = ['tile', 'form', 'picker'] as const;

/** Every control a thumb presses, with the ones under 44px (a label's own box counts for its input). */
const smallTargets = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('main button, main select, main a[href]')]
      .filter(element => element.getClientRects().length > 0 && element.closest('.hidden') === null)
      .map(element => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.height < 43.5 && box.width < 43.5)
      .map(
        ({ element, box }) =>
          `${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`,
      ),
  );

try {
  for (const theme of ['light', 'dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === '390' ? 2 : 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        for (const surface of SURFACES) {
          for (const state of STATES) {
            const page = await context.newPage();
            const where = `${surface}/${state} at ${vp}/${theme}`;
            await page.goto(`${server.url}?theme=studio-${theme}&surface=${surface}&state=${state}`);
            if (surface === 'picker') {
              await page.locator('[data-picker="open"] select').waitFor({ state: 'visible' });
              await page.evaluate(() => {
                const select = document.querySelector<HTMLSelectElement>('[data-picker="open"] select');
                if (select === null) return;
                const list = document.createElement('ul');
                list.setAttribute('data-option-texts', '');
                list.className =
                  'm-0 flex list-none flex-col gap-1 rounded-control border border-border-strong p-2 text-cell text-fg';
                for (const option of select.options) {
                  const item = document.createElement('li');
                  item.textContent = option.textContent;
                  item.className = 'break-words';
                  list.append(item);
                }
                select.replaceWith(list);
              });
            } else {
              await page
                .locator('[data-provider-tile="ollama-codex"] [data-provider-tile-local]:not(:empty)')
                .waitFor({ state: 'visible' });
              await page.waitForFunction(
                () => !document.querySelector('[data-provider-tile-local]')?.textContent?.includes('Checking'),
              );
              if (surface === 'form') {
                await page.locator('[data-provider-tile="ollama-codex"]').click();
                await page.locator('[data-local-models-panel]').waitFor({ state: 'visible' });
                await page.waitForFunction(
                  () => !document.querySelector('[data-local-models-state]')?.textContent?.includes('Checking'),
                );
              } else {
                await page.locator('[data-provider-tile="ollama-codex"]').scrollIntoViewIfNeeded();
              }
            }
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
            if (vp === '390') {
              const small = await smallTargets(page);
              // A tile is a full-width card; only a control a thumb must hit on its own is held to 44px.
              if (small.length > 0) fail(`${where} has controls under 44px: ${small.join('; ')}`);
            }
            const file = join(outDir, `local-models-${surface}-${state}-${vp}-${theme}.png`);
            await page.locator('main').screenshot({ path: file });
            process.stdout.write(`📸 ${file}\n`);
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ no surface scrolls sideways; every phone control is at least 44px\n');
} finally {
  await browser.close();
  server.stop();
}
