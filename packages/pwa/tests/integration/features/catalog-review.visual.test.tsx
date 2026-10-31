/** The catalog review at phone and desktop widths, light and dark: it never scrolls sideways and every warning says it in words. */
import { beforeAll, describe, it } from 'bun:test';
import type { Browser } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { ReviewBody, WarningList } from '../../../src/features/catalogs/catalog-review-view.tsx';
import { installPreview } from '../../support/catalog-views.ts';
import { appStylesheet } from '../support/app-stylesheet.ts';
import { sharedChromium } from '../support/chromium.ts';

const HIDDEN = String.fromCodePoint(0x202e);
const LONG_PATH = `/home/someone/.claude/skills/${'very-long-folder-name/'.repeat(6)}SKILL.md`;

const preview = installPreview({
  review: [
    { label: 'Skill file SKILL.md', text: `# tools\nRun ${LONG_PATH} ${HIDDEN}fdp.sh\n`, document: true },
    { label: 'Starts', text: `npx -y acme-mcp --config ${LONG_PATH}`, document: false },
    { label: 'Environment ACME_TOKEN', text: '${secret:ACME_TOKEN}', document: false },
  ],
  warnings: [
    { code: 'older-version', text: 'This is version 1. You have version 2 installed.' },
    { code: 'hidden-characters', text: 'SKILL.md holds a hidden text-direction character. It is shown marked below.' },
    { code: 'carries-scripts', text: 'This skill carries a script, scripts/split.sh. A ferret may run it.' },
    { code: 'unpinned-package', text: 'npx fetches the newest acme-mcp every time it starts.' },
  ],
});

const documentFor = (css: string, theme: string): string => `<!doctype html>
<html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><div id="root" class="flex flex-col gap-sm p-panel">${renderToStaticMarkup(
  <>
    <WarningList warnings={preview.warnings} />
    <ReviewBody entries={preview.review} />
  </>,
)}</div></body></html>`;

const viewports = [
  { width: 390, height: 844 },
  { width: 1_440, height: 900 },
] as const;
const themes = ['studio-light', 'studio-dark'] as const;

let browser: Browser;
let css = '';

describe('catalog review', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    css = await appStylesheet();
  }, 120_000);

  it('never scrolls sideways, and each warning has an icon and a label', async () => {
    for (const theme of themes) {
      const html = documentFor(css, theme);
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      });
      try {
        for (const viewport of viewports) {
          const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
          try {
            await context.route('**/*', async route =>
              new URL(route.request().url()).origin !== server.url.origin
                ? await route.abort()
                : await route.continue(),
            );
            const page = await context.newPage();
            await page.goto(server.url.toString());
            const metrics = await page.evaluate<{ inner: number; scroll: number }>(
              '({ inner: innerWidth, scroll: document.documentElement.scrollWidth })',
            );
            should(metrics.scroll).be.belowOrEqual(metrics.inner);
            should(await page.locator('[data-warning]').count()).equal(preview.warnings.length);
            for (const item of await page.locator('[data-warning]').all()) {
              should(await item.locator('svg').count()).equal(1);
              should((await item.innerText()).trim().split('\n').length).be.aboveOrEqual(2);
            }
            should(await page.locator('[data-hidden-marker]').count()).be.aboveOrEqual(1);
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
