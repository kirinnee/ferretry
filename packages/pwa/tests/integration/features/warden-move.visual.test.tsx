/**
 * Settings › Warden › "When a login runs out", as a person sees it: the switch on, both triggers, a named list
 * of logins and the background-jobs choice, at a phone and a desktop width, light and dark, with no horizontal
 * overflow. Set `FY_WARDEN_MOVE_SHOTS_DIR` to keep the captures; every name in them is fake.
 */
import { beforeAll, describe, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WardenConfig } from '@ferretry/protocol';
import type { Browser } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { WardenSettingsForm } from '../../../src/features/warden/warden-settings-form.tsx';
import { wardenFormErrors } from '../../../src/features/warden/warden-settings-model.ts';
import type { PickerAccount } from '../../../src/lib/account-picker-catalog.ts';
import { wardenConfig } from '../../support/warden.ts';
import { appStylesheet } from '../support/app-stylesheet.ts';
import { sharedChromium } from '../support/chromium.ts';

const shotsDir = process.env.FY_WARDEN_MOVE_SHOTS_DIR ?? '';

const runtime = (wrapper: string, displayName: string): PickerAccount => ({
  id: `${wrapper}-id`,
  wrapper,
  displayName,
  kind: 'claude',
  agent: true,
  credentialId: wrapper,
  defaultModel: null,
  models: [],
  available: true,
  unavailableReason: null,
});

const scenes: readonly { readonly name: string; readonly value: WardenConfig }[] = [
  {
    name: 'ask',
    value: wardenConfig({
      autoMigrate: { ...wardenConfig().autoMigrate, enabled: true, targets: ['claude-work', 'glm-a'] },
    }),
  },
  {
    name: 'force',
    value: wardenConfig({ autoMigrate: { ...wardenConfig().autoMigrate, enabled: true, forceStopBackground: true } }),
  },
];

const scene = (value: WardenConfig): string =>
  renderToStaticMarkup(
    <div className="flex min-w-0 flex-col gap-5 bg-bg p-panel">
      <WardenSettingsForm
        value={value}
        onChange={() => undefined}
        jevKey={{ state: 'set' }}
        errors={wardenFormErrors(value)}
        runtimes={[runtime('claude-home', 'Personal Claude'), runtime('claude-work', 'Work'), runtime('glm-a', 'GLM')]}
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
let css = '';

describe('Warden move-to-another-login visual contract', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    css = await appStylesheet();
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 120_000);

  it('shows the move settings without overflow at a phone and a desktop, light and dark', async () => {
    for (const { name, value } of scenes)
      for (const theme of themes) {
        const pageHtml = documentFor(css, `studio-${theme}`, scene(value));
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
              const card = page.locator(
                'xpath=//*[@data-warden-move-when]/ancestor::*[contains(@class,"kt-panel")][1]',
              );
              // The card is taller than a phone screen: grow the window to it, so the capture shows all of it.
              const box = await card.boundingBox();
              if (box !== null && box.y + box.height > viewport.height)
                await page.setViewportSize({ width: viewport.width, height: Math.ceil(box.y + box.height + 16) });
              const shot = await card.screenshot({ animations: 'disabled' });
              if (shotsDir !== '')
                await writeFile(join(shotsDir, `warden-move-${name}-${viewport.name}-${theme}.png`), shot);
            } finally {
              await context.close();
            }
          }
        } finally {
          server.stop(true);
        }
      }
  }, 180_000);
});
