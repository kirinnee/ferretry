/**
 * Screenshots and checks for a reply that already approves a card ask (&B155): !A304 carried "OK to build" for &F923,
 * the owner replied "ok to build!" in words, and the card stayed in Plan. The card ask now offers that reply as its
 * answer. Phone 390 and desktop 1440, Studio light and dark.
 *
 *   bun harness/reply-approval-screenshot.ts [outDir]   # writes <outDir>/reply-approval-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (`?view=ask-plan-replied`) and FAILS (after writing every picture) when the card ask
 * does not offer the reply with an OK to build button, offers it outside the card ask, or a page scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'reply-approval-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/B155');
const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  if (spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' }).status !== 0) fail(`${command} failed`);
};

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'inbox-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const html = (theme: string) => `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><link rel="stylesheet" href="/app.css" /></head>
<body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-page.js"></script></body></html>`;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    // The stylesheet names its fonts relative to src/styles: serve them, so the pictures use the app's own typefaces.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome');
const browser = await chromium.launch({ executablePath, headless: true });
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
const NOW = new Date('2026-10-29T09:00:00.000Z');
const problems: string[] = [];

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of ['studio-light', 'studio-dark']) {
    const context = await browser.newContext({
      ...(form === 'phone' ? PHONE : DESKTOP),
      timezoneId: 'UTC',
      locale: 'en-US',
      colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    });
    const page = await context.newPage();
    await page.route('**/*', route =>
      route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
    );
    await page.clock.setFixedTime(NOW);
    await page.goto(`${server.url}?theme=${theme}&view=ask-plan-replied&bar=1`);
    const ask = page.locator('[data-agenda-view]:visible [data-agenda-card-ask]').first();
    await ask.waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await ask.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const label = `${form} ${theme}`;
    const found = await page.evaluate(() => {
      const view = [...document.querySelectorAll<HTMLElement>('[data-agenda-view]')].find(
        node => node.getClientRects().length > 0,
      );
      const cardAsk = view?.querySelector('[data-agenda-card-ask]');
      const offer = cardAsk?.querySelector('[data-agenda-reply-offer]');
      return {
        offer: offer?.textContent ?? null,
        offerButton: offer?.querySelector('[data-agenda-reply-offer-use]')?.textContent ?? null,
        buttons: [...(cardAsk?.querySelectorAll('[data-agenda-option]') ?? [])].map(
          node => node.getAttribute('data-agenda-option') ?? '',
        ),
        inNeeds: cardAsk?.closest('[data-agenda-part="needs"]') !== null,
        text: view?.textContent ?? '',
        wide: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    if (!found.buttons.includes('OK to build'))
      problems.push(`${label}: the card ask has no OK to build button (${found.buttons.join(', ') || 'none'})`);
    if (!found.inNeeds) problems.push(`${label}: the card ask is not inside What I need from you`);
    if (found.offer?.includes('You replied “ok to build!”') !== true)
      problems.push(`${label}: the card ask does not offer the reply (${String(found.offer)})`);
    if (found.offerButton !== 'OK to build') problems.push(`${label}: the offer has no OK to build button`);
    if (found.wide > 0) problems.push(`${label}: scrolls sideways by ${found.wide}px`);
    const path = join(outDir, `reply-approval-${form}-${theme}.png`);
    await page.screenshot({ path });
    process.stdout.write(`📸 ${path}\n`);
    await context.close();
  }
}
await browser.close();
server.stop();
if (problems.length > 0) fail(problems.join('\n'));
process.stdout.write('✅ done\n');
