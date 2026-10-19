/**
 * Screenshots of the dialog card — a harness's own screen answered from Chat — at a 390px phone and a
 * 1440px desktop, in the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/dialog-card-screenshot.tsx [out-dir]   # writes dialog-card-*.png (default harness/out)
 *
 * It renders the REAL `DialogCard` inside the same `.fy-chat-input__column` the session page puts it in,
 * above a stand-in Composer. The dialog is Codex's "Hooks need review": the harness's own labels, the
 * trust-granting choice in the warning tone, the default marked, and the footer's Esc as "Skip". The
 * phone runs in a touch context so the pointer-derived 44px floor applies, and every width — 320px
 * included — is asserted to fit without sideways scroll. Like `approval-card-screenshot.tsx` it drives
 * the system Chrome through playwright-core and aborts every request off the loopback origin.
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
import type { HarnessDialog } from '@ferretry/protocol';
import { DialogCard } from '../../src/features/harness-dialog/dialog-card.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'http://127.0.0.1', deviceId: 'harness' });
const scope = daemonSessionScope(daemon, 'harness-session');
const HOOKS: HarnessDialog = {
  id: '0123456789abcdef',
  harness: 'codex',
  kind: 'hooks-review',
  title: 'Hooks need review',
  body: '1 hook is new or changed.\\nHooks can run outside the sandbox after you trust them.',
  options: [
    { number: 1, label: 'Review hooks', grantsTrust: false },
    { number: 2, label: 'Trust all and continue', grantsTrust: true },
    { number: 3, label: 'Continue without trusting', detail: "hooks won't run", grantsTrust: false },
  ],
  selected: 1,
  escape: 'skip',
};
const api = { answer: async () => ({ dialogId: HOOKS.id, cleared: true }) };
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell kt-chat-surface flex h-full flex-col justify-end bg-bg px-1">
    <div className="fy-chat-input" data-session-input="">
      <div className="fy-chat-input__column">
        <DialogCard agentName="Hadi" api={api} daemon={daemon} dialog={HOOKS} scope={scope} />
        <textarea aria-label="Message" className="kt-input w-full" placeholder="Message Hadi…" rows={2} />
      </div>
    </div>
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/dialog-card-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'dialog-card-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'dialog-card-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        const card = page.locator('.fy-dialog-card');
        await card.waitFor({ state: 'visible' });
        const where = `hooks-review at ${viewport.name}/${scheme}`;
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
        const cardBox = await card.boundingBox();
        if (cardBox === null || cardBox.x < 0 || cardBox.x + cardBox.width > viewport.width)
          fail(`${where}: the card leaves the viewport`);
        const floor = viewport.touch ? 44 : 24;
        for (const height of await page
          .locator('.fy-dialog-card__option')
          .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
          if (height < floor) fail(`${where}: an answer button is ${height}px tall, under the ${floor}px floor`);
        if (!viewport.shoot) continue;
        const box = cardBox ?? fail('unreachable');
        const top = Math.max(0, Math.floor(box.y) - 16);
        const target = join(outDir, `dialog-card-hooks-review-${viewport.name}-${scheme}.png`);
        await page.screenshot({
          path: target,
          clip: { x: 0, y: top, width: viewport.width, height: viewport.height - top },
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
