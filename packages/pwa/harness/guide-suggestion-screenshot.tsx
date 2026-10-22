/**
 * Screenshots of the models-guide generator in Settings › Pack: the REVIEW of a suggested guide (routing
 * changed; one use case added, one changed, one removed, one the same; one dropped and one flagged note)
 * at a 390px phone and a 1440px desktop in the light and dark studio themes, plus the Models list and a
 * running builder at the phone in light. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/guide-suggestion-screenshot.tsx    # writes harness/out/guide-suggestion-*.png
 *
 * It renders the REAL `GuideSuggestPanel` and `ModelsPanel` with the test fixtures injected, so nothing
 * reaches a daemon. Like `pack-mode-screenshot.tsx` it drives the system Chrome through playwright-core
 * and aborts every request off the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

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
import { GuideSuggestPanel } from '../../src/features/pack/guide-suggest-panel.tsx';
import { ModelsPanel } from '../../src/features/pack/models-panel.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { ASTRA, FLEET_MODELS, GLM, OPUS, RUNNING_JOB, SONNET, SUGGESTION } from '../../tests/support/pack.ts';

const connection = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'd' });
const never = () => new Promise(() => undefined);
const state = {
  suggest: never, readJob: never, acceptGuide: never, undoGuide: never,
  saveConfig: async () => ({ kind: 'applied' }),
};
const builder = { available: true, runtimes: ['codex-main', 'claude-main'] };
const models = FLEET_MODELS.map(model => {
  if (model.id === OPUS.id) return { ...model, description: 'Deep reasoning for plans, reviews and code that must not break.', describedBy: 'catalog' };
  if (model.id === SONNET.id) return { ...model, description: 'My everyday model: quick, capable and kind to the quota.', describedBy: 'owner' };
  if (model.id === ASTRA.id) return { ...model, description: 'A second family for a second opinion on hard calls.', describedBy: 'catalog' };
  return model;
});
const which = new URLSearchParams(location.search).get('state');
const startedAt = Date.parse(RUNNING_JOB.startedAt);
const panel = (initial, clock) => (
  <GuideSuggestPanel
    connection={connection}
    state={state}
    builder={builder}
    preferences="Prefer cheap models for chores. Never use a model that is not on this machine."
    onEdit={() => undefined}
    pollMs={3_600_000}
    initial={initial}
    {...(clock ? { clock } : {})}
  />
);
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex flex-col gap-4 bg-bg p-4" style={{ maxWidth: 960, margin: '0 auto' }} data-shot="">
    {which === 'models' ? (
      <ModelsPanel models={models} initiallyOpen onDescribe={async () => ({ kind: 'applied', message: 'Saved.' })} />
    ) : which === 'running' ? (
      panel({ job: RUNNING_JOB }, () => startedAt + 192_000)
    ) : (
      panel({ job: { ...RUNNING_JOB, status: 'suggested' }, suggestion: SUGGESTION })
    )}
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg"><div id="root"></div><script type="module" src="/guide-suggestion-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'guide-suggestion-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'guide-suggestion-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
// The generated entry is not part of the program: left in place it would be type-checked.
rmSync(join(outDir, 'guide-suggestion-entry.tsx'));
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'app.css'),
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
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

type Scheme = 'light' | 'dark';
interface Shot {
  readonly state: 'review' | 'models' | 'running';
  readonly viewport: 'mobile' | 'desktop';
  readonly scheme: Scheme;
}
const SHOTS: readonly Shot[] = [
  { state: 'review', viewport: 'mobile', scheme: 'light' },
  { state: 'review', viewport: 'mobile', scheme: 'dark' },
  { state: 'review', viewport: 'desktop', scheme: 'light' },
  { state: 'review', viewport: 'desktop', scheme: 'dark' },
  { state: 'models', viewport: 'mobile', scheme: 'light' },
  { state: 'running', viewport: 'mobile', scheme: 'light' },
];
const WIDTH = { mobile: 390, desktop: 1_440 } as const;

const shotsDir = process.env.GUIDE_SUGGESTION_SHOTS ?? outDir;
mkdirSync(shotsDir, { recursive: true });
const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      viewport: { width: WIDTH[shot.viewport], height: shot.viewport === 'mobile' ? 4_200 : 2_600 },
      colorScheme: shot.scheme,
      reducedMotion: 'reduce',
    });
    try {
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
        return await route.continue();
      });
      const page = await context.newPage();
      await page.goto(`${server.url}?theme=studio-${shot.scheme}&state=${shot.state}`);
      const target = page.locator('[data-shot]');
      await target.waitFor({ state: 'visible' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) fail(`${shot.state} at ${shot.viewport}/${shot.scheme} scrolls sideways by ${overflow}px`);
      const small = await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLElement>(
            '[data-shot] button, [data-shot] a, [data-shot] input[type="checkbox"], [data-shot] label',
          ),
        ]
          .map(element => ({
            label: (element.textContent ?? '').trim().slice(0, 30),
            height: element.getBoundingClientRect().height,
          }))
          .filter(item => item.height > 0 && item.height < 44),
      );
      if (small.length > 0)
        process.stdout.write(`⚠ ${shot.state}/${shot.viewport}: under 44px: ${JSON.stringify(small)}\n`);
      const file = join(shotsDir, `guide-suggestion-${shot.state}-${shot.viewport}-${shot.scheme}.png`);
      // The shell fills the viewport, so the picture is cropped to where the content ends.
      const content = await page.evaluate(() => {
        const last = document.querySelector('[data-shot]')?.lastElementChild;
        return last === null || last === undefined ? 0 : last.getBoundingClientRect().bottom + 16;
      });
      await page.screenshot({
        path: file,
        clip: { x: 0, y: 0, width: WIDTH[shot.viewport], height: Math.ceil(content) },
      });
      process.stdout.write(`📸 ${file}\n`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}
