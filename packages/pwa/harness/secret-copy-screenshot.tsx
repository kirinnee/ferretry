/**
 * Copying secrets between machines (docs/secrets.md): on a NEW machine's setup, "Copy secrets from
 * studio…" → pick → the passkey prompt the SENDING machine raises → "3 secrets copied"; and Settings ›
 * Secrets › "Copy to another machine…". On a phone and a desktop, light and dark.
 *
 *   bun harness/secret-copy-screenshot.tsx      # writes harness/out/secret-copy-*.png
 *
 * It renders the REAL `CloneNeedsList`, `SecretCopyPanel`, `SecretsSurface` and passkey `StepUpDialog`
 * against two invented machines. No value exists anywhere in it: the fake machines answer names, a fake
 * offer and a fake bundle, and the passkey ceremony is a stub that resolves. It fails if any frame
 * scrolls sideways.
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
import { CloneNeedsList } from '../../src/features/fleet/setup/clone-settings.tsx';
import { SecretCopyLauncher } from '../../src/features/secrets/secret-copy-panel.tsx';
import { SecretsSurface } from '../../src/features/secrets/secrets-surface.tsx';
import { StepUpDialog } from '../../src/features/step-up/step-up-dialog.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { stepUpAct } from '../../src/lib/grants.ts';
import { StepUpGate } from '../../src/lib/step-up-gate.ts';

const AT = '2026-10-20T10:00:00.000Z';
const STUDIO = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: 'studio-mac' });
const LAPTOP = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'd-laptop', daemonName: 'new-laptop' });
const SPARE = daemonConnection({ daemonId: 'spare', baseUrl: 'https://spare.example.test', deviceId: 'd-spare', daemonName: 'build-box' });
const NAMES = { studio: 'studio-mac', laptop: 'new-laptop', spare: 'build-box' };
const machineName = machine => NAMES[machine.daemonId] ?? machine.baseUrl;
const summary = name => ({ name, createdAt: AT, updatedAt: AT });

const HELD = {
  studio: ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GROQ_API_KEY', 'JEV_API_KEY', 'ZAI_API_KEY'],
  laptop: ['GITHUB_TOKEN'],
  spare: [],
};
const REFERENCES = {
  studio: [
    { name: 'ANTHROPIC_API_KEY', origin: 'login claude-api', resolved: true },
    { name: 'GROQ_API_KEY', origin: 'Speed-ups › voice clean-up', resolved: true },
    { name: 'JEV_API_KEY', origin: 'Speed-ups › Warden guard', resolved: true },
    { name: 'ZAI_API_KEY', origin: 'login glm-env', resolved: true },
    { name: 'ZAI_API_KEY', origin: 'config/daemon.json → AUTH_HEADER', resolved: true },
  ],
};

const gate = new StepUpGate({ ceremony: async () => { await new Promise(done => setTimeout(done, 150)); }, describe: () => 'That did not work.' });
const IMPORT_ID = 'fy_secret_import_' + 'a'.repeat(22);
const OFFER = { v: 1, importId: IMPORT_ID, daemonId: 'fy_daemon_' + 'T'.repeat(43), identityKey: 'aWQ', publicKey: 'cHVi', expiresAt: AT, signature: 'c2ln' };
let sealed = [];

const client = machine => ({
  request: async (path, schema, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const id = machine.daemonId;
    if (method === 'GET' && path === '/v1/secrets')
      return schema.parse({ v: 1, health: 'ready', secrets: HELD[id].map(summary), references: REFERENCES[id] ?? [] });
    if (path === '/v1/secrets/imports') return schema.parse(OFFER);
    if (path.startsWith('/v1/secrets/exports/')) {
      // The sending machine asks for a passkey for THIS act — the prompt the app raises.
      const confirmed = await gate.require(machine, stepUpAct({ capability: 'secrets', axis: 'configure', act: 'clone-secrets' }));
      if (!confirmed) throw new Error('not confirmed');
      sealed = body.names;
      return schema.parse({
        bundle: { v: 1, importId: IMPORT_ID, sourceDaemonId: 'fy_daemon_' + 'S'.repeat(43), targetDaemonId: OFFER.daemonId, expiresAt: AT, names: body.names, ephemeralKey: 'ZXBo', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVy' },
        names: body.names,
      });
    }
    if (path.startsWith('/v1/secrets/imports/'))
      return schema.parse({ importId: IMPORT_ID, sourceDaemonId: 'fy_daemon_' + 'S'.repeat(43), imported: sealed, replaced: sealed.filter(name => HELD.laptop.includes(name)) });
    throw new Error('the harness has no answer for ' + method + ' ' + path);
  },
});
const createClient = async machine => client(machine);

const NEEDS = [
  { key: 'secret:JEV_API_KEY', kind: 'secret', name: 'JEV_API_KEY', secretName: 'JEV_API_KEY', why: 'the Warden’s Jev guard', held: false },
  { key: 'secret:GROQ_API_KEY', kind: 'secret', name: 'GROQ_API_KEY', secretName: 'GROQ_API_KEY', why: 'voice clean-up', held: false },
  { key: 'secret:ZAI_API_KEY', kind: 'secret', name: 'ZAI_API_KEY', secretName: 'ZAI_API_KEY', why: 'login glm-env', held: false },
  { key: 'sign-in:claude-work', kind: 'sign-in', name: 'Claude Code login (claude-work)', credentialId: 'claude-work', why: 'runtime claude-default', held: false },
];

const view = new URLSearchParams(location.search).get('view');
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 960, padding: '12px 16px' }}>
    {view === 'settings' ? (
      <SecretsSurface connection={STUDIO} createClient={createClient} others={[LAPTOP, SPARE]} machineName={machineName} />
    ) : (
      <div className="flex min-w-0 flex-col gap-3">
        <h2 className="m-0 text-title font-semibold text-fg">Copy settings from studio-mac</h2>
        <CloneNeedsList
          needs={NEEDS}
          machineName="new-laptop"
          onAdd={async () => null}
          copy={
            <SecretCopyLauncher
              label="Copy secrets from studio-mac…"
              direction="from"
              here={LAPTOP}
              others={[STUDIO]}
              createClient={createClient}
              machineName={machineName}
              preselect={NEEDS.filter(need => need.kind === 'secret').map(need => need.secretName)}
            />
          }
        />
      </div>
    )}
    <StepUpDialog gate={gate} machineName={id => NAMES[id] ?? id} />
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/secret-copy-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'secret-copy-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'secret-copy-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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
  const file = `secret-copy-${name}-${theme}-${vp}.png`;
  await page.screenshot({ path: join(outDir, file), fullPage: true });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

/** The new machine's setup: launch, pick, passkey, done. Then Settings › Secrets from the other end. */
const walk = async (page: Page, theme: string, vp: string): Promise<void> => {
  await page.goto(`${server.url}?theme=${theme}&view=setup`);
  await page.locator('[data-secret-copy-launch]').waitFor({ state: 'visible' });
  await shot(page, 'setup', theme, vp);
  await page.locator('[data-secret-copy-launch]').click();
  await page.locator('[data-secret-copy-row="ZAI_API_KEY"]').waitFor({ state: 'visible' });
  await shot(page, 'pick', theme, vp);
  await page.locator('[data-secret-copy] [data-variant="primary"]').click();
  await page.locator('[data-step-up-dialog]').waitFor({ state: 'visible' });
  await shot(page, 'passkey', theme, vp);
  await page.locator('[data-step-up-dialog] button', { hasText: 'Use passkey' }).click();
  await page.locator('[data-secret-copy-done]').waitFor({ state: 'visible' });
  await shot(page, 'done', theme, vp);

  await page.goto(`${server.url}?theme=${theme}&view=settings`);
  await page.locator('button', { hasText: 'Copy to another machine…' }).click();
  await page.locator('[data-secret-copy="to"] input[type="radio"]').first().click();
  await page.locator('[data-secret-copy-row="GITHUB_TOKEN"]').waitFor({ state: 'visible' });
  await page.locator('[data-secret-copy-row="GITHUB_TOKEN"] input').check();
  await page.locator('[data-secret-copy-row="ANTHROPIC_API_KEY"] input').check();
  await shot(page, 'settings', theme, vp);
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
        page.on('pageerror', error => fail(`the page threw: ${error.message}`));
        await walk(page, theme, vp);
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ Copying secrets does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
