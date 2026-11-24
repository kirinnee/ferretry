/**
 * VOICE MODE'S SETTINGS GROUP in a real browser (`fixtures/voice-mode-scene.tsx`). Proof on the DOM and computed geometry:
 * a fresh machine offers "Install on <machine> (699 MB)"; pressing it is ONE install call and the bar then follows what the
 * machine reports until it says Ready; a machine that refused a download says why and offers Try again; Remove is the
 * person's press and one call. At 390 and 1440 px, light and dark: no sideways scroll, 44 px controls, nothing outside its row.
 * Talk to test (unit 4) is proved against a fake machine: the person presses it, the start record and audio units leave
 * the page, the machine's live words appear, a pause ends the turn with nothing sent, Stop tells the machine, and a
 * refusal is said in the machine's own sentence.
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
  replyInstalls: number;
  replyRemoves: number;
  hearStarts: string[];
  hearFrames: string[];
  played: number;
  playerClosed: number;
  deviceSpoke: string[];
  reads: number;
  starts: string[];
  units: number;
  closed: unknown[];
  micStopped: number;
}

describe('Voice mode settings', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['studio-light', 'studio-dark'] as const) {
      const open = async (state: string, extra = '') => {
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
        await tab.goto(`${origin}/?theme=${theme}&state=${state}${extra}`);
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

      it(`Talk to test shows the machine's live words, ends at the pause, sends nothing, and Stop tells the machine (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('ready', '&talk=heard');
        try {
          const start = tab.getByRole('button', { name: 'Talk to test', exact: true });
          await start.waitFor({ state: 'visible' });
          const before = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(before).toBeLessThanOrEqual(0);
          expect(
            await tab.locator('[data-voice-talk-start]').evaluate(el => el.getBoundingClientRect().height),
          ).toBeGreaterThanOrEqual(43.5);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-talk-idle.png`) });
          await start.click();
          const heard = tab.locator('[data-voice-heard]');
          await tab.locator('[data-voice-heard="interim"]').waitFor({ state: 'visible' });
          expect(await heard.innerText()).toBe('please check the build');
          expect(JSON.parse((await fakeOf(tab)).starts[0] as string)).toEqual({ t: 'start', v: 1, purpose: 'test' });
          expect((await fakeOf(tab)).units).toBeGreaterThan(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-talk-hearing.png`) });
          await tab.locator('[data-voice-heard="final"]').waitFor({ state: 'visible' });
          expect(await heard.innerText()).toBe('Please check the build and tell me what failed.');
          await tab.locator('[data-voice-outcome]').waitFor({ state: 'visible' });
          expect(await tab.locator('[data-voice-outcome]').innerText()).toContain('Nothing was sent');
          const during = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(during).toBeLessThanOrEqual(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-talk-heard.png`) });
          await tab.locator('[data-voice-talk-stop]').click();
          await tab.locator('[data-voice-talk-start]').waitFor({ state: 'visible' });
          const fake = await fakeOf(tab);
          expect(fake.closed).toEqual([[1000, 'voice stream ended']]);
          expect(fake.micStopped).toBe(1);
        } finally {
          await context.close();
        }
      });

      it(`Talk to test says the machine's own sentence when the machine cannot load speech (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('ready', '&talk=refused');
        try {
          await tab.getByRole('button', { name: 'Talk to test', exact: true }).click();
          const problem = tab.locator('[data-voice-problem]');
          await problem.waitFor({ state: 'visible' });
          expect(await problem.innerText()).toContain('enough free memory');
          await tab.locator('[data-voice-talk-start]').waitFor({ state: 'visible' });
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-talk-refused.png`) });
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

      const replyBox = async (tab: Awaited<ReturnType<typeof open>>['tab']) =>
        await tab.evaluate(() => {
          const rect = (el: Element) => el.getBoundingClientRect();
          const row = rect(document.querySelector('[data-voice-reply]') as Element);
          return {
            buttons: [...document.querySelectorAll('[data-voice-reply] button')].map(el => ({
              h: rect(el).height,
              right: rect(el).right,
              clipped: (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1,
            })),
            rowRight: row.right,
            scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });

      it(`the reply voice installs apart from speech, shows progress, and ends Ready (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('ready', '&reply=not_installed');
        try {
          const install = tab.getByRole('button', { name: 'Install on Studio Mac (164 MB)' });
          await install.waitFor({ state: 'visible' });
          expect(await tab.locator('[data-voice-hear-it]').count()).toBe(0);
          const before = await replyBox(tab);
          expect(before.scrollX).toBeLessThanOrEqual(0);
          for (const button of before.buttons) {
            expect(button.h).toBeGreaterThanOrEqual(43.5);
            expect(button.right).toBeLessThanOrEqual(before.rowRight + 1);
            expect(button.clipped).toBe(false);
          }
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-reply-not-installed.png`) });
          await install.click();
          await tab.locator('[data-voice-reply-progress]').waitFor({ state: 'visible' });
          await tab.getByText(/Downloading to Studio Mac: \d+ MB of 164 MB/u).waitFor({ state: 'visible' });
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-reply-installing.png`) });
          await tab.locator('[data-voice-reply-ready]').waitFor({ state: 'visible', timeout: 15_000 });
          const fake = await fakeOf(tab);
          expect(fake.replyInstalls).toBe(1);
          // Speech was already installed: this was the reply voice only.
          expect(fake.installs).toBe(0);
          expect(await tab.locator('[data-voice-reply-ready]').innerText()).toContain('3.2× the time it lasts');
          await tab.locator('[data-voice-hear-it]').waitFor({ state: 'visible' });
          const after = await replyBox(tab);
          expect(after.scrollX).toBeLessThanOrEqual(0);
          for (const button of after.buttons) expect(button.h).toBeGreaterThanOrEqual(43.5);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-reply-ready.png`) });
        } finally {
          await context.close();
        }
      });

      it(`Hear it speaks one sentence through the machine and says how long the first sound took (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('ready', '&reply=ready&hear=ok');
        try {
          await tab.locator('[data-voice-hear-it]').click();
          const first = tab.locator('[data-voice-first-sound]');
          await first.waitFor({ state: 'visible' });
          expect(await first.innerText()).toMatch(/The first sound came \d+\.\d s after the line was sent\./u);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-reply-speaking.png`) });
          await tab.getByText(/Spoken by Studio Mac\./u).waitFor({ state: 'visible', timeout: 10_000 });
          const fake = await fakeOf(tab);
          // The machine is asked for its voice, in the stream's own start record, and the sentence leaves in one fixed-size frame.
          expect(JSON.parse(fake.hearStarts[0] as string)).toEqual({
            t: 'start',
            v: 1,
            purpose: 'test',
            reply: 'machine',
          });
          expect(fake.hearFrames).toHaveLength(1);
          expect(JSON.parse(fake.hearFrames[0] as string)).toEqual({
            t: 'speak',
            id: 0,
            text: 'Let me check the failing test.',
          });
          expect(fake.played).toBe(4_000);
          expect(fake.playerClosed).toBeGreaterThanOrEqual(1);
          // The machine spoke it, so the device's own voice said nothing.
          expect(fake.deviceSpoke).toEqual([]);
          // Nothing of the room left the page: the stream's microphone is the silent one the scene gives it.
          expect(
            await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
          ).toBeLessThanOrEqual(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-reply-spoken.png`) });
        } finally {
          await context.close();
        }
      });

      it(`Hear it falls back to this device's voice, and says so, when the machine has no reply voice or a line failed (${viewport.name}, ${theme})`, async () => {
        const absent = await open('ready', '&reply=ready&hear=absent');
        try {
          await absent.tab.locator('[data-voice-hear-it]').click();
          const said = absent.tab.locator('[data-voice-by-device]');
          await said.waitFor({ state: 'visible' });
          expect(await said.innerText()).toContain("this device's own voice read it");
          const fake = await fakeOf(absent.tab);
          expect(fake.deviceSpoke).toEqual(['Let me check the failing test.']);
          expect(fake.played).toBe(0);
          if (shotsDir !== '')
            await absent.tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-reply-device.png`) });
        } finally {
          await absent.context.close();
        }
        const failed = await open('ready', '&reply=ready&hear=failed');
        try {
          await failed.tab.locator('[data-voice-hear-it]').click();
          await failed.tab.locator('[data-voice-by-device]').waitFor({ state: 'visible' });
          expect((await fakeOf(failed.tab)).deviceSpoke).toEqual(['Let me check the failing test.']);
          await failed.tab.locator('[data-voice-hear-it]').waitFor({ state: 'visible' });
        } finally {
          await failed.context.close();
        }
      });

      it(`a reply voice that failed to download says why and offers Try again; Remove is one call (${viewport.name}, ${theme})`, async () => {
        const failed = await open('ready', '&reply=failed');
        try {
          const alert = failed.tab.locator('[data-voice-reply-failure="download_failed"]');
          await alert.waitFor({ state: 'visible' });
          expect(await alert.innerText()).toContain('internet');
          await failed.tab
            .locator('[data-voice-reply]')
            .getByRole('button', { name: 'Try again' })
            .waitFor({ state: 'visible' });
          expect((await replyBox(failed.tab)).scrollX).toBeLessThanOrEqual(0);
          if (shotsDir !== '')
            await failed.tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-reply-failed.png`) });
        } finally {
          await failed.context.close();
        }
        const ready = await open('ready', '&reply=ready');
        try {
          await ready.tab.locator('[data-voice-reply]').getByRole('button', { name: 'Remove from Studio Mac' }).click();
          await ready.tab
            .locator('[data-voice-reply]')
            .getByRole('button', { name: 'Install on Studio Mac (164 MB)' })
            .waitFor({ state: 'visible' });
          const fake = await fakeOf(ready.tab);
          expect(fake.replyRemoves).toBe(1);
          expect(fake.removes).toBe(0);
        } finally {
          await ready.context.close();
        }
      });

      it(`without speech installed the reply voice says what it needs before it can be heard (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('not_installed', '&reply=ready');
        try {
          await tab.getByText(/Install speech on Studio Mac above to hear it/u).waitFor({ state: 'visible' });
          expect(await tab.locator('[data-voice-hear-it]').count()).toBe(0);
        } finally {
          await context.close();
        }
      });

      // Which engine runs, in plain words, on both rows (speech and the reply voice): native, no build, would not start, upgradable.
      for (const scenario of [
        {
          runtime: 'native',
          kind: 'native',
          says: /The fast native engine is (turning your speech into words|running it) on Studio Mac, on up to 4 threads\./u,
        },
        {
          runtime: 'nobuild',
          kind: 'wasm',
          says: /There is no native engine for freebsd-x64, so Studio Mac .* on the slower built-in engine\./u,
        },
        {
          runtime: 'failed',
          kind: 'wasm',
          says: /The fast native engine could not start on Studio Mac \(libstdc\+\+\.so\.6: cannot open shared object file\), so it runs on the slower built-in engine\./u,
        },
        {
          runtime: 'upgrade',
          kind: 'wasm',
          says: /runs it on the slower built-in engine\. The fast native engine can be installed in its place\./u,
        },
      ] as const) {
        it(`both rows say which engine runs: ${scenario.runtime} (${viewport.name}, ${theme})`, async () => {
          const { context, tab } = await open('ready', `&reply=ready&runtime=${scenario.runtime}`);
          try {
            const lines = tab.locator('[data-voice-runtime]');
            await lines.first().waitFor({ state: 'visible' });
            expect(await lines.count()).toBe(2);
            for (const index of [0, 1]) {
              const line = lines.nth(index);
              expect(await line.getAttribute('data-voice-runtime')).toBe(scenario.kind);
              expect(((await line.textContent()) ?? '').trim()).toMatch(scenario.says);
            }
            // Only the slower engine on a machine that could run the fast one offers the switch, on each row, with its size.
            const upgrades = tab.locator('[data-voice-upgrade]');
            expect(await upgrades.count()).toBe(scenario.runtime === 'upgrade' ? 2 : 0);
            const geometry = await tab.evaluate(() => ({
              scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              buttons: [...document.querySelectorAll('[data-voice-engine] button, [data-voice-reply] button')].map(
                el => ({
                  h: el.getBoundingClientRect().height,
                  clipped: (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1,
                }),
              ),
              lines: [...document.querySelectorAll('[data-voice-runtime]')].map(el => ({
                right: el.getBoundingClientRect().right,
                rowRight: (el.closest('[data-voice-engine], [data-voice-reply]') as Element).getBoundingClientRect()
                  .right,
              })),
            }));
            expect(geometry.scrollX).toBeLessThanOrEqual(0);
            for (const button of geometry.buttons) {
              expect(button.h).toBeGreaterThanOrEqual(43.5);
              expect(button.clipped).toBe(false);
            }
            for (const line of geometry.lines) expect(line.right).toBeLessThanOrEqual(line.rowRight + 1);
            if (shotsDir !== '')
              await tab.screenshot({
                path: join(shotsDir, `${viewport.name}-${theme}-runtime-${scenario.runtime}.png`),
                fullPage: true,
              });
          } finally {
            await context.close();
          }
        });
      }

      it(`Switch to the fast engine is the person's press: one install call per row, and the row then says native (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('ready', '&reply=ready&runtime=upgrade');
        try {
          const speech = tab
            .locator('[data-voice-engine]')
            .getByRole('button', { name: 'Switch to the fast engine (34 MB)' });
          const voice = tab
            .locator('[data-voice-reply]')
            .getByRole('button', { name: 'Switch to the fast engine (359 MB)' });
          await speech.waitFor({ state: 'visible' });
          await voice.waitFor({ state: 'visible' });
          expect((await fakeOf(tab)).installs).toBe(0);
          await speech.click();
          await tab.locator('[data-voice-engine] [data-voice-runtime="native"]').waitFor({ state: 'visible' });
          await voice.click();
          await tab.locator('[data-voice-reply] [data-voice-runtime="native"]').waitFor({ state: 'visible' });
          const fake = await fakeOf(tab);
          expect([fake.installs, fake.replyInstalls]).toEqual([1, 1]);
          expect(await tab.locator('[data-voice-upgrade]').count()).toBe(0);
        } finally {
          await context.close();
        }
      });
    }
  }
});
