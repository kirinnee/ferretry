/**
 * THE MOVE DIALOG IN A REAL BROWSER over two scripted machines (`fixtures/move-scene.tsx`): pick a machine, the review table (what
 * moves, what stays, what is left behind by name), a review the target refuses, the progress at rest (a chunk held), and the done
 * state with "Open on <machine>". At 390 and 1440 wide, light and dark, in the default look (Studio) and the roundest (Gen Z).
 * Real presses; no network (the browser may reach nothing but the scene). Every state must fit its box: no sideways scroll, and
 * no content outside the inner rounded rectangle of a rounded box (`roundSafeMisses`).
 *
 * Set `FY_MOVE_SHOTS_DIR` to keep `<width>-<scheme>-<style>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_MOVE_SHOTS_DIR ?? '';
const shotStates = new Set(process.env.FY_MOVE_SHOT_STATES?.split(',') ?? []);

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-move-'));
  const build = async (entry: string, out: string, script: string) => {
    const child = Bun.spawn([process.execPath, sceneBuilder, '--out', out, '--entry', entry], {
      cwd: packageRoot,
      // The composition fixture lives outside the scene cache's package globs.
      env: { ...process.env, ...(entry.includes('recover-scene') ? { FY_FIXTURE_CACHE: 'off' } : {}) },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`the move scene did not build (${code}):\n${stderr}\n${stdout}`);
    const built = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
    const css = await readFile(built.css, 'utf8');
    const js = await readFile(built.js, 'utf8');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="${script}"></script></body></html>`;
    return { html, js };
  };
  const move = await build('fixtures/move-scene.tsx', directory, '/app.js');
  const actions = await build(
    '../../../../../core/ferrets/tests/integration/app/fixtures/offered-rows-scene.tsx',
    join(directory, 'actions'),
    '/actions.js',
  );
  // scripts/test composes packages without owning workspace dependencies. Build the verbatim fixture in a disposable
  // workspace with Relocate's existing dependency links; never install into or write the checkout during a test.
  const workspace = join(directory, 'recover-workspace');
  const entry = join(workspace, 'scripts/test/relocate/recover-scene.tsx');
  await mkdir(join(workspace, 'scripts/test/relocate'), { recursive: true });
  await symlink(resolve(packageRoot, '../../../node_modules'), join(workspace, 'node_modules'), 'dir');
  await symlink(resolve(packageRoot, '../../../../..'), join(workspace, 'packages'), 'dir');
  await copyFile(resolve(packageRoot, '../../../../../../scripts/test/relocate/recover-scene.tsx'), entry);
  const recover = await build(entry, join(directory, 'recover'), '/recover.js');
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.FY_MOVE_TEST_PORT ?? 7489),
    fetch: request => {
      const path = new URL(request.url).pathname;
      const scene = path.startsWith('/recover') ? recover : path.startsWith('/actions') ? actions : move;
      return path.endsWith('.js')
        ? new Response(scene.js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(scene.html, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const WIDTHS = [390, 1440] as const;
const SCHEMES = ['light', 'dark'] as const;
const STYLES = ['studio', 'genz'] as const;

async function states(width: number, scheme: string, style: string): Promise<void> {
  const phone = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: phone ? 900 : 1000 },
    deviceScaleFactor: phone ? 2 : 1,
    hasTouch: phone,
    isMobile: phone,
    colorScheme: scheme as 'light' | 'dark',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const problems: string[] = [];
  const open = async (query: string): Promise<Page> => {
    const tab = await context.newPage();
    tab.on('pageerror', error => problems.push(error.message));
    const actions = query.includes('actions=1');
    await tab.goto(
      `${origin}/${actions ? 'actions' : ''}?theme=studio-${scheme}&style=${style}${query}${actions ? `&move=1&compact=${phone ? '1' : '0'}` : ''}`,
    );
    await tab.waitForSelector('[data-move-step="pick"], [data-actions-scene], [data-stub-scene]');
    return tab;
  };
  const name = (state: string) => `${String(width)}-${scheme}-${style}-${state}`;
  const settle = async (tab: Page, state: string) => {
    await tab.mouse.move(0, 0);
    await tab.waitForTimeout(350);
    if (shotsDir !== '' && (shotStates.size === 0 || shotStates.has(state)))
      await tab.screenshot({ path: join(shotsDir, `${name(state)}.png`) });
    expect(
      await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      `${name(state)}: no sideways scroll`,
    ).toBeLessThanOrEqual(0);
    const misses = await roundSafeMisses(tab);
    expect(misses.length, `${name(state)}: ${describeRoundMisses(misses)}`).toBe(0);
  };
  try {
    const actions = await open('&actions=1');
    expect(await actions.textContent('[data-actions-scene]')).toContain('Move to another machine…');
    await settle(actions, 'actions-row');
    const stub = await open('&moved=1');
    expect(await stub.textContent('[data-stub-scene]')).toContain('Moved to another machine');
    expect(await stub.textContent('[data-stub-scene]')).not.toContain('fy_daemon_');
    expect(await stub.textContent('[data-stub-scene]')).toContain('Open there');
    expect(await stub.getAttribute('[data-moved-to]', 'href')).toContain('/chat/g9');
    await settle(stub, 'moved-stub');
    const picker = await open('');
    expect(await picker.textContent('[data-move-step="pick"]')).toContain('Laptop');
    expect(await picker.textContent('[data-move-step="pick"]')).toContain('offline');
    expect(await picker.locator('[data-move-release]').count()).toBe(0);
    await settle(picker, 'pick');
    await picker.click('text=Check what would move');
    await picker.waitForSelector('[data-move-step="review"]');
    expect(await picker.locator('[data-move-release]').count()).toBe(0);
    const table = (await picker.textContent('[data-move-step="review"]')) ?? '';
    expect(table).toContain('Moves with it');
    expect(table).toContain('Stays on this machine');
    expect(table).toContain('Left behind by name: .env, node_modules, deploy.pem');
    await settle(picker, 'review');
    await picker.click('text=Move to Laptop');
    await picker.waitForSelector('[data-move-step="done"]');
    expect(await picker.textContent('[data-move-step="done"]')).toContain('Open on Laptop');
    expect(await picker.getAttribute('[data-move-step="done"] a', 'href')).toContain('/chat/g9');
    await settle(picker, 'done');

    const recovery = await open('&recovery=1');
    await recovery.click('text=Check what would move');
    await recovery.click('text=Move to Laptop');
    await recovery.waitForSelector('[data-move-step="done"]');
    const receipt = (await recovery.textContent('[data-move-step="done"]')) ?? '';
    expect(receipt).toContain('stopped');
    expect(receipt).toContain('Turns and attachments could not be restored.');
    expect(receipt).toContain('/work/project-feature-handoff-ab12');
    expect(receipt).not.toContain('now running');
    await settle(recovery, 'recovery');

    const unconfirmed = await open('&unconfirmed=1');
    await unconfirmed.click('text=Check what would move');
    await unconfirmed.click('text=Move to Laptop');
    await unconfirmed.waitForSelector('[data-move-recovery]');
    expect(await unconfirmed.textContent('[data-move-step="done"]')).toContain('Moved, not started');
    expect(await unconfirmed.textContent('[data-move-recovery]')).toContain('its current state is unknown');
    await settle(unconfirmed, 'not-started');
    await unconfirmed.click('text=Retry completion and start');
    await unconfirmed.waitForFunction(() =>
      document.querySelector('[data-move-step="done"]')?.textContent?.includes('now running'),
    );

    const released = await open('&unconfirmed=1');
    await released.click('text=Check what would move');
    await released.click('text=Move to Laptop');
    await released.waitForSelector('[data-move-recovery]');
    await released.click('text=Release this move on Desk');
    await released.waitForFunction(() =>
      document.querySelector('[data-move-release]')?.textContent?.includes('Its move slot is free'),
    );
    expect(await released.locator('text=Retry completion and start').count()).toBe(0);
    expect(await released.textContent('[data-move-step="done"]')).toContain('stopped on Laptop');
    expect(await released.getByRole('button', { name: 'Release this move on Desk' }).isDisabled()).toBe(true);
    await settle(released, 'released');

    const repeat = await open('&unconfirmed=1');
    expect(await repeat.locator('[data-move-release]').count()).toBe(0);
    await repeat.click('text=Check what would move');
    await repeat.click('text=Move to Laptop');
    await repeat.waitForSelector('[data-move-recovery]');
    await repeat.click('text=Release this move on Desk');
    await repeat.waitForFunction(() =>
      document.querySelector('[data-move-release]')?.textContent?.includes('Its move slot is free'),
    );
    expect(await repeat.getByRole('button', { name: 'Release this move on Desk' }).isDisabled()).toBe(true);

    for (const failure of ['look', 'export', 'chunk']) {
      const failed = await open(`&fail=${failure}`);
      await failed.click('text=Check what would move');
      if (failure !== 'look') await failed.click('text=Move to Laptop');
      await failed.waitForSelector('[data-move-step="failed"]');
      expect(await failed.locator('[data-move-release]').count()).toBe(failure === 'chunk' ? 1 : 0);
      await settle(failed, `failed-${failure}`);
    }

    for (const action of ['reopen', 'start-over']) {
      const abandoned = await open('&fail=chunk');
      await abandoned.click('text=Check what would move');
      await abandoned.click('text=Move to Laptop');
      await abandoned.waitForSelector('[data-move-step="failed"]');
      if (action === 'reopen') {
        await abandoned.getByRole('button', { name: 'Close', exact: true }).last().click();
        await abandoned.getByRole('button', { name: 'Reopen move' }).click();
      } else await abandoned.getByRole('button', { name: 'Start over' }).click();
      await abandoned.waitForSelector('[data-move-step="pick"]');
      await abandoned.getByRole('button', { name: 'Check for an interrupted move' }).click();
      await abandoned.waitForSelector('[data-move-release]', { timeout: 3000 });
      expect(await abandoned.textContent('[data-move-release]')).toContain('A previous move was interrupted');
      await settle(abandoned, `held-${action}`);
      await abandoned.getByRole('button', { name: 'Release this move on Desk' }).click();
      await abandoned.waitForFunction(() =>
        document.querySelector('[data-move-release]')?.textContent?.includes('Its move slot is free'),
      );
      await abandoned.getByRole('button', { name: 'Close', exact: true }).last().click();
      await abandoned.getByRole('button', { name: 'Reopen move' }).click();
      await abandoned.waitForTimeout(200);
      expect(await abandoned.locator('[data-move-release]').count()).toBe(0);
    }

    const otherHeld = await open('&otherHold=1');
    await otherHeld.getByRole('button', { name: 'Check for an interrupted move' }).click();
    await otherHeld.getByRole('status').filter({ hasText: 'has no interrupted move' }).waitFor();
    expect(await otherHeld.locator('[data-move-release]').count()).toBe(0);

    const interrupted = await open('&interrupt=1&recovery=1');
    await interrupted.click('text=Check what would move');
    await interrupted.click('text=Move to Laptop');
    await interrupted.waitForFunction(() =>
      document.querySelector('[data-move-step="moving"]')?.textContent?.includes('(1 of 3)'),
    );
    await interrupted.keyboard.press('Escape');
    expect(await interrupted.locator('[data-move-machine]').count()).toBe(1);
    expect(await interrupted.textContent('[data-move-machine]')).toContain('Moving…');
    expect(await interrupted.locator('button[aria-label="Close"]').first().isDisabled()).toBe(true);
    await interrupted.locator('button[aria-label="Close"]').first().dispatchEvent('click');
    expect(await interrupted.locator('[data-move-machine]').count()).toBe(1);
    await interrupted.waitForFunction(() => (window as unknown as { finishMove: () => boolean }).finishMove());
    await interrupted.waitForSelector('[data-move-recovery]');
    expect(await interrupted.textContent('[data-move-recovery]')).toContain(
      'Turns and attachments could not be restored.',
    );

    const refused = await open('&refuse=1');
    await refused.click('text=Check what would move');
    await refused.waitForSelector('[data-move-refusals]');
    expect(await refused.textContent('[data-move-refusals]')).toContain(
      'Laptop: this machine has no claude-code login',
    );
    expect(await refused.textContent('[data-move-secrets]')).toContain('ZAI_API_KEY');
    await settle(refused, 'refused');

    const moving = await open('&hold=1');
    await moving.click('text=Check what would move');
    await moving.click('text=Move to Laptop');
    await moving.waitForFunction(() =>
      document.querySelector('[data-move-step="moving"]')?.textContent?.includes('(1 of 3)'),
    );
    expect(await moving.textContent('[data-move-step="moving"]')).toContain('1 of 3');
    await settle(moving, 'moving');
  } finally {
    await context.close();
  }
  expect(problems).toEqual([]);
}

describe('the move dialog', () => {
  for (const width of WIDTHS)
    for (const scheme of SCHEMES)
      for (const style of STYLES)
        it(`${String(width)} ${scheme} ${style}: pick, review, refused, moving and done each fit their box`, async () => {
          await states(width, scheme, style);
        });
});

const countsOf = (tab: Page) =>
  tab.evaluate(
    () =>
      (window as unknown as { recoveryCounts: { held: number; releases: number; ceremonies: number } }).recoveryCounts,
  );

describe('recovery from real Actions', () => {
  it('keeps recovery reachable with the target offline, at every size and rounding', async () => {
    for (const width of WIDTHS)
      for (const scheme of SCHEMES)
        for (const style of STYLES) {
          const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
          try {
            const tab = await context.newPage();
            await tab.goto(`${server?.url.origin}/recover?offline=1&scheme=${scheme}&style=${style}`);
            const entry = tab.getByRole('button', { name: 'Move to another machine…', exact: true });
            await entry.waitFor({ timeout: 3000 });
            expect(await countsOf(tab)).toEqual({ held: 0, releases: 0, ceremonies: 0 });
            await entry.click();
            await tab.waitForSelector('[data-move-step="pick"]');
            expect(await tab.getByRole('button', { name: 'Check what would move' }).count()).toBe(0);
            expect(await tab.locator('[data-move-release]').count()).toBe(0);
            expect((await countsOf(tab)).held).toBe(0);
            const shot = async (state: string) => {
              expect(await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
                0,
              );
              const misses = await roundSafeMisses(tab);
              expect(misses.length, describeRoundMisses(misses)).toBe(0);
              if (shotsDir !== '')
                await tab.screenshot({ path: join(shotsDir, `${width}-${scheme}-${style}-${state}.png`) });
            };
            await shot('offline-check');
            await tab.getByRole('button', { name: 'Check for an interrupted move' }).click();
            await tab.waitForSelector('[data-move-release]');
            await shot('offline-held');
            await tab.getByRole('button', { name: 'Release this move on Desk' }).click();
            await tab.waitForFunction(() =>
              document.querySelector('[data-move-release]')?.textContent?.includes('Its move slot is free'),
            );
            expect((await countsOf(tab)).releases).toBe(1);
            await shot('offline-released');
          } finally {
            await context.close();
          }
        }
  });

  it('asks only on an explicit recovery check in a fresh session; Cancel says why, retry steps up then Releases', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    try {
      const tab = await context.newPage();
      await tab.goto(`${server?.url.origin}/recover?stepup=1`);
      await tab.getByRole('button', { name: 'Move to another machine…', exact: true }).click();
      await tab.waitForSelector('[data-move-step="pick"]');
      expect(await countsOf(tab)).toEqual({ held: 0, releases: 0, ceremonies: 0 });
      const check = tab.getByRole('button', { name: 'Check for an interrupted move' });
      await check.click();
      const prompt = tab.getByRole('dialog', { name: 'Confirm it’s you' });
      await prompt.waitFor({ timeout: 3000 });
      await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
      await tab.getByRole('alert').filter({ hasText: 'Confirm with your passkey on Desk, then try again.' }).waitFor();
      expect(await tab.locator('[data-move-release]').count()).toBe(0);
      expect((await countsOf(tab)).releases).toBe(0);
      await check.click();
      await prompt.getByRole('button', { name: 'Use passkey' }).click();
      await tab.waitForSelector('[data-move-release]');
      expect((await countsOf(tab)).ceremonies).toBe(1);
      await tab.getByRole('button', { name: 'Release this move on Desk' }).click();
      await tab.waitForFunction(() =>
        document.querySelector('[data-move-release]')?.textContent?.includes('Its move slot is free'),
      );
      expect((await countsOf(tab)).releases).toBe(1);
    } finally {
      await context.close();
    }
  });

  it('shows a denied recovery read, and never Releases another ferret’s hold', async () => {
    for (const query of ['deny=1', 'other=1']) {
      const context = await browser.newContext();
      try {
        const tab = await context.newPage();
        await tab.goto(`${server?.url.origin}/recover?${query}`);
        await tab.getByRole('button', { name: 'Move to another machine…', exact: true }).click();
        await tab.getByRole('button', { name: 'Check for an interrupted move' }).click();
        await tab
          .getByText(
            query === 'deny=1'
              ? 'Desk: This device may not move ferrets on Desk.'
              : 'Desk has no interrupted move for Zoe.',
            { exact: true },
          )
          .waitFor();
        expect(await tab.locator('[data-move-release]').count()).toBe(0);
        expect((await countsOf(tab)).releases).toBe(0);
      } finally {
        await context.close();
      }
    }
  });
});
