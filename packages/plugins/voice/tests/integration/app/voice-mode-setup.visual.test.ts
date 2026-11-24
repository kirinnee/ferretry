/**
 * VOICE MODE'S SET-UP INSIDE THE FIRST-RUN VOICE STEP, in a real browser over a fake machine (`fixtures/voice-step-scene.tsx`
 * with `?machine=1`, the machine itself in `fixtures/fake-machine.ts`). Proof on the DOM, the fake machine's call log and
 * computed geometry, at 390 and 1440 px, light and dark:
 *   - the step shows the optional set-up under the audio test, says it is optional, and arriving, installing, picking and
 *     testing write NOTHING to this device and leave Next's commit exactly as it was (the set-up is never needed to go on);
 *   - Install on the machine is ONE call, progress follows what the machine reports to Ready; the reply voice installs the
 *     same way (Kokoro, the default) and "Hear it" speaks through the machine;
 *   - the Talk to test shows the machine's live words and STOPS BY ITSELF after 10 seconds, telling the machine;
 *   - no sideways scroll, every control 44 px, nothing outside its row.
 * Set `FY_VOICE_SETUP_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_VOICE_SETUP_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-setup-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/voice-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Voice step scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

interface Machine {
  installs: number;
  replyInstalls: number;
  starts: string[];
  closed: unknown[];
  micStopped: number;
  hearStarts: number;
}
interface Fake {
  writes: unknown[];
  commits: number;
}

describe('Voice mode set-up in the first-run Voice step', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['studio-light', 'studio-dark'] as const) {
      const label = `${viewport.name}, ${theme}`;
      const open = async (query = '') => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        const logs: string[] = [];
        tab.on('pageerror', error => logs.push(String(error)));
        await tab.goto(`${origin}/?theme=${theme}&machine=1${viewport.phone ? '&phone=1' : ''}${query}`);
        await tab.locator('[data-voice-mode-setup]').waitFor({ state: 'visible' });
        return { context, tab, logs };
      };
      type Tab = Awaited<ReturnType<typeof open>>['tab'];
      const machineOf = async (tab: Tab) =>
        (await tab.evaluate(() => (window as unknown as { __machine: Machine }).__machine)) as Machine;
      const deviceOf = async (tab: Tab) =>
        (await tab.evaluate(() => (window as unknown as { __fake: Fake }).__fake)) as Fake;
      const geometry = async (tab: Tab) =>
        await tab.evaluate(() => {
          const section = document.querySelector('[data-voice-mode-setup]') as Element;
          const box = section.getBoundingClientRect();
          return {
            scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            outside: [...section.querySelectorAll('button')].filter(
              el => el.getBoundingClientRect().right > box.right + 1 || el.scrollWidth > el.clientWidth + 1,
            ).length,
            short: [...section.querySelectorAll('button')]
              .map(el => el.getBoundingClientRect().height)
              .filter(height => height < 43.5).length,
          };
        });
      const shot = async (tab: Tab, name: string) => {
        if (shotsDir === '') return;
        await tab.locator('[data-voice-mode-setup]').scrollIntoViewIfNeeded();
        await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-${name}.png`), fullPage: true });
      };

      it(`a fresh machine: optional, installs the engine and the reply voice, writes nothing to the device (${label})`, async () => {
        const { context, tab, logs } = await open();
        try {
          const text = await tab.locator('[data-voice-mode-setup]').innerText();
          expect(text).toContain('Optional');
          expect(text).toContain('Finish later in Settings');
          const device = await deviceOf(tab);
          const commits = device.commits;
          const before = await geometry(tab);
          expect(before).toEqual({ scrollX: 0, outside: 0, short: 0 });
          expect((await machineOf(tab)).installs).toBe(0);
          await shot(tab, 'fresh');

          await tab.getByRole('button', { name: 'Install on Studio Mac (699 MB)' }).click();
          await tab.locator('[data-voice-engine-progress]').waitFor({ state: 'visible' });
          await shot(tab, 'installing');
          await tab.locator('[data-voice-engine-ready]').waitFor({ state: 'visible', timeout: 15_000 });
          expect((await machineOf(tab)).installs).toBe(1);

          await tab.getByRole('button', { name: 'Install on Studio Mac (164 MB)' }).click();
          await tab.locator('[data-voice-reply-ready]').waitFor({ state: 'visible', timeout: 15_000 });
          expect((await machineOf(tab)).replyInstalls).toBe(1);
          await tab.getByRole('button', { name: 'Hear it' }).click();
          await tab.locator('[data-voice-first-sound], [data-voice-by-device]').first().waitFor({ state: 'visible' });
          expect((await machineOf(tab)).hearStarts).toBe(1);
          await shot(tab, 'ready');
          expect(await geometry(tab)).toEqual({ scrollX: 0, outside: 0, short: 0 });

          // None of it was a choice this device had to keep: nothing written, and Next's commit is what it was.
          const after = await deviceOf(tab);
          expect(after.writes).toEqual([]);
          expect(after.commits).toBe(commits);
          expect(logs).toEqual([]);
        } finally {
          await context.close();
        }
      });

      it(`Talk to test shows the machine's words and stops by itself after 10 seconds (${label})`, async () => {
        const { context, tab } = await open('&engine=ready&reply=ready&talk=hearing');
        try {
          expect(await tab.locator('[data-voice-talk-to-test]').innerText()).toContain('up to 10 s');
          await tab.locator('[data-voice-talk-start]').click();
          await tab.locator('[data-voice-heard="interim"]').waitFor({ state: 'visible' });
          expect(await tab.locator('[data-voice-heard]').innerText()).toBe('please check the build');
          await shot(tab, 'talk-hearing');
          const began = Date.now();
          await tab.locator('[data-voice-talk-start]').waitFor({ state: 'visible', timeout: 15_000 });
          const took = Date.now() - began;
          expect(took).toBeGreaterThan(8_000);
          const machine = await machineOf(tab);
          expect(machine.closed).toEqual([[1000, 'voice stream ended']]);
          expect(machine.micStopped).toBe(1);
          expect(await tab.locator('[data-voice-outcome]').innerText()).toBe('Stopped after 10 s.');
          await shot(tab, 'talk-stopped');
          expect((await geometry(tab)).scrollX).toBe(0);
        } finally {
          await context.close();
        }
      });
    }
  }

  it('a machine already set up shows Ready and offers Remove, never an Install (390, light)', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const origin = server?.url.origin ?? '';
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    const tab = await context.newPage();
    try {
      await tab.goto(`${origin}/?theme=studio-light&machine=1&phone=1&engine=ready&reply=ready`);
      await tab.locator('[data-voice-engine-ready]').waitFor({ state: 'visible' });
      expect(await tab.getByRole('button', { name: /^Install on/u }).count()).toBe(0);
      expect(await tab.getByRole('button', { name: 'Remove from Studio Mac' }).count()).toBe(2);
    } finally {
      await context.close();
    }
  });
});
