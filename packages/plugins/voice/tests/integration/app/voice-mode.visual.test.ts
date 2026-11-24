/**
 * VOICE MODE'S SETTINGS GROUP in a real browser (`fixtures/voice-mode-scene.tsx`). Proof on the DOM and computed geometry:
 * a fresh machine offers "Install on <machine> (699 MB)"; pressing it is ONE install call and the bar then follows what the
 * machine reports until it says Ready; a machine that refused a download says why and offers Try again; Remove is the
 * person's press and one call. At 390 and 1440 px, light and dark: no sideways scroll, 44 px controls, nothing outside its row.
 * Set `FY_VOICE_MODE_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_VOICE_MODE_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-mode-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/voice-mode-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the voice mode scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  installs: number;
  removes: number;
  reads: number;
}

describe('Voice mode settings', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['studio-light', 'studio-dark'] as const) {
      const open = async (state: string) => {
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
        await tab.goto(`${origin}/?theme=${theme}&state=${state}`);
        await tab.locator('[data-voice-engine]').waitFor({ state: 'visible' });
        return { context, tab };
      };
      const geometry = async (tab: Awaited<ReturnType<typeof open>>['tab']) =>
        await tab.evaluate(() => {
          const rect = (el: Element) => el.getBoundingClientRect();
          const row = rect(document.querySelector('[data-voice-engine]') as Element);
          return {
            buttons: [...document.querySelectorAll('[data-voice-engine] button')].map(el => ({
              h: rect(el).height,
              right: rect(el).right,
              clipped: (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1,
            })),
            rowRight: row.right,
            scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
      const fakeOf = async (tab: Awaited<ReturnType<typeof open>>['tab']) =>
        (await tab.evaluate(() => (window as unknown as { __fake: Fake }).__fake)) as Fake;

      it(`a fresh machine installs, shows progress, and ends Ready (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('not_installed');
        try {
          const install = tab.getByRole('button', { name: 'Install on Studio Mac (699 MB)' });
          await install.waitFor({ state: 'visible' });
          const before = await geometry(tab);
          expect(before.scrollX).toBeLessThanOrEqual(0);
          for (const button of before.buttons) {
            expect(button.h).toBeGreaterThanOrEqual(43.5);
            expect(button.right).toBeLessThanOrEqual(before.rowRight + 1);
            expect(button.clipped).toBe(false);
          }
          expect((await fakeOf(tab)).installs).toBe(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-not-installed.png`) });

          await install.click();
          const bar = tab.locator('[data-voice-engine-progress]');
          await bar.waitFor({ state: 'visible' });
          expect(await bar.getAttribute('aria-valuenow')).toBe('0');
          await tab.getByText(/Downloading to Studio Mac: \d+ MB of 699 MB/u).waitFor({ state: 'visible' });
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-installing.png`) });
          const mid = await geometry(tab);
          expect(mid.scrollX).toBeLessThanOrEqual(0);

          await tab.locator('[data-voice-engine-ready]').waitFor({ state: 'visible', timeout: 15_000 });
          expect((await fakeOf(tab)).installs).toBe(1);
          expect(await tab.locator('[data-voice-engine-progress]').count()).toBe(0);
          await tab.getByRole('button', { name: 'Remove from Studio Mac' }).waitFor({ state: 'visible' });
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-ready.png`) });
          const after = await geometry(tab);
          expect(after.scrollX).toBeLessThanOrEqual(0);
          for (const button of after.buttons) {
            expect(button.h).toBeGreaterThanOrEqual(43.5);
            expect(button.right).toBeLessThanOrEqual(after.rowRight + 1);
          }
        } finally {
          await context.close();
        }
      });

      it(`Remove is the person's press and one call; a refused download says why (${viewport.name}, ${theme})`, async () => {
        const ready = await open('ready');
        try {
          await ready.tab.getByRole('button', { name: 'Remove from Studio Mac' }).click();
          await ready.tab.getByRole('button', { name: 'Install on Studio Mac (699 MB)' }).waitFor({ state: 'visible' });
          const fake = await fakeOf(ready.tab);
          expect(fake.removes).toBe(1);
          expect(fake.installs).toBe(0);
        } finally {
          await ready.context.close();
        }
        const failed = await open('failed');
        try {
          const alert = failed.tab.locator('[data-voice-engine-failure="hash_mismatch"]');
          await alert.waitFor({ state: 'visible' });
          expect(await alert.innerText()).toContain('nothing was kept');
          await failed.tab.getByRole('button', { name: 'Try again' }).waitFor({ state: 'visible' });
          const box = await geometry(failed.tab);
          expect(box.scrollX).toBeLessThanOrEqual(0);
          if (shotsDir !== '')
            await failed.tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-failed.png`) });
        } finally {
          await failed.context.close();
        }
      });
    }
  }
});
