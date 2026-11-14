/**
 * THE MACHINE-SETUP STEPS THIS PLUGIN CONTRIBUTES, in a real browser, over fixed fake data
 * (`fixtures/setup-steps-scene.tsx`): Agent controls, Start from…, and Export settings. Each stays inside the screen, keeps
 * every button a 44px target, and reads in light and dark, on a desktop and on a phone.
 *
 * Set `FY_SETUP_STEPS_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

// The browser's types come from the helper that launches it, so this package declares no browser library of its own.
type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type BrowserContext = Awaited<ReturnType<Browser['newContext']>>;
type Page = Awaited<ReturnType<BrowserContext['newPage']>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETUP_STEPS_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-setup-steps-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/setup-steps-scene.tsx'],
    {
      cwd: packageRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the setup-steps scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const newContext = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark'): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

const open = async (context: BrowserContext, view: string, mode: 'light' | 'dark'): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?view=${view}&theme=studio-${mode}`);
  return tab;
};

/** A screenshot of the WHOLE page: the viewport is made as tall as the page first, so nothing is cut off at the bottom. */
const shootWhole = async (tab: Page, path: string, width: number): Promise<void> => {
  // The page may scroll inside `#root` or `body` rather than the document, so the height is the tallest of them.
  const height = await tab.evaluate(() => {
    const root = document.getElementById('root');
    return Math.ceil(
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, root?.scrollHeight ?? 0),
    );
  });
  await tab.setViewportSize({ width, height: Math.max(height, 200) });
  // Back to the top (earlier clicks scrolled the page) and the pointer away, so no card is left in its hover state.
  await tab.evaluate(() => {
    for (const element of [document.documentElement, document.body, document.getElementById('root')])
      if (element !== null) element.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await tab.mouse.move(0, 0);
  const shown = await tab.evaluate(() => document.getElementById('root')?.getBoundingClientRect().height ?? 0);
  expect(shown, 'the whole page is drawn in the shot').toBeGreaterThan(0);
  await tab.screenshot({ path });
};

/** Picks the one paired machine and reads its review, as a person does. */
const toCopyReview = async (tab: Page): Promise<void> => {
  await tab.locator('input[name="copy-source"]').click();
  await tab.locator('[data-copy-read]').click();
  await tab.waitForSelector('[data-copy-review]');
};

/** On a phone, every control a person presses in the copy flow is a 44px target (the label around a tick or a radio counts). */
const tapTargetsAreBigEnough = async (tab: Page): Promise<void> => {
  const targets = tab.locator(
    '[data-copy-review] label:has(input), [data-copy-review] button, [data-copy-review] select',
  );
  for (let at = 0; at < (await targets.count()); at += 1) {
    const height = (await targets.nth(at).boundingBox())?.height ?? 0;
    const which = (await targets.nth(at).evaluate(element => element.outerHTML)).slice(0, 160);
    expect(height, `a tap target is under 44px tall: ${which}`).toBeGreaterThanOrEqual(43);
  }
};

const insideScreen = async (tab: Page, selector: string, width: number): Promise<void> => {
  const boxes = tab.locator(selector);
  for (let at = 0; at < (await boxes.count()); at += 1) {
    const box = await boxes.nth(at).boundingBox();
    // An element that draws nothing (an <option> inside a closed menu) has no box to be outside the screen.
    if (box === null) continue;
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);
  }
};

describe('the machine-setup steps', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`Agent controls: five switches, the default runtime, a Save once one is flipped (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'controls', mode);
        await tab.waitForSelector('[data-agent-control]');
        expect(await tab.locator('[data-switch-row]').count()).toBe(5);
        await tab.locator('[data-switch-row="Ferretry settings"] [role="switch"]').click();
        await tab.locator('[data-switch-row="Page scripts"] [data-switch-info]').click();
        await tab.getByText('Save what agents may control').waitFor();
        await tab.waitForSelector('[data-default-runtime]');
        await insideScreen(tab, '[data-switch-row], [data-default-runtime]', viewport.width);
        for (const switchButton of await tab.locator('[role="switch"]').all())
          expect((await switchButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `agent-controls-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);

      it(`Start from…: a fresh setup, and a copy with no other machine paired (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'start', mode);
        await tab.waitForSelector('[data-onboarding-step-body="start"]');
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `start-from-fresh-${viewport.name}-${mode}.png`) });
        await tab.getByText('Copy settings from another machine').click();
        await tab.waitForSelector('[data-copy-no-sources]');
        // With no machine to copy from there is no Review button to look pressable.
        expect(await tab.locator('[data-copy-read]').count()).toBe(0);
        await insideScreen(tab, '[data-onboarding-step-body="start"] *', viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `start-from-copy-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);

      it(`Copy review: every command and script in full, with its tick (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'copy-first', mode);
        await toCopyReview(tab);
        const text = await tab.locator('[data-copy-review]').innerText();
        expect(text).toContain('bash ./guard.sh');
        expect(text).toContain('echo "guard ran for $1"');
        expect(text).toContain('node ./notes-server.js --port 4100');
        expect(text).toContain('AWS_PROFILE');
        expect(await tab.locator('[data-copy-runnable] input[type="checkbox"]').count()).toBe(2);
        expect(await tab.locator('[data-copy-item-tick="profile/dev"]').count()).toBe(1);
        await insideScreen(tab, '[data-copy-review] *', viewport.width);
        if (viewport.phone) await tapTargetsAreBigEnough(tab);
        if (shotsDir !== '')
          await shootWhole(tab, join(shotsDir, `copy-review-${viewport.name}-${mode}.png`), viewport.width);
        await context.close();
      }, 60_000);

      it(`Copy, repeat: a both-changed key blocks Preview; Update, Add alongside, Start over and the default runtime (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'copy-update', mode);
        await toCopyReview(tab);
        // Nothing is ticked for the person: the settings start unticked, and the changed command shows in full.
        expect(await tab.locator('[data-copy-settings-tick="voice.yaml"]').isChecked()).toBe(false);
        expect(await tab.locator('[data-copy-review]').innerText()).toContain('--port 4200 --verbose');
        await tab.locator('[data-copy-settings-tick="voice.yaml"]').check();
        await tab.locator('[data-copy-undecided]').waitFor();
        expect(await tab.locator('[data-copy-stage]').isDisabled()).toBe(true);
        // The both-changed item is what blocks it, and the screen says so beside the disabled button.
        expect(await tab.locator('[data-copy-undecided]').innerText()).toContain('profile/dev');
        expect(await tab.locator('[data-copy-undecided]').innerText()).toContain('voice.yaml: engine');
        await insideScreen(tab, '[data-copy-review] *', viewport.width);
        if (viewport.phone) await tapTargetsAreBigEnough(tab);
        if (shotsDir !== '')
          await shootWhole(tab, join(shotsDir, `copy-blocked-${viewport.name}-${mode}.png`), viewport.width);
        await tab.locator('[data-setup-choice="replace"]').click();
        await tab.locator('[data-setup-section="copy-default-runtime"]').waitFor();
        expect(await tab.locator('[data-setup-section="copy-default-runtime"]').innerText()).not.toContain(
          'plain-shell',
        );
        await insideScreen(tab, '[data-copy-review] *', viewport.width);
        if (shotsDir !== '')
          await shootWhole(tab, join(shotsDir, `copy-modes-${viewport.name}-${mode}.png`), viewport.width);
        await context.close();
      }, 60_000);

      it(`Copy, done: what was NOT brought, the sign-in and the key to add (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'copy-done', mode);
        await toCopyReview(tab);
        // Leave both settings documents out: Done must say they were not copied.
        await tab.locator('[data-copy-settings-tick="warden.yaml"]').uncheck();
        await tab.locator('[data-copy-settings-tick="voice.yaml"]').uncheck();
        await tab.locator('[data-copy-stage]').click();
        await tab.waitForSelector('[data-copy-confirm]');
        expect(await tab.locator('[data-copy-description]').innerText()).toContain('bash ./guard.sh');
        await tab.locator('[data-change-submit]').click();
        await tab.waitForSelector('[data-copy-done]');
        const done = await tab.locator('[data-copy-done]').innerText();
        expect(done).toContain('Copied 4 items from work-mac.');
        expect(await tab.locator('[data-setup-note="copy-not-written"]').innerText()).toContain('Warden');
        expect(await tab.locator('[data-setup-note="copy-sign-ins"]').innerText()).toContain('bedrock');
        expect(await tab.locator('[data-setup-note="copy-missing-keys"]').innerText()).toContain('NOTES_KEY');
        await insideScreen(tab, '[data-copy-done] *', viewport.width);
        if (shotsDir !== '')
          await shootWhole(tab, join(shotsDir, `copy-done-${viewport.name}-${mode}.png`), viewport.width);
        await context.close();
      }, 60_000);

      it(`Export settings: the listing, one file left out, no secret (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'export', mode);
        await tab.locator('[data-export-run]').click();
        await tab.waitForSelector('[data-setup-section="export-manifest"]');
        // The listing keeps each name whole and scrolls INSIDE its own block: a file name is never broken across lines,
        // and the page itself does not scroll sideways.
        const listing = tab.locator('[data-setup-section="export-manifest"] pre');
        expect(await listing.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('pre');
        expect(await listing.evaluate(element => getComputedStyle(element).overflowX)).toBe('auto');
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(await listing.innerText()).toContain('ferretry-settings-studio-mac-2026-11-14.zip');
        expect(await tab.locator('[data-setup-section="export-manifest"]').innerText()).toContain('config/warden.yaml');
        expect(await tab.locator('[data-setup-section="export-manifest"]').innerText()).not.toContain(
          'logins/work.yaml',
        );
        await tab.waitForSelector('[data-export-left-out], [data-setup-note="export-left-out"]');
        await insideScreen(tab, '[data-export-settings] *', viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `export-settings-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);
    }
});
