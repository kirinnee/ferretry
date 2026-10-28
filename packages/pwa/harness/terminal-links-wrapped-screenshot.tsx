/**
 * Screenshots of an address a program broke across two rows (a hard break, not a soft wrap): a real xterm
 * with the real link provider, the address hovered on its first row and then on its second, and a click on
 * either one counted. Both halves must underline together and the click must open the WHOLE address.
 *
 *   bun harness/terminal-links-wrapped-screenshot.tsx   # writes harness/out/terminal-links-wrapped-<viewport>-<scheme>.png
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
import { terminalHyperlinkHandler, terminalLinkProvider } from '../../src/lib/terminal-links.ts';

window.__opened = [];
const opener = {
  iosStandalone: () => false,
  handOff: href => window.__opened.push('handoff ' + href),
  openTab: href => window.__opened.push('tab ' + href),
  unlessLeft: () => () => {},
};

const PATH = 'docs/guides/getting-started/installing-the-daemon-on-a-new-machine/index.html?ref=terminal';
const FULL = 'https://docs.example.test/' + PATH;
window.__full = FULL;

function Live() {
  const host = useRef(null);
  const links = useLinkBehaviour();
  const latest = useRef(links);
  latest.current = links;
  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", monospace',
      theme: window.matchMedia('(prefers-color-scheme: dark)').matches
        ? { background: '#14161a', foreground: '#d7dae0' }
        : { background: '#f5f5f7', foreground: '#1f2328' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    document.fonts.load('13px "JetBrains Mono"').then(() => document.fonts.ready).then(async () => {
      // Nudge the size so the emulator re-measures a cell once the font is really there.
      await frame();
      term.options.fontSize = 14;
      await frame();
      term.options.fontSize = 13;
      await frame();
      fit.fit();
      const cols = term.cols;
      const lead = '  ';
      const head = (lead + FULL).slice(0, cols);
      const tail = (lead + FULL).slice(cols);
      // A program that prints its own newline at the edge: the row is full and the next is NOT a soft wrap.
      term.write(['  Open this page to continue:', '', head, lead + tail.trimStart(), '', '$ '].join('\\r\\n'));
      window.__ready = true;
    });
    const sink = {
      open: (click, href) => latest.current.open(click, { href, element: host.current }),
      confirm: () => false,
    };
    const screen = { buffer: () => term.buffer.active, columns: () => term.cols };
    term.options.linkHandler = terminalHyperlinkHandler(screen, sink);
    term.registerLinkProvider(terminalLinkProvider(screen, sink));
    window.__term = term;
    return () => term.dispose();
  }, []);
  return <div ref={host} data-pane="live" style={{ padding: 8, height: 170, boxSizing: 'content-box' }} />;
}

createRoot(document.getElementById('root')).render(
  <LinkBehaviourProvider openLinksIn="browser" opener={opener}>
    <main style={{ margin: '0 auto', maxWidth: 760, padding: 16 }}><Live /></main>
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
    <style>@font-face { font-family: "JetBrains Mono"; src: url("/jetbrains-mono.woff2") format("woff2"); } html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/terminal-links-wrapped-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
copyFileSync(join(packageDir, 'node_modules/@xterm/xterm/css/xterm.css'), join(outDir, 'xterm.css'));
// The app's own bundled monospace face, so a cell is as wide here as on a real device.
copyFileSync(
  join(packageDir, 'src/assets/fonts/jetbrains-mono-latin-400-normal.woff2'),
  join(outDir, 'jetbrains-mono.woff2'),
);
await Bun.write(join(outDir, 'terminal-links-wrapped-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'terminal-links-wrapped-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.waitForFunction(() => (window as any).__ready === true, undefined, { timeout: 5000 });
        await page.waitForTimeout(300);

        // Both halves of the address: row index 2 holds the head, row index 3 the tail.
        const where = async (rowIndex: number) =>
          await page.evaluate(index => {
            const row = document.querySelectorAll('[data-pane="live"] .xterm-rows > div')[index];
            const rect = row?.getBoundingClientRect();
            const rowsRect = document.querySelector('[data-pane="live"] .xterm-rows')?.getBoundingClientRect();
            const term = (window as any).__term;
            if (!rect || !rowsRect) return null;
            return { x: rect.x, y: rect.y + rect.height / 2, cell: rowsRect.width / term.cols };
          }, rowIndex);
        const head = (await where(2)) ?? fail('the first half of the address is not on screen');
        const tail = (await where(3)) ?? fail('the second half of the address is not on screen');
        const full = await page.evaluate(() => (window as any).__full as string);

        for (const [name, spot] of [
          ['first-row', { x: head.x + head.cell * 6, y: head.y }],
          ['second-row', { x: tail.x + tail.cell * 6, y: tail.y }],
        ] as const) {
          await page.mouse.move(spot.x - head.cell * 3, spot.y);
          await page.mouse.move(spot.x, spot.y);
          await page.waitForTimeout(300);
          const target = join(outDir, `terminal-links-wrapped-${name}-${viewport.name}-${scheme}.png`);
          await page.screenshot({
            path: target,
            clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, 420) },
          });
          process.stdout.write(`📸 ${target}\n`);
          // A phone's tap is the touch the browser turns into one click; a desktop's click is the mouse's.
          if (viewport.mobile) {
            // The first touch on the pane only primes the emulator's hover, as in terminal-links-screenshot.
            await page.touchscreen.tap(head.x + head.cell, head.y);
            await page.touchscreen.tap(spot.x, spot.y);
          } else await page.mouse.click(spot.x, spot.y);
          await page.waitForTimeout(150);
          const opened = await page.evaluate(() => (window as any).__opened.splice(0));
          if (opened.length !== 1 || opened[0] !== `tab ${full}`)
            fail(`${scheme} ${viewport.name} ${name} click opened ${JSON.stringify(opened)}`);
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
