/**
 * New machine setup's Claude Code step before and after an import: the "what changed" line collapsed and
 * open, the one-line import result, and the one-choice "Import conversations" — on a phone and a desktop,
 * light and dark.
 *
 *   bun harness/setup-import-screenshot.tsx      # writes harness/out/setup-import-*.png
 *
 * It renders the REAL `OnboardingHarnessStep` against a fake machine (the suites' own fixtures, invented
 * skills and conversations). It fails if the step scrolls sideways at 390px.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

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
import { OnboardingHarnessStep } from '../../src/features/fleet/setup/harness-step.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { PROVIDERS } from '../../tests/unit/features/fleet/credentials/environment-support.ts';
import { machineAnswer, credentials, runtimes, runtimeView, scan } from '../../tests/unit/features/fleet/setup/setup-support.ts';

const SKILLS = ['agents-sdk', 'pr-review', 'release-notes', 'frontend-design', 'security-review', 'simplify', 'loop', 'schedule', 'init', 'run', 'update-config', 'claude-api', 'code-review'];
const base = scan();
const SCAN = scan({
  harnesses: [
    { ...base.harnesses[0], skills: SKILLS, mcpServers: ['github', 'linear', 'slack'], account: { state: 'signed-in', email: 'you@example.com' } },
    base.harnesses[1],
  ],
  updates: [
    { reference: 'mcp/slack', sources: ['/home/you/.claude.json'] },
    { reference: 'skills/skills', sources: SKILLS.flatMap(name => ['/home/you/.claude/skills/' + name, '/home/you/.codex/skills/' + name]) },
  ],
  notes: [
    { harness: 'claude', text: 'Your Codex skill "agents-sdk" differs from the Claude Code one, so it was kept separately as "agents-sdk-codex".' },
    { harness: 'claude', text: 'slack needs uvx: install uv on studio-mac and it starts working.' },
  ],
});
const DAY = 86_400_000;
const ROWS = [0.2, 0.6, 1.5, 2, 2.5, 4, 5, 6, 9, 12, 13, 20, 25, 40, 60, 90].map((days, index) => ({
  id: 'c' + index, harness: 'claude', project: '/work/shop', preview: 'Conversation ' + index,
  lastActivityAt: new Date(Date.now() - days * DAY).toISOString(), turns: 3,
}));
let imported = new URLSearchParams(location.search).get('state') === 'imported';
let kept = false;
const client = {
  request: async (path, schema, init) => {
    const answers = {
      '/v1/fleet/machine': machineAnswer(),
      '/v1/fleet/setup/scan': SCAN,
      '/v1/fleet/runtimes': runtimes(imported ? [runtimeView('claude-default')] : []),
      '/v1/fleet/credentials': credentials([]),
      '/v1/fleet/profiles': { format: 'version-2', profiles: [] },
      '/v1/fleet/presets': PROVIDERS,
      '/v1/secrets': { v: 1, health: 'ready', secrets: [], references: [] },
    };
    if (path === '/v1/fleet/proposals') return schema.parse({ id: 'fy_fprop_abcdefghijklmnopqrstuv', revision: 'absent', change: JSON.parse(init.body).change, summary: 'A change', consequences: [], expiresAt: '2030-01-01T00:00:00.000Z', state: 'pending', preview: { kind: 'executor', executor: 'setup', description: 'A change.' } });
    if (path.endsWith('/apply')) { imported = true; return schema.parse({ outcome: 'executed', executor: 'setup', summary: 'studio-mac is ready' }); }
    if (path.startsWith('/v1/imports/conversations/adopt')) {
      kept = true;
      const body = JSON.parse(init.body);
      return schema.parse({ adopted: body.conversations.map(item => ({ id: item.id, session: 's-' + item.id, name: 'ferret-' + item.id, status: 'stopped' })), refused: [] });
    }
    if (path.startsWith('/v1/imports/conversations')) return schema.parse({ conversations: kept ? ROWS.map(row => ({ ...row, adoptedBy: 'ferret-' + row.id })) : ROWS, matched: ROWS.length, skipped: 0 });
    if (path in answers) return schema.parse(answers[path]);
    throw new Error('no route ' + path);
  },
};
const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 't' });
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px' }}>
    <OnboardingHarnessStep
      tab={{ connection, machineName: 'studio-mac', machine: machineAnswer(), online: true, checking: false, onRetry: () => undefined, createClient: async () => client }}
      harness="claude"
      answers={{}}
      onAnswers={() => undefined}
      onReady={() => undefined}
    />
  </main>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/setup-import-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'setup-import-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'setup-import-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

const shot = async (page: Page, name: string, theme: string, vp: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${name} ${theme} ${vp} scrolls sideways by ${overflow}px`);
  const file = `setup-import-${name}-${theme}-${vp}.png`;
  await page.screenshot({ path: join(outDir, file), fullPage: true });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

const choose = async (page: Page, value: string): Promise<void> => {
  await page.locator('[data-conversation-window]').selectOption(value);
};

try {
  for (const theme of ['studio-light', 'studio-dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === 'phone' ? 2 : 1,
        colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=${theme}`);
        await page.locator('[data-harness-changed]').waitFor({ state: 'visible' });
        await shot(page, 'before-collapsed', theme, vp);
        await page.locator('[data-setup-disclosure="changed-list"] summary').click();
        await shot(page, 'before-changed-open', theme, vp);
        await page.locator('[data-change-submit]').click();
        await page.locator('[data-harness-imported]').waitFor({ state: 'visible' });
        await page.locator('[data-conversation-window]').waitFor({ state: 'visible' });
        await shot(page, 'after-import', theme, vp);
        await choose(page, '7');
        await shot(page, 'after-conversations-chosen', theme, vp);
        await page.locator('[data-conversations-import]').click();
        await page.locator('[data-conversations-result]').waitFor({ state: 'visible' });
        await shot(page, 'after-conversations-imported', theme, vp);
        await page.locator('[data-setup-disclosure="import-details"] summary').click();
        await shot(page, 'after-details-open', theme, vp);
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ the setup step does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
