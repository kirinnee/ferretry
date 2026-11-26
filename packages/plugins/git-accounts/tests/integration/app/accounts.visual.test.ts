/**
 * THE GITHUB ACCOUNTS SCREEN in a real browser over fake data (`fixtures/accounts-scene.tsx`): empty, the consent words,
 * the waiting code card, the code card asking for the passkey press, two connected accounts and an expired code, light and dark, 390 and 1280 wide. The page never
 * scrolls sideways and the code is on screen in full.
 *
 * Set `FY_GIT_ACCOUNTS_SHOTS_DIR` to keep `<viewport>-<theme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_GIT_ACCOUNTS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-git-accounts-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/accounts-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the accounts scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = ([390, 1440] as const).flatMap(width =>
  (['light', 'dark'] as const).flatMap(scheme =>
    (['studio', 'neumorphism'] as const).map(style => ({
      name: `${width}-${scheme}-${style}`,
      width,
      phone: width === 390,
      scheme,
      style,
    })),
  ),
);
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant, query: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: 1_100 },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}${query}`);
  await tab.waitForSelector('[data-testid="git-accounts"]');
  await tab.evaluate(style => document.documentElement.setAttribute('data-style', style), variant.style);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  const overflow = await tab.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${variant.name} ${name}: no sideways scroll`).toBeLessThanOrEqual(0);
  if (shotsDir !== '')
    await tab
      .locator('[data-testid="git-accounts"]')
      .screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const press = async (tab: Page, name: string): Promise<void> => {
  await tab.getByRole('button', { name, exact: true }).click();
};

describe('the GitHub accounts screen', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: empty, consent words, waiting code, connected accounts, expired code`, async () => {
      const empty = await open(variant, '');
      try {
        await empty.tab.waitForSelector('[data-testid="git-accounts-empty"]');
        await shot(empty.tab, variant, 'empty');
        await press(empty.tab, 'Connect a GitHub account');
        await empty.tab.waitForSelector('[data-testid="git-consent"]');
        await shot(empty.tab, variant, 'consent-ssh');
        expect(await empty.tab.locator('[data-testid="git-consent"]').innerText()).not.toContain('admin:gpg_key');
        await empty.tab.getByRole('radio', { name: 'GPG', exact: true }).check();
        expect(await empty.tab.locator('[data-testid="git-consent"]').innerText()).toContain('admin:gpg_key');
        await shot(empty.tab, variant, 'consent-gpg');
        await press(empty.tab, 'Continue to GitHub');
        await empty.tab.waitForSelector('[data-testid="git-user-code"]');
        expect(await empty.tab.locator('[data-testid="git-user-code"]').innerText()).toBe('WDJB-MJHT');
        expect(await empty.tab.locator('[data-testid="git-countdown"]').innerText()).toBe('15:00');
        await shot(empty.tab, variant, 'waiting');
        expect(empty.problems).toEqual([]);
      } finally {
        await empty.close();
      }

      const two = await open(variant, '&accounts=two');
      try {
        await two.tab.waitForSelector('[data-account]');
        await shot(two.tab, variant, 'connected');
        const hubot = two.tab.locator('[data-account="gha_777"]');
        await hubot.getByRole('radio', { name: 'GPG', exact: true }).check();
        await shot(two.tab, variant, 'signing-choice');
        await hubot.getByRole('button', { name: 'Create GPG signing key' }).click();
        await hubot.getByText('Signing with GPG.').waitFor();
        await shot(two.tab, variant, 'gpg-signing');
        await hubot.getByRole('button', { name: 'Change signing key' }).click();
        await shot(two.tab, variant, 'revoke-signing');
        await press(two.tab, 'Remove @octo-fake');
        await shot(two.tab, variant, 'remove');
        expect(two.problems).toEqual([]);
      } finally {
        await two.close();
      }

      const stepUp = await open(variant, '&poll=stepup');
      try {
        await press(stepUp.tab, 'Connect a GitHub account');
        await press(stepUp.tab, 'Continue to GitHub');
        await stepUp.tab.waitForSelector('[data-testid="git-step-up"]');
        expect(await stepUp.tab.locator('[data-testid="git-user-code"]').innerText()).toBe('WDJB-MJHT');
        await shot(stepUp.tab, variant, 'step-up');
        expect(stepUp.problems).toEqual([]);
      } finally {
        await stepUp.close();
      }

      const uncertain = await open(variant, '&accounts=two&uploads=uncertain');
      try {
        await press(uncertain.tab, 'Remove @octo-fake');
        await press(uncertain.tab, 'Remove @octo-fake');
        await uncertain.tab.locator('[data-testid="git-removed"]').waitFor();
        expect(await uncertain.tab.locator('[data-testid="git-removed"]').innerText()).toContain(
          'confirm who registered each key',
        );
        await shot(uncertain.tab, variant, 'uncertain-upload');
      } finally {
        await uncertain.close();
      }

      const pending = await open(variant, '&accounts=pending');
      try {
        await pending.tab.getByText('Signing stopped. Key cleanup is pending.').waitFor();
        await shot(pending.tab, variant, 'pending-cleanup');
      } finally {
        await pending.close();
      }

      const expired = await open(variant, '&poll=expired');
      try {
        await press(expired.tab, 'Connect a GitHub account');
        await press(expired.tab, 'Continue to GitHub');
        await expired.tab.waitForSelector('[data-testid="git-expired"]');
        await shot(expired.tab, variant, 'expired');
        expect(expired.problems).toEqual([]);
      } finally {
        await expired.close();
      }
    });
  }
});
