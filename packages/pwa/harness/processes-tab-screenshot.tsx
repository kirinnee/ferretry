/**
 * Screenshots of the Processes tab: the list with every kind (a running command, a background dev
 * server with a listening child, a helper, an ended failure, an unreadable row), a coloured live output
 * open in the detail pane, and on a phone the Stop confirmation. Phone 390x844 and desktop 1440x900,
 * light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/processes-tab-screenshot.tsx [out-dir]   # writes processes-tab-*.png (default harness/out)
 *
 * The surface is the REAL `ProcessesSurface` fed the same fixtures the unit tests use, with an injected
 * output reader and stopper so no daemon is needed. Like `fast-mode-screenshot.tsx` it drives the system
 * Chrome through playwright-core, aborts every request off the loopback origin, and asserts every width
 * fits without sideways scroll and that phone touch targets are at least 44px.
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
import { ProcessesSurface } from '../../src/features/workspace/processes-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { ALL_PROCESSES, PROCESSES_NOW, outputAnswer } from '../../tests/support/session-processes.ts';
import { liveProcessCount } from '../../src/lib/session-processes.ts';
import { useState } from 'react';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.example.test', deviceId: 'token' });
const scope = daemonSessionScope(daemon, 'agent-session');
const params = new URLSearchParams(location.search);
const compact = params.get('compact') === '1';

const E = String.fromCharCode(27);
const OUTPUT = [
  E + '[1mbun test' + E + '[0m ' + E + '[2mv1.3.13' + E + '[0m',
  '',
  E + '[4msrc/lib/ansi.test.ts' + E + '[0m',
  E + '[32m✓' + E + '[0m parses a plain line ' + E + '[2m[0.21ms]' + E + '[0m',
  E + '[32m✓' + E + '[0m keeps bold and dim apart ' + E + '[2m[0.34ms]' + E + '[0m',
  E + '[31m✗' + E + '[0m reads a 256-colour index ' + E + '[2m[1.02ms]' + E + '[0m',
  E + '[31m  error: expect(received).toBe(expected)' + E + '[0m',
  '  Expected: ' + E + '[32m"var(--fy-ansi-9)"' + E + '[0m',
  '  Received: ' + E + '[31m"var(--fy-ansi-1)"' + E + '[0m',
  '',
  E + '[4msrc/lib/session-processes.test.ts' + E + '[0m',
  E + '[32m✓' + E + '[0m groups by kind ' + E + '[2m[0.40ms]' + E + '[0m',
  E + '[32m✓' + E + '[0m puts children under their parent ' + E + '[2m[0.18ms]' + E + '[0m',
  E + '[33m!' + E + '[0m formats an elapsed time ' + E + '[2m(todo)' + E + '[0m',
  '',
  ' ' + E + '[32m3 pass' + E + '[0m',
  ' ' + E + '[31m1 fail' + E + '[0m',
  E + '[2mWatching for file changes…' + E + '[0m',
].join('\\n') + '\\n';

function Scene() {
  const [open, setOpen] = useState<string | null>(params.get('open'));
  return (
    <div className="kt-shell flex h-screen min-h-0 flex-col bg-bg" data-shot="scene">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-panel py-2 text-meta text-muted">
        <span>Chat</span>
        <span>Console</span>
        <strong className="text-fg">Processes · {liveProcessCount(ALL_PROCESSES)}</strong>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ProcessesSurface
          compact={compact}
          connection={daemon}
          now={() => PROCESSES_NOW}
          onOpenChange={setOpen}
          onShowConsole={() => undefined}
          openId={open}
          readOutput={async (_daemon, _scope, id) => {
            if (id === '400.5') return outputAnswer(id, 'task: lint failed with exit code 1\\n', { source: 'transcript', complete: true });
            return outputAnswer(id, OUTPUT);
          }}
          scope={scope}
          state={{ status: 'ready', list: ALL_PROCESSES }}
          stopProcess={async () => ({ signalled: 3 })}
          writeClipboard={async () => undefined}
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(<Scene />);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/processes-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'processes-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'processes-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
        const where = `${viewport.name}/${scheme}`;
        const page = await context.newPage();
        const compact = viewport.touch ? '&compact=1' : '';
        const shoot = async (name: string): Promise<void> => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} ${name} scrolls sideways by ${overflow}px`);
          const target = join(outDir, `processes-tab-${name}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        };

        // The list and, beside or in place of it, the open coloured output.
        await page.goto(`${server.url}?theme=studio-${scheme}&open=100.1${compact}`);
        await page.locator('.fy-proc-body .fy-proc-line').first().waitFor({ state: 'visible' });
        await shoot('output');

        if (viewport.touch) {
          const small = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('.fy-proc button, .fy-proc input')]
              .filter(node => node.offsetParent !== null)
              .map(node => ({
                label: node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '',
                box: node.getBoundingClientRect(),
              }))
              .filter(({ box }) => box.height < 43.5)
              .map(({ label, box }) => `${label} (${Math.round(box.height)}px)`),
          );
          if (small.length > 0) fail(`${where}: touch targets under 44px: ${small.join(', ')}`);
          // The Stop confirmation, drawn over the open row.
          await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
          await page.locator('[role="dialog"] [data-stop-sentence]').waitFor({ state: 'visible' });
          await shoot('stop');
        } else {
          // The list alone, with nothing open.
          await page.goto(`${server.url}?theme=studio-${scheme}`);
          await page.locator('.fy-proc-item').first().waitFor({ state: 'visible' });
          await shoot('list');
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
