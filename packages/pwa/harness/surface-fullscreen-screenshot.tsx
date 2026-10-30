/**
 * Screenshots of a shared surface (a terminal and a browser page) at rest and full screen, in both themes
 * on a desktop and on a phone: the one slim control row with the agent-control chip, the icon buttons and
 * the Full screen toggle.
 *
 *   bun harness/surface-fullscreen-screenshot.tsx [outDir]   # writes <outDir>/surface-fullscreen-*.png
 *
 * It renders the REAL deck, marker, frame and page strip against fake data: a fake daemon listing and a
 * stream that prints a few lines. The phone captures use the viewport overlay (what iPhone Safari does,
 * having no element Fullscreen API); the desktop ones use the native API. Review evidence; nothing
 * compares the PNGs. Fails if any frame scrolls sideways.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
const shotDir = process.argv[2] ?? outDir;

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
import { SessionTerminalDeck } from '../../src/components/session-terminal-deck.tsx';
import { AgentControlMarker } from '../../src/features/workspace/agent-control-marker.tsx';
import { SurfaceFrame } from '../../src/features/workspace/surface-frame.tsx';
import { BrowserSurfaceList } from '../../src/features/browser/browser-surface-list.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { terminalListing, terminalView } from '../../tests/support/terminal-deck.ts';

const params = new URLSearchParams(location.search);
const surface = params.get('surface') ?? 'terminal';
const state = params.get('state') ?? 'agent';
if (params.get('overlay') === '1') {
  Element.prototype.requestFullscreen = undefined;
  Element.prototype.webkitRequestFullscreen = undefined;
}

const connection = daemonConnection({ daemonId: 'studio-mac', baseUrl: 'https://studio.example.test', deviceId: 'harness' });
const scope = daemonSessionScope(connection, 'shared');
const ID = 'a1b2c3d4e5f6';

const LINES = [
  '\\x1b[32m~/ferretry\\x1b[0m $ bun test packages/pwa',
  'bun test v1.3.13',
  '',
  ' 13540 pass',
  '  0 fail',
  'Ran 13540 tests across 612 files. [41.20s]',
  '\\x1b[32m~/ferretry\\x1b[0m $ ',
];

const deps = {
  list: async () => terminalListing([terminalView(ID, { title: 'dev server', openedBy: { by: 'agent', sessionId: 'mse7wwti' } })]),
  create: async () => terminalView(ID),
  rename: async () => terminalView(ID),
  close: async () => ({ closed: true, id: ID }),
  attach: async (_d, _s, _id, handlers) => {
    setTimeout(() => {
      handlers.onOpen();
      handlers.onBytes(new TextEncoder().encode(LINES.join('\\r\\n')));
    }, 50);
    return { write() {}, control() {}, close() {} };
  },
  loadXterm: async () => {
    const [xterm, fit] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    return { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
  },
  watchTheme: repaint => {
    const observer = new MutationObserver(repaint);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => observer.disconnect();
  },
  confirmClose: () => true,
  confirmLink: () => true,
  writeClipboard: async () => {},
};

const noop = () => {};
const marker = (extra = {}) => (
  <AgentControlMarker
    driver={state === 'agent' || state === 'human' ? { name: 'Hadi' } : null}
    ask={state === 'ask' ? { agent: 'Hadi', message: 'The login needs you: enter the 2FA code, then hand it back.' } : null}
    onDismissAsk={noop}
    takenOver={state === 'human'}
    onTakeOver={noop}
    onHandBack={noop}
    {...extra}
  />
);

const page = (id, name, url, title) => ({ id, name, url, title, ownerSessionId: 'hadi', ownerName: 'Hadi' });
const pages = [
  page('PAGE1', 'app', 'https://app.example.test/dashboard', 'Dashboard'),
  page('PAGE2', 'docs', 'https://docs.example.test/guide', 'Guide'),
];
const browserStatus = {
  sessionId: 'hadi', state: 'running', pages, viewport: { width: 1280, height: 800 }, viewers: 0,
  persistentProfile: true, idleTimeoutSeconds: 900, capacity: { running: 2, maximum: 60 },
};

function FakePage() {
  return (
    <div style={{ flex: 1, minHeight: 0, background: 'var(--surface, #fff)', border: '1px solid var(--line, #ddd)', padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>Dashboard</h1>
      <p style={{ opacity: 0.7, marginTop: 8 }}>A page the agent is driving, drawn full height.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginTop: 20 }}>
        {['Builds', 'Deploys', 'Errors', 'Latency'].map(card => (
          <div key={card} style={{ border: '1px solid var(--line, #ddd)', borderRadius: 8, padding: 16 }}>{card}</div>
        ))}
      </div>
    </div>
  );
}

function Strip({ children }) {
  return (
    <div data-fixture-tabs="" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--line, #ddd)', fontSize: 13 }}>
      <span style={{ fontWeight: 600 }}>{surface === 'terminal' ? 'dev server' : 'app'}</span>
      <span style={{ opacity: 0.6 }}>shared session</span>
      {children}
    </div>
  );
}

const body = surface === 'terminal' ? (
  <SessionTerminalDeck connection={connection} scope={scope} dependencies={deps} focusTerminalId={ID} solo surfaceStatus={marker()} />
) : (
  <SurfaceFrame dataBrowser="app" hostsControls marker={marker()}>
    {controls => (
      <>
        <BrowserSurfaceList
          status={browserStatus}
          selectedPageId="PAGE1"
          sessionName="Hadi"
          driverFor={p => (p.id === 'PAGE1' && state !== 'ask' ? { name: 'Hadi' } : null)}
          takenOver={() => state === 'human'}
          onOpenPage={noop}
          onClosePage={noop}
          onNewPage={noop}
          trailing={controls}
        />
        <FakePage />
      </>
    )}
  </SurfaceFrame>
);

createRoot(document.getElementById('root')).render(
  <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
    <Strip />
    <div style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column' }}>{body}</div>
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: 100%; margin: 0; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root" style="height:100%"></div><script type="module" src="/surface-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });
await Bun.write(join(outDir, 'surface-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'surface-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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
    const file = Bun.file(join(outDir, url.pathname));
    return new Response(file);
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

const shot = async (page: Page, name: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${name} scrolls sideways by ${overflow}px`);
  const file = join(shotDir, `surface-fullscreen-${name}.png`);
  await page.screenshot({ path: file });
  process.stdout.write(`📸 ${file}\n`);
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
        for (const surface of ['terminal', 'browser'] as const) {
          for (const state of ['agent', 'human', 'ask'] as const) {
            const wanted = state === 'agent' || (theme === 'studio-dark' && vp === 'desktop') || vp === 'phone';
            if (!wanted) continue;
            const page = await context.newPage();
            page.on('pageerror', error => fail(`the page threw: ${error.message}`));
            const open = async (overlay: boolean) => {
              await page.goto(
                `${server.url}?theme=${theme}&surface=${surface}&state=${state}${overlay ? '&overlay=1' : ''}`,
              );
              await page.locator('.fy-ws-marker').first().waitFor({ state: 'visible' });
              if (surface === 'terminal') await page.locator('.xterm-screen').waitFor({ state: 'visible' });
              await page.waitForTimeout(300);
            };
            const base = `${surface}-${state}-${theme.replace('studio-', '')}-${vp}`;
            await open(false);
            await shot(page, `${base}-normal`);
            if (state === 'agent' || (state === 'human' && vp === 'phone')) {
              await open(vp === 'phone');
              await page.locator('button[aria-label="Full screen"]').first().click();
              await page.waitForTimeout(400);
              await shot(page, `${base}-fullscreen`);
              await page.keyboard.press('Escape');
              await page.waitForTimeout(200);
              const still = await page.locator('button[aria-label="Exit full screen"]').count();
              if (still > 0) fail(`${base}: Escape did not leave full screen`);
            }
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ surfaces render normal and full screen without scrolling sideways\n');
} finally {
  await browser.close();
  server.stop();
}
