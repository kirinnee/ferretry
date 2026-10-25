/**
 * The Warden's Login picker, as a person sees it: every login is its NAME, then its harness and label
 * (never an opaque id), at a phone and a desktop width, light and dark, with no horizontal overflow. Set
 * `FY_WARDEN_LOGIN_SHOTS_DIR` to keep the captures; every name in them is fake.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { WardenSettingsForm } from '../../../src/features/warden/warden-settings-form.tsx';
import { wardenFormErrors } from '../../../src/features/warden/warden-settings-model.ts';
import type { PickerAccount } from '../../../src/lib/account-picker-catalog.ts';
import { wardenConfig } from '../../support/warden.ts';
import { sharedChromium } from '../support/chromium.ts';

const packageDir = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_WARDEN_LOGIN_SHOTS_DIR ?? '';

const runtime = (wrapper: string, displayName: string, kind: PickerAccount['kind']): PickerAccount => ({
  id: '0b6f6b5e-5d7c-4f4e-9d0a-1d1f2a3b4c5d',
  wrapper,
  displayName,
  kind,
  agent: true,
  credentialId: wrapper,
  defaultModel: null,
  models: [],
  available: true,
  unavailableReason: null,
});

const value = wardenConfig({
  layers: { jev: false, llm: true },
  accounts: [{ agent: 'claude-default' }],
});

const scene = (): string =>
  renderToStaticMarkup(
    <div className="flex min-w-0 flex-col gap-5 bg-bg p-panel">
      <WardenSettingsForm
        value={value}
        onChange={() => undefined}
        jevKey={{ state: 'set' }}
        errors={wardenFormErrors(value)}
        loginOptions={[{ agent: 'claude-default' }, { agent: 'codex-review' }]}
        runtimes={[runtime('claude-default', 'Personal Claude', 'claude'), runtime('codex-review', 'Review', 'codex')]}
        login={{ source: 'configured', unknown: [], available: ['claude-default', 'codex-review'] }}
      />
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

let browser: Browser;
let workspace = '';
let css = '';

describe('Warden login picker visual contract', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    workspace = await mkdtemp(join(tmpdir(), 'fy-warden-login-visual-'));
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
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    if (workspace !== '') await rm(workspace, { recursive: true, force: true });
  });

  it('shows the chosen login by name, harness and label at a phone and a desktop, light and dark', async () => {
    for (const theme of themes) {
      const pageHtml = documentFor(css, `studio-${theme}`, scene());
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
            const chosen = await page.evaluate<string>(
              "document.querySelector('label select').selectedOptions[0].textContent",
            );
            should(chosen).equal('claude-default · claude · Personal Claude');
            const card = page.locator('xpath=//label[.//select]/ancestor::*[contains(@class,"kt-panel")][1]');
            const shot = await card.screenshot({ animations: 'disabled' });
            if (shotsDir !== '') await writeFile(join(shotsDir, `warden-login-${viewport.name}-${theme}.png`), shot);
          } finally {
            await context.close();
          }
        }
      } finally {
        server.stop(true);
      }
    }
  }, 120_000);
});
