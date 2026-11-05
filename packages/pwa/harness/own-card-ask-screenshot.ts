/**
 * Screenshots and checks for A CARD'S OWN AGENDA asking ONE thing (docs/agenda.md § One ask): the open item for a try-it
 * with a preview link, a try-it without one, a typed "not good" answer, "works now" offered back as "Mark Good?", and a
 * gate that is not a try-it, on a phone (390)
 * and a desktop (1280), in light and dark.
 *
 *   bun harness/own-card-ask-screenshot.ts [outDir]   # writes <outDir>/<state>-<390|1280>-<light|dark>.png
 *
 * It bundles `own-card-ask-page.tsx` and FAILS (after writing every picture) when: a page scrolls sideways; "What I need
 * from you" is missing or holds no one-ask block; a "Card &F61: your answer for the card" box or a "Type your answer below"
 * line is drawn; a Not good button is drawn; a try-it lacks Good, its steps or its words line; an approval says "Try it" or
 * shows a preview; a preview comes second; a "Mark Good?" offer is missing under "works now" (or drawn without a reply, or not
 * right above Good); or typing then sending does not leave the open item with a Not good answer.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'own-card-ask-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/F1167');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};
const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/own-card-ask-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'own-card-ask-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome or Chromium');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
} as const;
const DESKTOP = { viewport: { width: 1_280, height: 900 } } as const;
const NOW = new Date('2026-08-01T12:00:00.000Z');
const STATES = ['preview', 'real', 'typed', 'offer', 'approval'] as const;

const problems: string[] = [];
const check = (ok: boolean, message: string): void => {
  if (ok) return;
  problems.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

for (const state of STATES)
  for (const form of ['phone', 'desktop'] as const)
    for (const theme of ['light', 'dark'] as const) {
      const width = form === 'phone' ? 390 : 1280;
      const label = `${state} ${width} ${theme}`;
      const context = await browser.newContext({
        ...(form === 'phone' ? PHONE : DESKTOP),
        timezoneId: 'UTC',
        locale: 'en-US',
        colorScheme: theme,
      });
      const page = await context.newPage();
      await page.route('**/*', route =>
        route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
      );
      await page.clock.setFixedTime(NOW);
      await page.goto(`${server.url}?theme=studio-${theme}&state=${state}`);
      await page.locator('[data-fixture]').waitFor({ state: 'visible' });
      await page.locator('[data-agenda-need]').waitFor({ state: 'visible' });
      await page.waitForTimeout(300);

      const found = await page.evaluate(() => {
        const need = document.querySelector('[data-agenda-need]');
        const own = document.querySelector('[data-agenda-own-ask]');
        const text = document.body.textContent ?? '';
        const tryIt = document.querySelector('[data-agenda-try-it]')?.textContent ?? '';
        return {
          wide: document.documentElement.scrollWidth - window.innerWidth,
          needTitle: need?.querySelector('.fy-card__need-title')?.textContent ?? '',
          own: own !== null && need?.contains(own) === true,
          cardBox:
            document.querySelector('[data-agenda-card-ask-title]') !== null ||
            text.includes('your answer for the card'),
          typeBelow: text.includes('Type your answer below'),
          notGoodButton: document.querySelector('[data-agenda-option="Not good"]') !== null,
          taps: [...document.querySelectorAll('[data-agenda-answer-option]')].map(
            node => node.textContent?.trim() ?? '',
          ),
          lead: document.querySelector('[data-agenda-typed-lead]')?.textContent ?? '',
          tryIt,
          placeholder: document.querySelector<HTMLTextAreaElement>('[data-fixture-composer]')?.placeholder ?? '',
          saysTryIt: need?.textContent?.includes('Try it') === true,
          offer: document.querySelector('[data-agenda-reply-offer]')?.textContent ?? '',
          offerAboveTaps:
            document
              .querySelector('[data-agenda-reply-offer]')
              ?.nextElementSibling?.matches('[data-agenda-try-taps]') === true,
        };
      });
      check(found.wide <= 0, `${label}: scrolls sideways by ${found.wide}px`);
      check(found.needTitle === 'What I need from you', `${label}: segment is "${found.needTitle}"`);
      check(found.own, `${label}: the one ask is not inside "What I need from you"`);
      check(!found.cardBox, `${label}: a "your answer for the card" box is drawn`);
      check(!found.typeBelow, `${label}: "Type your answer below" is drawn beside the buttons`);
      check(!found.notGoodButton, `${label}: a Not good button is drawn`);
      if (state === 'offer') {
        check(found.offer.includes('You wrote “works now”. Mark Good?'), `${label}: offer is "${found.offer}"`);
        check(found.offerAboveTaps, `${label}: the offer is not right above Good`);
      } else check(found.offer === '', `${label}: an offer is drawn without a reply: "${found.offer}"`);
      if (state === 'approval') {
        check(found.taps.join() === 'OK to build', `${label}: taps are ${found.taps.join() || 'none'}`);
        check(!found.saysTryIt, `${label}: an approval says "Try it"`);
        check(!/preview/iu.test(found.tryIt), `${label}: an approval mentions a preview`);
        check(found.lead.includes('Want something changed first?'), `${label}: approval words line is "${found.lead}"`);
        check(found.placeholder === 'What should change first?', `${label}: placeholder is "${found.placeholder}"`);
      } else {
        check(found.taps.join() === 'Good', `${label}: taps are ${found.taps.join() || 'none'}`);
        check(found.lead.includes('Not good? Type what is wrong'), `${label}: words line is "${found.lead}"`);
        check(found.tryIt.includes('Open') || found.tryIt.includes('Settings'), `${label}: no steps shown`);
        check(found.tryIt.includes('Shipped in Ferretry v5.4.0'), `${label}: no shipped version shown`);
        check(
          found.placeholder === 'What is wrong, or what needs changing?',
          `${label}: placeholder is "${found.placeholder}"`,
        );
        if (state === 'preview')
          check(found.tryIt.trimStart().startsWith('Try it on the preview'), `${label}: the preview is not first`);
        else check(found.tryIt.trimStart().startsWith('There is no preview'), `${label}: no preview line is not first`);
      }

      const scroller = page.locator('.fy-item-view__body, .fy-attn-inbox__deck').first();
      const height = await scroller.evaluate(node => node.scrollHeight).catch(() => 0);
      const viewport = page.viewportSize() ?? { width, height: 844 };
      await page.setViewportSize({
        width: viewport.width,
        height: Math.max(viewport.height, Math.min(height + 260, 2_400)),
      });
      await page.waitForTimeout(150);
      await page.mouse.move(1, 1);
      const path = join(outDir, `${state}-${width}-${theme}.png`);
      await page.screenshot({ path });
      process.stdout.write(`📸 ${path}\n`);

      if (state === 'typed' && theme === 'light') {
        await page.locator('[data-fixture-send]').click();
        await page.waitForTimeout(400);
        const left = await page.evaluate(() => ({
          ask: document.querySelector('[data-agenda-own-ask]') !== null,
          text: document.body.textContent ?? '',
        }));
        check(!left.ask, `${label}: the card is still shown after the typed answer was sent`);
        await page.screenshot({ path: join(outDir, `typed-sent-${width}-${theme}.png`) });
      }
      await context.close();
    }

await browser.close();
server.stop();
if (problems.length > 0) fail(problems.join('\n'));
process.stdout.write('✅ done\n');
