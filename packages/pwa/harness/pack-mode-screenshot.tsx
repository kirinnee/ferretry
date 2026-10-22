/**
 * Screenshots of Settings › Pack mode (the switch, who picks the model, the limits and the probe) and
 * of its models guide editor — a known model, one listed but not on this machine, an unknown red one,
 * and the model autocomplete open — at a 390px phone and a 1440px desktop, in the light and dark
 * studio themes. Review evidence for Pack mode; nothing compares the PNGs.
 *
 *   bun harness/pack-mode-screenshot.tsx          # writes harness/out/pack-mode-*.png
 *
 * It renders the REAL `PackSettingsSurface` and `ModelsGuideEditor` with a machine's Pack view
 * injected, so nothing reaches a daemon. Like `voice-cleanup-screenshot.tsx` it drives the system
 * Chrome through playwright-core and aborts every request off the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
import { DEFAULT_PACK_CONFIG } from '@ferretry/protocol';
import { PackSettingsSurface } from '../../src/features/pack/pack-settings.tsx';
import { ModelsGuideEditor } from '../../src/features/pack/models-guide-editor.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const model = (overrides) => ({
  provider: 'anthropic', providerLabel: 'Anthropic', harness: 'claude', tier: 'balanced', efforts: [],
  runtimes: ['claude-main'], ...overrides,
});
const models = [
  model({ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'best', efforts: ['low', 'medium', 'high', 'max'] }),
  model({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: ['low', 'medium', 'high'] }),
  model({ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'fast' }),
  model({ id: '~anthropic/claude-opus-latest', label: 'Opus (latest)', tier: 'best' }),
  model({ provider: 'zai', providerLabel: 'z.ai', id: 'glm-5.3', label: 'GLM-5.3', runtimes: [] }),
  model({ provider: 'openai', providerLabel: 'OpenAI', harness: 'codex', id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'best', efforts: ['medium', 'high', 'xhigh'], runtimes: ['codex-main'] }),
  model({ provider: 'ollama', providerLabel: 'Ollama', id: 'gpt-oss:20b', label: 'gpt-oss 20B', tier: 'fast' }),
  model({ provider: 'deepseek', providerLabel: 'DeepSeek', id: 'deepseek-flash[1m]', label: 'DeepSeek Flash 1M', tier: 'fast', runtimes: [] }),
];
const guide = {
  source: 'file',
  useCases: [
    {
      id: 'hard',
      title: 'Hard planning / review / critical code',
      description: 'Plans, reviews and the code that must not break. Prefer claude-opus-5-5; GLM-5.3 is a good second opinion; never gpt-6-astra-mini.',
      keywords: ['plan', 'review', 'architecture'],
      candidates: [
        { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', why: 'The strongest reasoning here; Claude Sonnet 5 when it is out of quota.' },
        { provider: 'openai', model: 'gpt-6-astra', effort: 'high', why: 'A second family for a second opinion.' },
        { provider: 'zai', model: 'glm-5.3', why: 'Runs on the other box: good and cheap.' },
      ],
    },
    { id: 'everyday', title: 'Everyday coding', description: 'Features and fixes of ordinary size.', candidates: [{ provider: 'anthropic', model: 'claude-sonnet-5', why: 'Quick and capable.' }] },
    { id: 'bulk', title: 'Mechanical bulk edits', description: 'Renames and one-line chores across many files.', candidates: [{ provider: 'anthropic', model: 'claude-haiku-4-5', why: 'Fast and cheap.' }] },
    { id: 'long-context', title: 'Long-context reading', description: 'Whole repositories and long logs.', candidates: [{ provider: 'deepseek', model: 'deepseek-flash[1m]', why: 'A million tokens of context.' }] },
  ],
};
const view = { config: { ...DEFAULT_PACK_CONFIG, decision: 'jev' }, guide, models };
const state = { read: { kind: 'ready', view }, saveConfig: async () => ({ kind: 'applied' }), saveGuide: async () => ({ kind: 'applied' }), suggest: async () => ({ kind: 'refused', message: 'Not under test.' }), readJob: async () => ({ kind: 'failed', message: 'Not under test.' }), acceptGuide: async () => ({ kind: 'refused', message: 'Not under test.' }), undoGuide: async () => ({ kind: 'refused', message: 'Not under test.' }), describeModel: async () => ({ kind: 'refused', message: 'Not under test.' }) };
const which = new URLSearchParams(location.search).get('state');
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex flex-col bg-bg p-4" style={{ maxWidth: 960, margin: '0 auto' }} data-shot="">
    {which === 'guide' ? (
      <ModelsGuideEditor guide={guide} models={models} initiallyOpen={[0]} onSave={async () => ({ kind: 'applied' })} />
    ) : (
      <PackSettingsSurface connection={daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'd' })} state={state} />
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
  { name: 'mobile', width: 390, height: 3_200 },
  { name: 'desktop', width: 1_440, height: 2_400 },
] as const;

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
        for (const state of ['settings', 'guide'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          const shot = page.locator('[data-shot]');
          await shot.waitFor({ state: 'visible' });
          if (state === 'guide') {
            // The autocomplete, open under the first candidate's "why" while a model name is half typed.
            const why = page.locator('textarea[id$="-c1-why"]');
            await why.click();
            await page.keyboard.press('Control+End');
            await page.keyboard.type(' Or cla');
            await page.locator('[data-model-suggestions]').waitFor({ state: 'visible' });
            await page.keyboard.press('ArrowDown');
          }
          // A control wider than a phone would hide its own last words off-screen.
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${state} at ${viewport.name}/${scheme} scrolls sideways by ${overflow}px`);
          const target = join(shotsDir, `pack-mode-${state}-${viewport.name}-${scheme}.png`);
          const box = await shot.boundingBox();
          if (box === null) fail(`${state} at ${viewport.name}/${scheme} has no box`);
          const { x, y, width, height } = box ?? { x: 0, y: 0, width: 0, height: 0 };
          await page.screenshot({ path: target, clip: { x, y, width, height: Math.min(height, viewport.height - y) } });
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
