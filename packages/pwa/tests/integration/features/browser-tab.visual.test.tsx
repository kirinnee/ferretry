/**
 * The Browser tab and its "Test proxy" results, as a person sees them (docs/browser-proxy.md): the tab
 * with a saved proxy and its status line LOADED (the real tab, mounted against a scripted daemon: running via the
 * proxy, stopped, running direct), then every state the test can show — busy, reachable (saved and unsaved), each
 * failure class, a refusal — at a phone and a desktop width, light and dark, with no horizontal overflow
 * at either. Set `FY_BROWSER_PROXY_SHOTS_DIR` to keep the captures (they are not committed); every name,
 * address and secret name in them is fake.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BROWSER_PROXY_ERROR_CLASSES,
  type BrowserProxyErrorClass,
  type BrowserProxyTestResult,
} from '@ferretry/protocol';
import type { Browser } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { BrowserProxyTestBlock } from '../../../src/features/fleet/machine/browser-proxy-test-block.tsx';
import type { ProxyTestShown } from '../../../src/features/fleet/machine/browser-proxy-test-result.tsx';
import { SetupSection } from '../../../src/features/fleet/setup/setup-ui.tsx';
import { sharedChromium } from '../support/chromium.ts';

const packageDir = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_BROWSER_PROXY_SHOTS_DIR ?? '';

interface Resolved {
  readonly tab: string;
  readonly status: string;
}

/** The real tab, mounted in a child process against a scripted daemon, once its status line has loaded. */
const resolvedTabs = async (): Promise<Readonly<Record<string, Resolved>>> => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, '..', 'support', 'browser-tab-resolved-probe.tsx')],
    {
      cwd: packageDir,
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  const deadline = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  clearTimeout(deadline);
  if (exitCode !== 0) throw new Error(`the resolved-status probe exited ${exitCode}`);
  return JSON.parse(output.trim().split('\n').at(-1) ?? '{}') as Record<string, Resolved>;
};

let resolved: Readonly<Record<string, Resolved>> = {};

const wrap = (body: string): string => `<div class="flex min-w-0 flex-col gap-5 bg-bg p-panel">${body}</div>`;

const tab = (): string => wrap(resolved['running-via-proxy']?.tab ?? '');

const STATUS_SCENES = [
  { key: 'running-via-proxy', words: 'Running · via proxy http://proxy.example.test:8080 · signs in.' },
  { key: 'stopped', words: 'Stopped · the next start goes via the saved proxy.' },
  { key: 'running-direct', words: 'Running · direct, no proxy.' },
] as const;

const invalidForm = (): string => wrap(resolved['invalid-form']?.status ?? '');

const statusGallery = (): string => wrap(STATUS_SCENES.map(scene => resolved[scene.key]?.status ?? '').join(''));

const SAVED_HINT = 'Tries one request through the proxy from studio, using the stored secrets. Nothing is saved.';
const EDITED_HINT =
  'Tries one request through the proxy from studio, using the stored secrets. It tests what is typed above, saved or not. Nothing is saved.';

const failure = (errorClass: BrowserProxyErrorClass, message: string): BrowserProxyTestResult => ({
  reachable: false,
  tested: 'saved',
  errorClass,
  message,
});

const FAILURES: Readonly<Record<BrowserProxyErrorClass, string>> = {
  dns: 'The proxy’s name, proxy.example.test, was not found.',
  connect: 'Nothing is listening at proxy.example.test:8080.',
  auth: 'The proxy refused the stored sign-in. Check the secrets PROXY_USER and PROXY_PASSWORD.',
  tls: 'The proxy’s certificate was not accepted.',
  timeout: 'The proxy did not answer in 10 seconds.',
  proxy: 'The proxy answered, but would not carry the request.',
  secret: 'The secret PROXY_PASSWORD is not stored on this machine.',
  'no-proxy': 'No proxy is saved on this machine, and none was typed.',
  other: 'The test stopped for a reason the daemon could not name.',
};

const block = (hint: string, shown: ProxyTestShown | null, testing = false) => (
  <BrowserProxyTestBlock disabled={false} testing={testing} hint={hint} shown={shown} onTest={() => undefined} />
);

const gallery = (): string =>
  renderToStaticMarkup(
    <div className="flex min-w-0 flex-col gap-5 bg-bg p-panel">
      <SetupSection title="Test proxy · busy" name="shot-busy">
        {block(SAVED_HINT, null, true)}
      </SetupSection>
      <SetupSection title="Test proxy · reachable, saved proxy" name="shot-reachable-saved">
        {block(SAVED_HINT, {
          kind: 'result',
          result: {
            reachable: true,
            tested: 'saved',
            roundTripMs: 182,
            egressIp: '203.0.113.7',
            message: 'The proxy answered and the test endpoint saw its address.',
          },
        })}
      </SetupSection>
      <SetupSection title="Test proxy · reachable, unsaved edit" name="shot-reachable-unsaved">
        {block(EDITED_HINT, {
          kind: 'result',
          result: {
            reachable: true,
            tested: 'unsaved',
            roundTripMs: 96,
            egressIp: '2001:db8:85a3::8a2e:370:7334',
            message: 'The proxy answered and the test endpoint saw its address.',
          },
        })}
      </SetupSection>
      {BROWSER_PROXY_ERROR_CLASSES.map(errorClass => (
        <SetupSection key={errorClass} title={`Test proxy · ${errorClass}`} name={`shot-${errorClass}`}>
          {block(SAVED_HINT, { kind: 'result', result: failure(errorClass, FAILURES[errorClass]) })}
        </SetupSection>
      ))}
      <SetupSection title="Test proxy · refused" name="shot-refused">
        {block(SAVED_HINT, { kind: 'refused', sentence: 'Only the owner at this machine can test the proxy.' })}
      </SetupSection>
    </div>,
  );

const documentFor = (css: string, theme: string, body: string): string => `<!doctype html>
<html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head>
<body class="bg-bg"><div id="root">${body}</div></body></html>`;

const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;
const themes = ['light', 'dark'] as const;
const scenes = [
  { name: 'browser-tab', html: tab, mustSee: '[data-browser-state="running"]' },
  { name: 'browser-status', html: statusGallery, mustSee: '[data-browser-state="stopped"]' },
  { name: 'browser-proxy-invalid', html: invalidForm, mustSee: '[data-browser-proxy-test-refusal]' },
  { name: 'browser-proxy-test', html: gallery, mustSee: '[data-setup-note="browser-proxy-test"]' },
] as const;

let browser: Browser;
let workspace = '';
let css = '';

describe('Browser tab visual contract', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    workspace = await mkdtemp(join(tmpdir(), 'fy-browser-tab-visual-'));
    const stylesheet = join(workspace, 'app.css');
    const result = spawnSync(
      './node_modules/.bin/tailwindcss',
      [
        '--config',
        'tailwind.config.ts',
        '--input',
        'src/styles/index.css',
        '--output',
        stylesheet,
        '--content',
        './src/**/*.{ts,tsx},./tests/integration/features/*.tsx',
      ],
      { cwd: packageDir, stdio: 'pipe' },
    );
    if (result.status !== 0) throw new Error(`tailwind build failed: ${result.stderr?.toString() ?? ''}`);
    css = await readFile(stylesheet, 'utf8');
    resolved = await resolvedTabs();
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    if (workspace !== '') await rm(workspace, { recursive: true, force: true });
  });

  it('shows the tab and every test result at a phone and a desktop, light and dark, without overflow', async () => {
    for (const scene of scenes) {
      for (const theme of themes) {
        const pageHtml = documentFor(css, `studio-${theme}`, scene.html());
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: () => new Response(pageHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
        });
        try {
          for (const viewport of viewports) {
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              colorScheme: theme,
              reducedMotion: 'reduce',
              deviceScaleFactor: 2,
            });
            try {
              await context.route('**/*', async route =>
                new URL(route.request().url()).origin === server.url.origin
                  ? await route.continue()
                  : await route.abort(),
              );
              const page = await context.newPage();
              await page.goto(server.url.toString());
              const metrics = await page.evaluate<{ inner: number; scroll: number }>(
                '({ inner: innerWidth, scroll: document.documentElement.scrollWidth })',
              );
              should(metrics.scroll).be.belowOrEqual(metrics.inner);
              should(await page.locator(scene.mustSee).first().isVisible()).be.true();
              if (scene.name === 'browser-status') {
                const said = await page.locator('[data-browser-state]').allTextContents();
                should(said).eql(STATUS_SCENES.map(status => status.words));
              }
              if (scene.name === 'browser-tab') {
                should(await page.locator('[data-browser-state]').first().textContent()).equal(STATUS_SCENES[0].words);
              }
              // The app stylesheet clips the document to the viewport, so the viewport grows to the content.
              const height = await page.evaluate<number>("document.getElementById('root').scrollHeight");
              await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height) });
              const shot = await page.screenshot({ animations: 'disabled' });
              if (shotsDir !== '') await writeFile(join(shotsDir, `${scene.name}-${viewport.name}-${theme}.png`), shot);
            } finally {
              await context.close();
            }
          }
        } finally {
          server.stop(true);
        }
      }
    }
  }, 180_000);
});
