/**
 * Screenshots of Settings › Pack mode: the switch, who picks the model, the limits and the probe, and the
 * ONE routing prompt card — a known model, one listed but not on this machine, an unknown red one, the
 * Available-now list — plus the card with the model autocomplete open and the card reviewing a Clean up
 * rewrite (a word diff and one note of each kind), and the Write it for me states (the first-run nudge,
 * the writer working, a written prompt under review), at a 390px phone and a 1440px desktop, in the light and
 * dark studio themes. Review evidence for Pack mode; nothing compares the PNGs.
 *

 * The `old-daemon` scene is the idea field against a machine whose health lists no features: capped at 500, with the update note.
 *
 *   bun harness/pack-mode-screenshot.tsx          # writes harness/out/pack-mode-*.png
 *
 * It renders the REAL `PackSettingsSurface` and `RoutingPromptCard` with a machine's Pack view injected,
 * so nothing reaches a daemon. Like `voice-cleanup-screenshot.tsx` it drives the system Chrome through
 * playwright-core and aborts every request off the loopback origin.
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
import { PackSettingsSurface } from '../../src/features/pack/pack-settings.tsx';
import { RoutingPromptCard } from '../../src/features/pack/routing-prompt-card.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { ideaLimitFor } from '../../src/lib/pack/routing-prompt.ts';
import { healthOf } from '../../tests/support/health.ts';
import {
  FLEET_MODELS,
  NUDGE_VIEW,
  OWNER_VIEW,
  RUNNING_JOB,
  SUGGESTION,
  WRITING_JOB,
  WRITTEN_SUGGESTION,
} from '../../tests/support/pack.ts';

const connection = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'd' });
const prompt = [
  'Planning, review and critical code → claude-opus-5-5 at max; gpt-6-astra high for a second opinion.',
  'Everyday edits → claude-sonnet-5.',
  'Chores and renames → claude-haiku-4-5 low, or glm-5.3 on the other box. Never gpt-6-astra-mini.',
].join('\\n');
const AVAILABLE = OWNER_VIEW.available;
const SONNET = FLEET_MODELS[1];
const available = [
  AVAILABLE[0],
  AVAILABLE[1],
  {
    provider: 'anthropic', model: SONNET.id, modelLabel: SONNET.label, harness: 'claude', tier: 'balanced',
    efforts: [], runtime: 'claude-main', runtimes: 1, ready: true, named: 3,
    quota: { state: 'some', leftPercent: 34, windows: [], summary: '5h 66% · week 40%' },
  },
  AVAILABLE[2],
];
const view = {
  ...OWNER_VIEW,
  routing: {
    text: prompt,
    source: 'file',
    suggested: { by: 'gpt-6-astra', via: 'codex-main', at: '2026-10-22T14:30:00.000Z', acceptedAt: '2026-10-22T14:31:00.000Z' },
  },
  available,
  undo: { savedAt: '2026-10-22T14:31:00.000Z', source: 'file' },
};
const never = () => new Promise(() => undefined);
const routingState = { savePrompt: never, cleanUp: never, readJob: never, accept: never, undo: never };
const state = { read: { kind: 'ready', view }, saveConfig: async () => ({ kind: 'applied' }), ...routingState };
const which = new URLSearchParams(location.search).get('state');
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
const reviewView = { ...view, routing: { text: SUGGESTION.before, source: 'file' }, undo: undefined };
const nudgeView = { ...NUDGE_VIEW, routing: { text: '', source: 'default' }, undo: undefined };
createRoot(root).render(
  <div className="flex flex-col bg-bg p-4 text-fg" style={{ maxWidth: 960, margin: '0 auto' }} data-shot="">
    {which === 'settings' ? (
      <PackSettingsSurface connection={connection} state={state} />
    ) : which === 'review' ? (
      <RoutingPromptCard
        connection={connection}
        view={reviewView}
        state={routingState}
        initial={{ job: { ...RUNNING_JOB, status: 'suggested' }, suggestion: SUGGESTION }}
      />
    ) : which === 'old-daemon' ? (
      <RoutingPromptCard
        connection={connection}
        view={nudgeView}
        state={routingState}
        ideaLimit={ideaLimitFor({ kind: 'read', health: healthOf('4.84.0') })}
      />
    ) : which === 'nudge' ? (
      <RoutingPromptCard connection={connection} view={nudgeView} state={routingState} />
    ) : which === 'writing' ? (
      <RoutingPromptCard
        connection={connection}
        view={nudgeView}
        state={routingState}
        clock={() => Date.parse(WRITING_JOB.startedAt) + 31_000}
        initial={{ job: WRITING_JOB }}
      />
    ) : which === 'written' ? (
      <RoutingPromptCard
        connection={connection}
        view={nudgeView}
        state={routingState}
        initial={{ job: { ...WRITING_JOB, status: 'suggested' }, suggestion: WRITTEN_SUGGESTION }}
      />
    ) : which === 'running' ? (
      <RoutingPromptCard
        connection={connection}
        view={reviewView}
        state={routingState}
        clock={() => Date.parse(RUNNING_JOB.startedAt) + 47_000}
        initial={{ job: RUNNING_JOB }}
      />
    ) : (
      <RoutingPromptCard connection={connection} view={view} state={routingState} />
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
  <body class="bg-bg"><div id="root"></div><script type="module" src="/pack-mode-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'pack-mode-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'pack-mode-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
// The entry is bundled now; left behind, the workspace typecheck would check an untyped scratch file.
rmSync(join(outDir, 'pack-mode-entry.tsx'));
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

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;

const SCENES = ['settings', 'autocomplete', 'review', 'running', 'nudge', 'old-daemon', 'writing', 'written'] as const;

const shotsDir = process.env.PACK_MODE_SHOTS ?? outDir;
mkdirSync(shotsDir, { recursive: true });
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
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        for (const scene of SCENES) {
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${scene}`);
          const shot = page.locator('[data-shot]');
          await shot.waitFor({ state: 'visible' });
          if (scene === 'old-daemon') {
            // An older machine: 460 characters typed against the 500 it still takes, with the update note under the field.
            await page.locator('[data-routing-idea]').fill('Cheap models for chores, Opus for planning. '.repeat(11));
          }
          if (scene === 'autocomplete') {
            // The autocomplete, open at the end of the prompt while a model name is half typed.
            const field = page.locator('[data-routing-card] textarea:not([data-routing-idea])');
            await field.click();
            await page.keyboard.press('Control+End');
            await page.keyboard.type(' Docs → cla');
            await page.locator('[data-model-suggestions]').waitFor({ state: 'visible' });
            await page.keyboard.press('ArrowDown');
          }
          // A control wider than a phone would hide its own last words off-screen.
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scene} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `pack-mode-${scene}-${viewport.name}-${scheme}.png`);
          // The whole scene in one capture: the page grows to fit it, at the same width.
          const tall = await shot.evaluate(element => Math.ceil(element.getBoundingClientRect().bottom));
          await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, tall) });
          const box = (await shot.boundingBox()) ?? fail(`${scene} at ${viewport.name}/${scheme} has no box`);
          await page.screenshot({ path: target, clip: box });
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
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
