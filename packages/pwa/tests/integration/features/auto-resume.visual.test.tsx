/**
 * Auto-resume after restart, as a person sees it: the Machine tab's section and the "Resumed N ferrets after
 * restart" row, at a phone and a desktop width, light and dark, with no horizontal overflow at either. Set
 * `FY_AUTO_RESUME_SHOTS_DIR` to keep the captures; every name in them is fake.
 */
import { beforeAll, describe, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FleetMachineView } from '@ferretry/protocol';
import type { Browser } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { AutoResumeSection } from '../../../src/features/fleet/machine/settings-tab.tsx';
import type { SetupAccess } from '../../../src/features/fleet/setup/setup-access.ts';
import { appStylesheet } from '../support/app-stylesheet.ts';
import { sharedChromium } from '../support/chromium.ts';

const shotsDir = process.env.FY_AUTO_RESUME_SHOTS_DIR ?? '';

const machine: FleetMachineView = {
  name: 'studio',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  autoResume: true,
  lastAutoResume: {
    at: '2026-10-21T08:00:00.000Z',
    resumed: 5,
    skipped: [{ sessionId: 'review-bot', reason: 'its Claude login has signed out' }],
  },
  tools: [],
  runtimeCount: 1,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
};

/** Only `changes` is read while nothing is pending, which is the state a static render shows. */
const access = {
  changes: {
    authority: machine.authority,
    busy: false,
    refusal: null,
    apply: async () => ({ kind: 'refused' }),
    clear: () => undefined,
  },
} as unknown as SetupAccess;

const scene = (): string =>
  renderToStaticMarkup(
    <div className="flex min-w-0 flex-col gap-5 bg-bg p-panel">
      <AutoResumeSection machine={machine} machineName="studio" access={access} onSaved={() => undefined} />
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

describe('Auto-resume visual contract', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    css = await appStylesheet();
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 120_000);

  it('shows the section and the summary row at a phone and a desktop, light and dark, without overflow', async () => {
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
            should(await page.locator('[data-setup-section="auto-resume"]').isVisible()).be.true();
            should(await page.locator('[data-auto-resume-summary]').isVisible()).be.true();
            const shot = await page.locator('#root').screenshot({ animations: 'disabled' });
            if (shotsDir !== '') await writeFile(join(shotsDir, `auto-resume-${viewport.name}-${theme}.png`), shot);
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
