/**
 * THE FIRST RUN IS ROUND-SAFE, PAGE BY PAGE (owner ask &B210; PR 2559 review: "first-run onboarding/setup"). The REAL app over the
 * onboarding scene (`fixtures/onboarding-e2e-scene.tsx`: an empty paired list, one fake machine that pairs by the fixed fake
 * code; no daemon, no network) is walked as a first-time person walks it, at a phone (390) and a desktop (1440), light and dark,
 * in the default look (Studio) and the two roundest looks (Gen Z, Neumorphism). On EVERY page it stops at, it asserts the
 * geometric rule of `round-safe.ts`: no content leaves the inner rounded rectangle of the box it sits in.
 *
 *   start -> install -> daemon -> open -> pair (paste, confirm) -> every page of the setup flow (Next, or Later where Next waits for a
 *   choice) -> the end page.
 *
 * `FY_ROUND_SAFE_LOOKS=genz,studio` narrows the looks; `FY_ROUND_SAFE_SHOTS_DIR` keeps `<look>-<viewport>-<scheme>-<nn>-<page>.png`.
 * The pages it reached are asserted (at least the pairing pages and the first setup page) so a flow that stops early cannot pass silently.
 */
import { afterAll, beforeAll, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneServer, sharedChromium } from '../support/browser/index.ts';
import { MACHINE_A, pairLinkOf } from './fixtures/onboarding-e2e-daemon.ts';

setDefaultTimeout(280_000);

const shotsDir = process.env.FY_ROUND_SAFE_SHOTS_DIR ?? '';
const onlyLooks = (process.env.FY_ROUND_SAFE_LOOKS ?? '').split(',').filter(Boolean);
const scene = new URL('./fixtures/onboarding-e2e-scene.tsx', import.meta.url).pathname;

let browser: Browser;
let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';

beforeAll(async () => {
  browser = await sharedChromium();
  server = Bun.spawn([process.execPath, sceneServer, '--entry', scene], { stderr: 'inherit', stdout: 'pipe' });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 90_000)),
  ]);
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 120_000);

afterAll(() => {
  server?.kill();
});

const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
].filter(look => onlyLooks.length === 0 || onlyLooks.includes(look.style));
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

/** Where the person is, for a name: the flow's page key, the end page, or the onboarding screen. */
const whereOf = async (tab: Page): Promise<string> =>
  await tab.evaluate(() => {
    if (document.querySelector('[data-flow-end]') !== null) return 'end';
    const flow = document.querySelector('[data-flow-page]')?.getAttribute('data-flow-page');
    if (flow) return flow;
    const screen = document.querySelector('[data-onboarding]')?.getAttribute('data-onboarding-screen');
    if (screen) return `onboarding-${screen}`;
    return document.querySelector('[data-pair-confirm]') !== null ? 'pair-confirm' : 'page';
  });

for (const look of LOOKS) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`first run: ${look.style} ${viewport.name} ${scheme}`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          reducedMotion: 'reduce',
        });
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        tab.setDefaultTimeout(60_000);
        const visited: string[] = [];
        const failures: string[] = [];
        let count = 0;
        const check = async (name: string): Promise<void> => {
          await tab.waitForTimeout(600);
          await tab.evaluate(async () => await document.fonts.ready);
          count += 1;
          const label = `${String(count).padStart(2, '0')}-${name}`;
          visited.push(name);
          if (shotsDir !== '')
            await tab.screenshot({
              path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${label}.png`),
              fullPage: true,
            });
          const misses = await roundSafeMisses(tab);
          if (misses.length > 0) failures.push(`${label}:\n${describeRoundMisses(misses)}`);
        };
        try {
          await tab.goto(
            `${origin}/pair?theme=${look.palette}-${scheme}&style=${look.style}&palette=${look.palette}&mode=${scheme}`,
          );
          await tab.waitForSelector('[data-slot="nav"], [data-slot="bottom"], .fy-main');
          await tab.evaluate(() => {
            history.pushState(null, '', '/');
            dispatchEvent(new PopStateEvent('popstate'));
          });
          await tab.waitForSelector('[data-choice-cards]');
          await check('start');
          await tab.locator('label[data-choice="first-time"]').click();
          await tab.locator('[data-onboarding-continue]').click();
          await tab.waitForSelector('[data-onboarding-next]');
          await check('install');
          await tab.locator('[data-onboarding-next]').click();
          await tab.waitForSelector('[data-onboarding-next]');
          await check('daemon');
          await tab.locator('[data-onboarding-next]').click();
          await tab.waitForSelector('[data-onboarding-back]');
          await check('open');
          await tab.getByText('It did not open a browser').click();
          await tab.locator('[data-onboarding-open-pair]').click();
          await tab.getByText('Paste a link').click();
          await check('pair-paste');
          await tab.getByLabel('Pairing link').fill(pairLinkOf(MACHINE_A, origin));
          await tab.getByText('Use this link').click();
          await tab.locator('[data-pair-confirm]').waitFor();
          await check('pair-confirm');
          await tab.locator('[data-pair-confirm]').click();
          await tab.waitForURL(/\/onboarding\/setup/u);
          // The setup flow: Next where it moves on, Later where Next waits for a choice, until the end page.
          let lastHere = '';
          let stalled = 0;
          for (let step = 0; step < 24; step += 1) {
            await tab
              .waitForFunction(
                () =>
                  document.querySelector('[data-flow-end]') !== null ||
                  document.querySelector('[data-flow-page][data-ready]') !== null,
                undefined,
                { timeout: 20_000 },
              )
              .catch(() => undefined);
            const here = await whereOf(tab);
            await check(here);
            if (here === 'end') break;
            stalled = here === lastHere ? stalled + 1 : 0;
            lastHere = here;
            if (stalled >= 2) break;
            if (here === 'claude-code.sign-in') {
              // The page refuses Next until the person is signed in: sign in with the fake code, as the end-to-end walk does.
              await tab
                .locator('[data-harness-sign-in="claude-code"] button', { hasText: 'Sign in to Claude Code' })
                .click();
              await tab.locator('[data-claude-login-code] input').waitFor({ state: 'visible' });
              await tab.locator('[data-claude-login-code] input').fill('FAKE-CODE-0001');
              await check('claude-code.sign-in-link');
              await tab.getByRole('button', { name: 'Finish sign-in' }).click();
              await tab.locator('[data-flow-commit-error]').waitFor({ state: 'detached' });
              await tab.waitForFunction(() => document.querySelector('[data-step-next] .fy-spinner') === null);
            }
            const button = tab.locator('[data-step-next]:not([disabled])');
            const later = tab.locator('[data-step-later]:not([disabled])');
            if ((await button.count()) > 0) await button.first().click();
            else if ((await later.count()) > 0) await later.first().click();
            else break;
            await tab
              .waitForFunction(
                previous =>
                  document.querySelector('[data-flow-end]') !== null ||
                  document.querySelector('[data-flow-page]')?.getAttribute('data-flow-page') !== previous,
                here,
                { timeout: 15_000 },
              )
              .catch(() => undefined);
          }
          expect(visited.slice(0, 6), 'the pairing pages were reached').toEqual([
            'start',
            'install',
            'daemon',
            'open',
            'pair-paste',
            'pair-confirm',
          ]);
          expect(visited.length, `the setup flow was walked (${visited.join(' > ')})`).toBeGreaterThan(8);
          expect(failures, `\n${failures.join('\n')}`).toEqual([]);
        } finally {
          console.log(`first run ${look.style} ${viewport.name} ${scheme}: ${visited.join(' > ')}`);
          await context.close();
        }
      });
    }
  }
}
