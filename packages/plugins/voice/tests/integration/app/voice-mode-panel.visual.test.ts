/**
 * VOICE MODE'S PANEL in a real browser (`fixtures/voice-mode-panel-scene.tsx`), over a fake machine. Proof on the DOM and
 * computed geometry, at 390 and 1440 px in light and dark: pressing Voice mode hides the composer (the same box, draft
 * intact), draws the panel with the machine's state and live words, opens ONE chat stream for the ferret, units leave the
 * page, End gives the composer back with its draft, a machine without speech leaves the composer and says so, and a refusal
 * is said in the machine's own sentence. 44 px controls, no sideways scroll, nothing outside the column.
 * Set `FY_VOICE_MODE_PANEL_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_VOICE_MODE_PANEL_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-mode-panel-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/voice-mode-panel-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the voice mode panel scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

interface Fake {
  starts: string[];
  units: number;
  closed: unknown[];
  micStopped: number;
  reads: number;
  sent: string[];
}

describe('Voice mode panel', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['studio-light', 'studio-dark'] as const) {
      const open = async (talk: string) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        await tab.goto(`${origin}/?theme=${theme}&talk=${talk}`);
        await tab.locator('[data-fake-composer]').waitFor({ state: 'visible' });
        return { context, tab };
      };
      type Tab = Awaited<ReturnType<typeof open>>['tab'];
      const fakeOf = async (tab: Tab) =>
        (await tab.evaluate(() => (window as unknown as { __fake: Fake }).__fake)) as Fake;
      const shot = async (tab: Tab, name: string) => {
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-${name}.png`) });
      };
      const overflow = async (tab: Tab) =>
        await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

      it(`pressing Voice mode hides the composer, shows the machine's words, and End brings the same box back (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('hearing');
        try {
          const box = tab.getByLabel('Message');
          expect(await box.inputValue()).toBe('half a thought');
          expect(await overflow(tab)).toBeLessThanOrEqual(0);
          await shot(tab, 'composer');
          await tab.locator('[data-voice-mode-start]').click();
          await tab.locator('[data-voice-mode="on"]').waitFor({ state: 'visible' });
          expect(await tab.locator('[data-fake-composer]').isVisible()).toBe(false);
          expect(await tab.locator('[data-fake-composer]').count()).toBe(1);
          expect(JSON.parse((await fakeOf(tab)).starts[0] as string)).toEqual({
            t: 'start',
            v: 1,
            purpose: 'chat',
            ferretId: 'ferret-1',
          });
          await tab.locator('[data-voice-mode-words]').filter({ hasText: 'please check the build' }).waitFor();
          expect(await tab.locator('[data-voice-mode-status]').innerText()).toContain('Hearing you');
          expect((await fakeOf(tab)).units).toBeGreaterThan(0);
          for (const button of await tab.locator('[data-voice-mode] button').all())
            expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
          expect(await overflow(tab)).toBeLessThanOrEqual(0);
          await shot(tab, 'on-hearing');
          await tab.locator('[data-voice-mode-mute]').click();
          await tab.getByText('Muted. Nothing you say leaves this device.').waitFor({ state: 'visible' });
          await shot(tab, 'on-muted');
          await tab.locator('[data-voice-mode-end]').click();
          await tab.locator('[data-fake-composer]').waitFor({ state: 'visible' });
          expect(await tab.locator('[data-voice-mode]').count()).toBe(0);
          expect(await tab.getByLabel('Message').inputValue()).toBe('half a thought');
          const fake = await fakeOf(tab);
          expect(fake.closed).toEqual([[1000, 'voice stream ended']]);
          expect(fake.micStopped).toBe(1);
          expect(await overflow(tab)).toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      });

      it(`Working shows while the ferret works, and a sent turn says Sent (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('working');
        try {
          await tab.locator('[data-voice-mode-start]').click();
          await tab.locator('[data-voice-mode-outcome]').waitFor({ state: 'visible' });
          expect(await tab.locator('[data-voice-mode-outcome]').innerText()).toBe('Sent.');
          expect(await tab.locator('[data-voice-mode-status]').innerText()).toContain('Working');
          await shot(tab, 'on-working');
        } finally {
          await context.close();
        }
      });

      it(`a machine without speech leaves the composer and says where to install it (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('notinstalled');
        try {
          await tab.locator('[data-voice-mode-start]').click();
          const notice = tab.locator('[data-voice-mode-notice]');
          await notice.waitFor({ state: 'visible' });
          expect(await notice.innerText()).toContain('Settings › Voice › Voice mode');
          expect(await tab.locator('[data-fake-composer]').isVisible()).toBe(true);
          expect((await fakeOf(tab)).starts).toEqual([]);
          expect(await overflow(tab)).toBeLessThanOrEqual(0);
          await shot(tab, 'not-installed');
        } finally {
          await context.close();
        }
      });

      it(`a machine lost mid-chat hands the panel to the phone's engine, says why, and the loop keeps sending (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('lost');
        try {
          await tab.locator('[data-voice-mode-start]').click();
          await tab.locator('[data-voice-mode="on"][data-engine="machine"]').waitFor({ state: 'visible' });
          await tab.locator('[data-voice-mode="on"][data-engine="phone"]').waitFor({ state: 'visible' });
          const banner = tab.locator('[data-voice-mode-banner]');
          expect(await banner.innerText()).toContain('Lost Studio Mac');
          expect(await banner.innerText()).toContain("this phone's own speech");
          expect(await tab.locator('[data-voice-mode-notice]').count()).toBe(0);
          expect(await tab.locator('[data-fake-composer]').isVisible()).toBe(false);
          expect((await fakeOf(tab)).micStopped).toBe(1);
          await tab.locator('[data-voice-mode-words]').filter({ hasText: 'Please check the build' }).waitFor();
          expect(await tab.locator('[data-voice-mode-status]').innerText()).toContain('Hearing you');
          for (const button of await tab.locator('[data-voice-mode] button').all())
            expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
          expect(await overflow(tab)).toBeLessThanOrEqual(0);
          await shot(tab, 'phone-hearing');
          await tab.locator('[data-voice-mode-outcome]').filter({ hasText: 'Sent.' }).waitFor({ timeout: 15_000 });
          expect((await fakeOf(tab)).sent).toEqual(['(voice) Please check the build']);
          await shot(tab, 'phone-sent');
          await tab.locator('[data-voice-mode-end]').click();
          await tab.locator('[data-fake-composer]').waitFor({ state: 'visible' });
          expect(await tab.getByLabel('Message').inputValue()).toBe('half a thought');
        } finally {
          await context.close();
        }
      });

      it(`a machine that cannot be reached starts voice mode on the phone with a banner (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('unreachable');
        try {
          await tab.locator('[data-voice-mode-start]').click();
          await tab.locator('[data-voice-mode="on"][data-engine="phone"]').waitFor({ state: 'visible' });
          expect(await tab.locator('[data-voice-mode-banner]').innerText()).toContain('cannot be reached');
          expect((await fakeOf(tab)).starts).toEqual([]);
          expect(await overflow(tab)).toBeLessThanOrEqual(0);
          await shot(tab, 'phone-unreachable');
        } finally {
          await context.close();
        }
      });

      it(`a refusal is said in the machine's own sentence and the composer returns (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('refused');
        try {
          await tab.locator('[data-voice-mode-start]').click();
          const notice = tab.locator('[data-voice-mode-notice]');
          await notice.waitFor({ state: 'visible' });
          expect(await notice.innerText()).toContain('permission to talk to ferrets');
          expect(await tab.locator('[data-fake-composer]').isVisible()).toBe(true);
          expect(await tab.getByLabel('Message').inputValue()).toBe('half a thought');
          expect(await overflow(tab)).toBeLessThanOrEqual(0);
          await shot(tab, 'refused');
        } finally {
          await context.close();
        }
      });
    }
  }
});
