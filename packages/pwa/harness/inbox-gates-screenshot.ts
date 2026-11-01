/**
 * Screenshots and checks for the Inbox's gate items and the compass: the list with a gate item among the question
 * items, a gate item open, a question item open, each held mid-swipe at ↓ (Skip) and at ↓↓↓ (the three snooze lengths
 * showing, 4 h lit), and the "Not good" why composer. Phone 390 and desktop 1440, Studio light and dark.
 *
 *   bun harness/inbox-gates-screenshot.ts [outDir] [series]   # writes <outDir>/<series>-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage`, invented data), serves it on an ephemeral loopback port and
 * drives it with REAL touch input (the swipe is touch only). It FAILS (after writing every picture) when a page scrolls
 * sideways, the gate item lacks its stage / project / lane / How to test, a held drag does not read as the compass slot
 * it would pick, the three snooze lengths do not show at ↓↓↓, a cancelled drag sends or holds anything, Not good sends
 * before there are words, or the Not needed button does not hold an Undo-able dismissal.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type CDPSession, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'inbox-gates-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/briefs/gated/shots-c');
const series = process.argv[3] ?? 'inbox-gates';

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-page.js"></script></body>
</html>`;

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

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
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
const DESKTOP = { viewport: { width: 1_440, height: 900 }, hasTouch: true } as const;
const NOW = new Date('2026-10-29T09:00:00.000Z');
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
const THEMES = (process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark').split(',');
type Form = 'phone' | 'desktop';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const open = async (context: { newPage: () => Promise<Page> }, theme: string, view: string): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=${theme}&view=${view}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${view}: scrolls sideways by ${wide}px`);
  return page;
};

const backgroundLightness = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const paint = (element: Element): string => getComputedStyle(element).backgroundColor;
    const colour = [document.body, document.documentElement]
      .map(paint)
      .find(value => !/rgba\(0, 0, 0, 0\)|transparent/u.test(value));
    const [r = 255, g = 255, b = 255] = (colour ?? 'rgb(255,255,255)').match(/\d+(\.\d+)?/gu)?.map(Number) ?? [];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.waitForTimeout(120);
  const light = await backgroundLightness(page);
  check(
    theme.endsWith('-dark') ? light < 0.35 : light > 0.65,
    `${name} ${form} ${theme}: the page is not ${theme.endsWith('-dark') ? 'dark' : 'light'} (lightness ${light.toFixed(2)})`,
  );
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${name} ${form} ${theme}: scrolls sideways by ${wide}px`);
  const path = join(outDir, `${series}-${name}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const touch = (
  client: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  x?: number,
  y?: number,
) =>
  client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: x === undefined || y === undefined ? [] : [{ x, y }],
  });

/** The compass's own geometry (`agenda-compass.ts`): the Skip threshold of a card this wide, and a compass row. */
const thresholdOf = (width: number): number => Math.min(160, Math.max(96, width * 0.35));
const ROW = 56;

/** A finger on the who-and-what line, dragged to (dx, dy) and kept down. */
const hold = async (page: Page, client: CDPSession, dx: number, dy: number): Promise<void> => {
  const grip = await page.locator('.fy-attn-deck__top [data-inbox-who]').boundingBox();
  if (grip === null) return fail('the open item has no who-and-what line to grab');
  const x = grip.x + 24;
  const y = grip.y + grip.height / 2;
  await touch(client, 'touchStart', x, y);
  await touch(client, 'touchMove', x + Math.sign(dx) * 14, y + Math.sign(dy) * 14);
  for (let step = 1; step <= 8; step += 1) await touch(client, 'touchMove', x + (dx * step) / 8, y + (dy * step) / 8);
  await page.waitForTimeout(150);
};

const compassSteps = async (page: Page, client: CDPSession, name: string, form: Form, theme: string): Promise<void> => {
  const width = (await page.locator('.fy-attn-deck__top').boundingBox())?.width ?? 0;
  const threshold = thresholdOf(width);
  const reveal = page.locator('[data-swipe-compass]');
  const committedBefore = await page.evaluate(
    () => (window as unknown as { __committed: unknown[] }).__committed.length,
  );
  for (const [step, dy, slot] of [
    ['down', threshold + 24, 'down'],
    ['down-down-down', threshold + 2 * ROW + 24, 'down-down-4h'],
  ] as const) {
    await hold(page, client, 0, dy);
    check(
      (await reveal.getAttribute('data-swipe-reveal')) === slot,
      `${name} ${form} ${theme} ${step}: the compass does not read as ${slot}`,
    );
    if (step === 'down-down-down')
      check(
        (await reveal.locator('[data-compass-length]').count()) === 3,
        `${name} ${form} ${theme}: the three snooze lengths are not showing at ↓↓↓`,
      );
    await shot(page, `${name}-compass-${step}`, form, theme);
    await touch(client, 'touchCancel');
    await page.waitForTimeout(200);
  }
  const after = await page.evaluate(() => (window as unknown as { __committed: unknown[] }).__committed.length);
  check(after === committedBefore, `${name} ${form} ${theme}: a cancelled compass drag sent something`);
  check(
    (await page.locator('[data-agenda-undo-button]').count()) === 0,
    `${name} ${form} ${theme}: a cancelled compass drag left something to undo`,
  );
};

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      ...(form === 'phone' ? PHONE : DESKTOP),
      ...LOCALE,
      colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    });
    await context.addInitScript(
      ([family, mode]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family, mode, textScale: 'default' })),
      [theme.slice(0, theme.lastIndexOf('-')), theme.slice(theme.lastIndexOf('-') + 1)] as const,
    );

    // ONE stream: the gate item sits among the question items.
    const list = await open(context, theme, 'gate-list');
    check(
      (await list.getByText('Pairing a second phone').count()) > 0,
      `${form} ${theme}: the gate item is not in the Inbox list`,
    );
    await shot(list, 'list', form, theme);

    // A gate item open: what it is, where it waits, how to test it, and its options.
    const gate = await open(context, theme, 'gate');
    check(
      (await gate.locator('[data-inbox-gate-stage]').textContent()) === 'Try it' &&
        (await gate.locator('[data-inbox-gate-project]').textContent()) === 'ferretry' &&
        (await gate.locator('[data-inbox-open-chat]').count()) === 1 &&
        (await gate.locator('[data-inbox-who]').count()) === 1,
      `${form} ${theme}: the gate line does not say stage, project and lane`,
    );
    check(
      ((await gate.locator('.fy-attn-deck__top').textContent()) ?? '').includes('Scan the code from a second phone'),
      `${form} ${theme}: the gate item lacks its How to test steps`,
    );
    check(
      (await gate.locator('.fy-attn-deck__top .fy-item-view__bar [data-agenda-snooze]').count()) === 1 &&
        (await gate.locator('.fy-attn-deck__top [data-inbox-card-tools] [data-inbox-snooze]').count()) === 0,
      `${form} ${theme}: the head has no snooze clock, or the card still has its own snooze buttons`,
    );
    check(
      (await gate.locator('.fy-attn-deck__top .fy-card__type').count()) === 0,
      `${form} ${theme}: the gate card still wears a chip`,
    );
    check(
      ((await gate.locator('.fy-attn-deck__top').textContent()) ?? '').includes('Pick one option') === false &&
        (await gate.locator('.fy-attn-deck__top [data-test-tick]').count()) > 0,
      `${form} ${theme}: the gate card says "Pick one option." or lacks its tick-steps`,
    );
    check(
      (await gate.locator('.fy-attn-deck__top button', { hasText: /not needed/i }).count()) === 1,
      `${form} ${theme}: Not needed does not show exactly once on the gate card`,
    );
    check(
      (await gate.locator('[data-inbox-composer]').count()) === 0,
      `${form} ${theme}: a gate item has a Reply composer under it`,
    );
    check(
      (await gate.locator('.fy-attn-deck__top [data-agenda-title][data-wrap]').count()) === 1,
      `${form} ${theme}: the gate title does not wrap`,
    );
    const done = await gate.locator('.fy-attn-deck__top [data-agenda-option="Done"]').boundingBox();
    const bad = await gate.locator('.fy-attn-deck__top [data-agenda-option="Not good"]').boundingBox();
    check(done !== null && bad !== null && done.x < bad.x, `${form} ${theme}: Done is not left of Not good`);
    await shot(gate, 'gate', form, theme);
    const gateClient = await context.newCDPSession(gate);
    await compassSteps(gate, gateClient, 'gate', form, theme);

    // Not good: asks for words first; nothing is sent until there are some.
    await gate.locator('.fy-attn-deck__top [data-agenda-option="Not good"]').click();
    await gate.locator('[data-inbox-gate-why]').waitFor({ state: 'visible' });
    check(
      await gate.locator('[data-inbox-gate-why] button[type="submit"]').isDisabled(),
      `${form} ${theme}: Send back is enabled before there are words`,
    );
    check(
      (await gate.evaluate(() => (window as unknown as { __committed: unknown[] }).__committed.length)) === 0,
      `${form} ${theme}: Not good sent before there were words`,
    );
    await gate.locator('[data-inbox-gate-why] textarea').fill('The code never appears on the second phone.');
    await shot(gate, 'not-good-composer', form, theme);

    // Not needed: a button that holds a dismissal in the undo window, and Undo takes it back.
    const question = await open(context, theme, 'open');
    await question.locator('.fy-attn-deck__top [data-inbox-tool="not-needed"]').click();
    check(
      (await question.locator('[data-agenda-undo-button]').count()) === 1,
      `${form} ${theme}: Not needed did not open the undo window`,
    );
    await shot(question, 'not-needed-undo', form, theme);
    await question.locator('[data-agenda-undo-button]').click();
    check(
      (await question.locator('[data-agenda-undo-button]').count()) === 0,
      `${form} ${theme}: Undo did not take the dismissal back`,
    );

    // The compass is for every item: a plain question item gets it too.
    const asked = await open(context, theme, 'open');
    await shot(asked, 'question', form, theme);
    await compassSteps(asked, await context.newCDPSession(asked), 'question', form, theme);
    await context.close();
  }
}

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
