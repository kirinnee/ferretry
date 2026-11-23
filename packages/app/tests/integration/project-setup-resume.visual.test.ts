/**
 * PROJECT SETUP SURVIVES A RELAUNCH, in a real browser over the REAL app (C59 O8-13, review fix on PR 2366).
 *
 * The flow is driven for real: the setup flow's last machine step ("Name this machine") -> Next -> the Projects plugin's own
 * "Add your projects" page. Nothing here draws the page itself: the title, the footer and Skip for now are the flow's, the body is
 * the Projects plugin's. A RELAUNCH is a second page of the same browser opened at `/` (what the manifest's start_url opens): it
 * shares the device's storage (the paired list, the onboarding ledger, the later list) but not the first page's tab memory.
 *
 *   (b) leave mid-way, relaunch from /  -> back on "Add your projects" (red on the old head: the relaunch opened the machine)
 *   (a) Skip for now, relaunch          -> not asked again: the machine's home
 *   a device that was never shown project setup is not taken to it; neither is a deep link
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { BrowserContext, Page } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(180_000);

const scene = new URL('./fixtures/project-setup-scene.tsx', import.meta.url).pathname;
const MACHINE = `fy_daemon_${'c'.repeat(43)}`;
const FLOW = `/d/${MACHINE}/onboarding/setup?phase=daemon&journey=add-daemon`;

let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';

beforeAll(async () => {
  server = Bun.spawn([process.execPath, sceneServer, '--entry', scene], { stderr: 'inherit', stdout: 'pipe' });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 90_000)),
  ]);
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
}, 120_000);

afterAll(() => {
  server?.kill();
});

const newDevice = async (): Promise<BrowserContext> => {
  const browser = await sharedChromium();
  const context = await browser.newContext({ viewport: { width: 1_280, height: 800 } });
  // No network: only the scene's own origin answers.
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

/** What the flow shows: the key of its page (`end` for the last screen), or '' when it is not on screen. */
const keyOf = async (tab: Page): Promise<string> =>
  await tab.evaluate(() =>
    document.querySelector('[data-flow-end]') !== null
      ? 'end'
      : (document.querySelector('[data-flow-page]')?.getAttribute('data-flow-page') ?? ''),
  );

const reach = async (tab: Page, key: string): Promise<void> => {
  try {
    await tab.waitForFunction(
      wanted =>
        wanted === 'end'
          ? document.querySelector('[data-flow-end]') !== null
          : document.querySelector('[data-flow-page]')?.getAttribute('data-flow-page') === wanted &&
            document.querySelector('[data-flow-page]')?.hasAttribute('data-ready') === true,
      key,
      { timeout: 30_000 },
    );
  } catch {
    throw new Error(`expected the flow on ${key} but it is on "${await keyOf(tab)}" at ${new URL(tab.url()).pathname}`);
  }
};

/** The real flow, from the last machine step into project setup: the name is saved, Next lands on "Add your projects". */
const intoProjectSetup = async (tab: Page): Promise<void> => {
  await tab.goto(`${origin}${FLOW}`);
  await reach(tab, 'onboarding.name');
  await tab.getByLabel('Machine name').last().fill('harbor-lamp');
  await tab.locator('[data-step-next]').click();
  await reach(tab, 'projects.folders');
};

const pathOf = (tab: Page): string => new URL(tab.url()).pathname;

describe('project setup, driven from the last machine step', () => {
  it('lands on "Add your projects" with the flow\'s own footer and Skip for now', async () => {
    const context = await newDevice();
    const tab = await context.newPage();
    await intoProjectSetup(tab);
    expect(await tab.locator('[data-flow-page="projects.folders"]').count()).toBe(1);
    expect(await tab.locator('[data-projects-step="folders"]').count(), 'the Projects plugin draws the body').toBe(1);
    expect((await tab.locator('[data-flow-later]').innerText()).trim()).toBe('Skip for now');
    expect(await tab.locator('[data-step-next]').count()).toBe(1);
    await context.close();
  });

  it('(b) leaving mid-way: a relaunch from / is back on the step', async () => {
    const context = await newDevice();
    const tab = await context.newPage();
    await intoProjectSetup(tab);
    // The person leaves without an answer: the tab is closed; the device keeps its storage.
    await tab.close();

    const relaunch = await context.newPage();
    await relaunch.goto(`${origin}/`);
    await reach(relaunch, 'projects.folders');
    expect(pathOf(relaunch), "the relaunch is on the machine's setup flow").toBe(`/d/${MACHINE}/onboarding/setup`);
    expect(await relaunch.locator('[data-projects-step="folders"]').count()).toBe(1);
    await context.close();
  });

  it('(a) Skip for now: a relaunch is not asked again', async () => {
    const context = await newDevice();
    const tab = await context.newPage();
    await intoProjectSetup(tab);
    await tab.locator('[data-flow-later]').click();
    await reach(tab, 'end');
    expect(
      await tab.evaluate(() => (window as unknown as { __fake: { later: () => string | null } }).__fake.later()),
      "the skip is on the device's later list",
    ).toContain('projects.folders');
    await tab.close();

    const relaunch = await context.newPage();
    await relaunch.goto(`${origin}/`);
    await relaunch.waitForFunction(() => location.pathname.startsWith('/d/'), undefined, { timeout: 30_000 });
    // Give a wrong redirect the time it would need, then read where the relaunch is.
    await relaunch.waitForTimeout(1_500);
    expect(pathOf(relaunch), 'the relaunch opens the machine, not the setup flow').toBe(`/d/${MACHINE}`);
    expect(await relaunch.locator('[data-flow-page], [data-flow-end]').count()).toBe(0);
    await context.close();
  });

  it('a device that was never shown project setup opens its machine, and a deep link is never taken over', async () => {
    const context = await newDevice();
    const fresh = await context.newPage();
    await fresh.goto(`${origin}/`);
    await fresh.waitForFunction(() => location.pathname.startsWith('/d/'), undefined, { timeout: 30_000 });
    await fresh.waitForTimeout(1_500);
    expect(pathOf(fresh)).toBe(`/d/${MACHINE}`);
    await fresh.close();

    // Now it was shown project setup and left: a deep link to a machine page is still where the person asked to go.
    const tab = await context.newPage();
    await intoProjectSetup(tab);
    await tab.close();
    const deep = await context.newPage();
    await deep.goto(`${origin}/d/${MACHINE}/settings`);
    await deep.waitForTimeout(2_000);
    expect(pathOf(deep)).toBe(`/d/${MACHINE}/settings`);
    await context.close();
  });
});
