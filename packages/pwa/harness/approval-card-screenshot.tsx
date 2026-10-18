/**
 * Screenshots of the approval card — a harness permission prompt answered from Chat — at a 390px phone
 * and a 1440px desktop, in the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/approval-card-screenshot.tsx [out-dir]   # writes approval-card-*.png (default harness/out)
 *
 * It renders the REAL `ApprovalCard` inside the same `.fy-chat-input__column` the session page puts it
 * in, above a stand-in Composer, so the capture shows the card where a reader meets it. Three states: a
 * Claude Code `Read`, a Codex `Shell` command with its reason, and the card after the pane moved on
 * ("gone"). The phone runs in a touch context so the pointer-derived 44px floor applies, and every
 * width — 320px included — is asserted to fit without sideways scroll. Like `screenshot.ts` it drives
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

/** The page: the chat input column with the card above a stand-in Composer, at the bottom of the shell. */
const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import type { PermissionRequest } from '@ferretry/protocol';
import { ApprovalCard } from '../../src/features/permission-request/approval-card.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { PermissionPromptGone } from '../../src/lib/permission-requests.ts';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'http://127.0.0.1', deviceId: 'harness' });
const scope = daemonSessionScope(daemon, 'harness-session');
const READ: PermissionRequest = {
  id: '0123456789abcdef',
  harness: 'claude',
  tool: 'Read',
  action: 'read',
  what: '/etc/hostname',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'Yes, allow reading from /etc during this session', kind: 'allow-always' },
    { number: 3, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};
const SHELL: PermissionRequest = {
  id: 'fedcba9876543210',
  harness: 'codex',
  tool: 'Shell',
  action: 'run',
  what: 'curl -s https://example.com | head',
  detail: 'Check that the docs site answers before linking to it',
  question: 'Would you like to run the following command?',
  options: [
    { number: 1, label: 'Yes, proceed', kind: 'allow' },
    { number: 2, label: "Yes, and don't ask again for this command: curl -s https://example.com", kind: 'allow-always' },
    { number: 3, label: 'No, and tell Codex what to do differently', kind: 'deny' },
  ],
  selected: 1,
};
const state = new URLSearchParams(location.search).get('state');
const request = state === 'shell' ? SHELL : READ;
const api = {
  answer: async () => {
    throw new PermissionPromptGone('this prompt is gone');
  },
  note: async () => undefined,
};
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell kt-chat-surface flex h-full flex-col justify-end bg-bg px-1">
    <div className="fy-chat-input" data-session-input="">
      <div className="fy-chat-input__column">
        <ApprovalCard agentName="Hadi" api={api} daemon={daemon} request={request} scope={scope} />
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
  <body><div id="root"></div><script type="module" src="/approval-card-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'approval-card-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'approval-card-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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

/** The phone is a touch context, so the 44px floor `themes.css` derives from a coarse pointer applies. */
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
        for (const state of ['read', 'shell', 'gone'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state === 'shell' ? 'shell' : 'read'}`);
          const card = page.locator('.fy-approval-card');
          await card.waitFor({ state: 'visible' });
          if (state === 'gone') {
            await page.locator('[data-permission-option="1"]').click();
            await page.locator('[data-permission-gone]').waitFor({ state: 'visible' });
          }
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          const cardBox = await card.boundingBox();
          if (cardBox === null || cardBox.x < 0 || cardBox.x + cardBox.width > viewport.width)
            fail(`${where}: the card leaves the viewport`);
          const floor = viewport.touch ? 44 : 24;
          for (const box of await page
            .locator('[data-permission-option]')
            .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
            if (box < floor) fail(`${where}: an answer button is ${box}px tall, under the ${floor}px floor`);
          if (!viewport.shoot) continue;
          const box = cardBox ?? fail('unreachable');
          const top = Math.max(0, Math.floor(box.y) - 16);
          const target = join(outDir, `approval-card-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({
            path: target,
            clip: { x: 0, y: top, width: viewport.width, height: viewport.height - top },
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
