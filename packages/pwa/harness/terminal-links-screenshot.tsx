/**
 * Screenshots of links in a terminal: a real xterm with the real link provider and OSC 8 handler, and the
 * Console's read-only capture, each with an address hovered. At phone (390) a real touch tap is made and
 * counted, so "a tap opens once" is checked in a browser rather than only asserted in a unit test.
 *
 *   bun harness/terminal-links-screenshot.tsx   # writes harness/out/terminal-links-<viewport>-<scheme>.png
 *
 * No network, no daemon: the opener is a recorder. Review evidence; nothing compares the PNGs.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
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
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { LinkBehaviourProvider, useLinkBehaviour } from '../../src/features/browser/external-link.tsx';
import { TerminalSnapshotView } from '../../src/components/terminal-snapshot.tsx';
import { terminalHyperlinkHandler, terminalLinkProvider } from '../../src/lib/terminal-links.ts';
import { describeHyperlinkMismatch } from '../../src/lib/terminal-links.ts';

window.__opened = [];
const opener = {
  iosStandalone: () => false,
  handOff: href => window.__opened.push('handoff ' + href),
  openTab: href => window.__opened.push('tab ' + href),
  unlessLeft: () => () => {},
};

const ESC = String.fromCharCode(27);
const LINES = [
  'ready in 412 ms',
  '  Local:   https://app.example.test:5173/',
  '  Docs:    see (https://docs.example.test/guide).',
  '  Preview: https://preview.example.test/branches/feat-terminal-links/builds/8841?token=redacted&theme=dark',
  '  Hyper:   ' + ESC + ']8;;https://ferretry.example.test/changelog' + ESC + '\\\\release notes' + ESC + ']8;;' + ESC + '\\\\',
  '$ ',
];
const CAPTURE = LINES.slice(0, 4).join('\\n').replace(/\\u001b/g, '') + '\\n$ ';

function Live() {
  const host = useRef(null);
  const links = useLinkBehaviour();
  const latest = useRef(links);
  latest.current = links;
  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: '"DejaVu Sans Mono", "Liberation Mono", monospace',
      theme: window.matchMedia('(prefers-color-scheme: dark)').matches
        ? { background: '#14161a', foreground: '#d7dae0' }
        : { background: '#f5f5f7', foreground: '#1f2328' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
    document.fonts.ready.then(async () => {
      await raf();
      term.options.fontSize = 13;
      await raf();
      term.options.fontSize = 12;
      await raf();
      fit.fit();
    });
    fit.fit();
    const sink = {
      open: (click, href) => latest.current.open(click, { href, element: host.current }),
      confirm: (visible, href) => { window.__asked = describeHyperlinkMismatch(visible, href); return false; },
    };
    const screen = { buffer: () => term.buffer.active, columns: () => term.cols };
    term.options.linkHandler = terminalHyperlinkHandler(screen, sink);
    term.registerLinkProvider(terminalLinkProvider(screen, sink));
    term.write(LINES.join('\\r\\n'));
    window.__term = term;
    return () => term.dispose();
  }, []);
  return <div ref={host} data-pane="live" style={{ padding: 8, height: 150, boxSizing: 'content-box' }} />;
}

createRoot(document.getElementById('root')).render(
  <LinkBehaviourProvider openLinksIn="browser" opener={opener}>
    <main style={{ margin: '0 auto', maxWidth: 760, padding: 16, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section><h3 className="text-row font-semibold text-fg" style={{ margin: '0 0 8px' }}>Live terminal</h3><Live /></section>
      <section data-pane="capture">
        <h3 className="text-row font-semibold text-fg" style={{ margin: '0 0 8px' }}>Console capture</h3>
        <div style={{ height: 190, display: 'flex' }}>
          <TerminalSnapshotView
            daemon={{ daemonId: 'd', baseUrl: 'https://d.example.test', deviceId: 't' }}
            scope={{ daemonId: 'd', sessionId: 's' }}
            now={() => 0}
            readSnapshot={async () => CAPTURE}
          />
        </div>
      </section>
    </main>
  </LinkBehaviourProvider>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <link rel="stylesheet" href="/xterm.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/terminal-links-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
copyFileSync(join(packageDir, 'node_modules/@xterm/xterm/css/xterm.css'), join(outDir, 'xterm.css'));
await Bun.write(join(outDir, 'terminal-links-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'terminal-links-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
] as const;

const LOCAL = 'https://app.example.test:5173/';

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => fail(`page error: ${error.message}`));
        page.on('console', message => process.stdout.write(`[console] ${message.text()}\n`));
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        const live = page.locator('[data-pane="live"] .xterm-rows');
        await live.waitFor({ state: 'visible' });
        await page
          .waitForFunction(
            () => document.querySelector('[data-pane="live"] .xterm-rows')?.textContent?.includes('release\u00a0notes'),
            undefined,
            { timeout: 5000 },
          )
          .catch(async () => fail('rows: ' + (await page.locator('[data-pane="live"] .xterm-rows').innerText())));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);

        // Where the first address sits on screen: the row that holds it, from its first character.
        const box = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[data-pane="live"] .xterm-rows > div')];
          const row = rows.find(each => each.textContent?.includes('Local:'));
          const rect = row?.getBoundingClientRect();
          const rowsRect = document.querySelector('[data-pane="live"] .xterm-rows')?.getBoundingClientRect();
          const cell = rowsRect && (window as any).__term ? rowsRect.width / (window as any).__term.cols : 8;
          return rect ? { x: rect.x, y: rect.y + rect.height / 2, cell } : null;
        });
        if (box === null) fail('the Local row is not on screen');
        const at = { x: box!.x + box!.cell * 16, y: box!.y };

        if (viewport.mobile) {
          // A tap on the address: one tab, once. A tap on plain text opens nothing.
          await page.touchscreen.tap(box!.x + box!.cell * 2, box!.y);
          await page.touchscreen.tap(at.x, at.y);
          await page.waitForTimeout(150);
          const opened = await page.evaluate(() => (window as any).__opened);
          if (opened.length !== 1 || opened[0] !== `tab ${LOCAL}`) fail(`a tap opened ${JSON.stringify(opened)}`);
          await page.evaluate(() => ((window as any).__opened.length = 0));
        } else {
          await page.mouse.move(at.x - box!.cell * 4, at.y);
          await page.mouse.move(at.x, at.y);
          await page.waitForTimeout(300);
          const cursor = await page.evaluate(
            () => getComputedStyle(document.querySelector('[data-pane="live"] .xterm-screen') as Element).cursor,
          );
          process.stdout.write(`cursor over the address: ${cursor}\n`);
          const target = join(outDir, `terminal-links-${viewport.name}-${scheme}.png`);
          await page.screenshot({
            path: target,
            clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, 720) },
          });
          process.stdout.write(`📸 ${target}\n`);
          await page.mouse.click(at.x, at.y);
          await page.waitForTimeout(150);
          const opened = await page.evaluate(() => (window as any).__opened);
          if (opened.length !== 1 || opened[0] !== `tab ${LOCAL}`) fail(`a click opened ${JSON.stringify(opened)}`);
          continue;
        }

        const target = join(outDir, `terminal-links-${viewport.name}-${scheme}.png`);
        await page.screenshot({
          path: target,
          clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, 720) },
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
