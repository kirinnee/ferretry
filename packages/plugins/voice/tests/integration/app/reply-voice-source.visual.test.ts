/**
 * THE REPLY VOICE SOURCE (unit 10) in a real browser, over a fake machine (`fixtures/voice-mode-scene.tsx`, `&source=`,
 * `&key=`, `&voice=`, `&hold=1`). Proof on the DOM, the calls the page made, and computed geometry: Kokoro is the default and
 * draws nothing of ElevenLabs; choosing ElevenLabs is ONE write of `voice.yaml` that names the provider and no key; a move the
 * machine HOLDS says it is not in effect yet; the voice list is read only when the person presses it, and picking one writes
 * its id; a pasted key is saved once and the field never shows it again; Hear it speaks through the same stream. At 390 and
 * 1440 px, light and dark: no sideways scroll, 44 px controls. Set `FY_VOICE_SOURCE_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_VOICE_SOURCE_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-source-'));
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

interface Eleven {
  source: string;
  keySet: boolean;
  voiceId: string | undefined;
  loads: number;
  writes: string[];
  secrets: number;
  tests: number;
}
interface Fake {
  hearStarts: string[];
  hearFrames: string[];
  played: number;
}
const GEORGE = 'JBFqnCBsd6RMkjVDRZzb';

describe('the reply voice source', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['studio-light', 'studio-dark'] as const) {
      const open = async (query: string) => {
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
        await tab.goto(`${origin}/?theme=${theme}&state=ready&reply=ready${query}`);
        await tab.locator('[data-voice-reply-source]').waitFor({ state: 'visible' });
        return { context, tab };
      };
      type Tab = Awaited<ReturnType<typeof open>>['tab'];
      const eleven = async (tab: Tab) =>
        (await tab.evaluate(() => (window as unknown as { __eleven: Eleven }).__eleven)) as Eleven;
      const shot = async (tab: Tab, name: string) => {
        // Let the segmented control's colour transition finish, so the picture shows the settled state.
        if (shotsDir !== '') await tab.waitForTimeout(400);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-${name}.png`) });
      };
      const fits = async (tab: Tab) => {
        const geometry = await tab.evaluate(() => {
          const row = document.querySelector('[data-voice-reply-source]') as Element;
          const rowRect = row.getBoundingClientRect();
          return {
            scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            buttons: [...row.querySelectorAll('button')].map(el => ({
              h: el.getBoundingClientRect().height,
              right: el.getBoundingClientRect().right,
              clipped: el.scrollWidth > el.clientWidth + 1,
            })),
            rowRight: rowRect.right,
          };
        });
        expect(geometry.scrollX).toBeLessThanOrEqual(0);
        for (const button of geometry.buttons) {
          expect(button.h).toBeGreaterThanOrEqual(43.5);
          expect(button.right).toBeLessThanOrEqual(geometry.rowRight + 1);
          expect(button.clipped).toBe(false);
        }
      };

      it(`Kokoro is the default and draws nothing of ElevenLabs; nothing is read or written until a press (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('&source=kokoro');
        try {
          const row = tab.locator('[data-voice-reply-source="kokoro"]');
          await row.waitFor({ state: 'visible' });
          expect(await tab.getByRole('radio', { name: 'On this machine' }).isChecked()).toBe(true);
          expect(await tab.locator('[data-voice-eleven-picker]').count()).toBe(0);
          expect(await tab.locator('[data-speedup-key-row]').count()).toBe(0);
          const seen = await eleven(tab);
          expect(seen).toMatchObject({ writes: [], loads: 0, secrets: 0, tests: 0 });
          await fits(tab);
          await shot(tab, 'source-kokoro');
        } finally {
          await context.close();
        }
      });

      it(`choosing ElevenLabs is one write that names the provider and no key, then the key row and voice picker appear (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('&source=kokoro&key=unset');
        try {
          await tab.getByRole('radio', { name: 'ElevenLabs' }).check({ force: true });
          await tab.locator('[data-voice-reply-source="elevenlabs"]').waitFor({ state: 'visible' });
          await tab.locator('[data-speedup-key-row="elevenlabs"]').waitFor({ state: 'visible' });
          const seen = await eleven(tab);
          expect(seen.writes).toHaveLength(1);
          expect(seen.writes[0]).toContain('provider: elevenlabs');
          expect(seen.writes[0]).not.toMatch(/key|secret|xi_/iu);
          // Nothing was spent: the voice list is the person's press, not the page's load.
          expect(seen.loads).toBe(0);
          await tab.getByText('No voice chosen yet.').waitFor({ state: 'visible' });
          await fits(tab);
          await shot(tab, 'source-elevenlabs-no-key');
        } finally {
          await context.close();
        }
      });

      it(`a move the machine holds says it is not in effect yet (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('&source=kokoro&hold=1');
        try {
          await tab.getByRole('radio', { name: 'ElevenLabs' }).check({ force: true });
          const note = tab.locator('[data-voice-reply-pending]');
          await note.waitFor({ state: 'visible' });
          expect(await note.innerText()).toContain('not in effect until you confirm it');
          expect(await note.innerText()).toContain('billed per character');
          // Held means the machine still speaks in Kokoro: the Kokoro row keeps its own Hear it.
          expect(await tab.locator('[data-voice-hear-elsewhere]').count()).toBe(0);
          await fits(tab);
          await shot(tab, 'source-held');
        } finally {
          await context.close();
        }
      });

      it(`a pasted key is saved once, the field clears, and the row says Set (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('&source=elevenlabs&key=unset');
        try {
          const field = tab.locator('[data-speedup-key-row="elevenlabs"] input');
          await field.waitFor({ state: 'visible' });
          await field.fill('xi_test_0123456789abcdef');
          await tab.getByRole('button', { name: 'Save', exact: true }).click();
          await tab.locator('[data-speedup-set]').waitFor({ state: 'visible' });
          expect((await eleven(tab)).secrets).toBe(1);
          expect(await tab.locator('[data-speedup-key-row="elevenlabs"] input').count()).toBe(0);
          expect(await tab.content()).not.toContain('xi_test_0123456789abcdef');
          await fits(tab);
          await shot(tab, 'key-saved');
        } finally {
          await context.close();
        }
      });

      it(`the voices are read only when pressed; picking one writes its id and name; the day's use is shown (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('&source=elevenlabs&key=set&voice=none');
        try {
          await tab.locator('[data-voice-eleven-usage]').waitFor({ state: 'visible' });
          expect(await tab.locator('[data-voice-eleven-usage]').innerText()).toContain('1,240 of 20,000 characters');
          expect((await eleven(tab)).loads).toBe(0);
          await tab.locator('[data-voice-eleven-load]').click();
          const picker = tab.getByRole('combobox', { name: 'ElevenLabs voice' });
          await picker.waitFor({ state: 'visible' });
          expect((await eleven(tab)).loads).toBe(1);
          await shot(tab, 'voices-loaded');
          await picker.click();
          await tab.locator('[role="option"]', { hasText: 'Sarah' }).click();
          await tab.getByText('Voice: Sarah.').waitFor({ state: 'visible' });
          const seen = await eleven(tab);
          expect(seen.writes).toHaveLength(1);
          expect(seen.writes[0]).toContain('voiceId: EXAVITQu4vr4xnSDxMaL');
          expect(seen.writes[0]).toContain('voiceName: Sarah');
          await fits(tab);
          await shot(tab, 'voice-picked');
        } finally {
          await context.close();
        }
      });

      it(`Hear it speaks through the same stream once a key and a voice are set (${viewport.name}, ${theme})`, async () => {
        const { context, tab } = await open('&source=elevenlabs&key=set&voice=george&hear=ok');
        try {
          await tab.getByText('Voice: George.').waitFor({ state: 'visible' });
          expect((await eleven(tab)).voiceId).toBe(GEORGE);
          const hear = tab.locator('[data-voice-reply-source] [data-voice-hear-it]');
          await hear.waitFor({ state: 'visible' });
          await hear.click();
          await tab.locator('[data-voice-first-sound]').waitFor({ state: 'visible', timeout: 10_000 });
          const fake = (await tab.evaluate(() => (window as unknown as { __fake: Fake }).__fake)) as Fake;
          expect(fake.hearStarts).toHaveLength(1);
          expect(JSON.parse(fake.hearStarts[0] as string)).toMatchObject({ reply: 'machine' });
          expect(fake.hearFrames).toHaveLength(1);
          expect(await tab.locator('[data-voice-reply-source]').innerText()).toContain(
            'Spoken by ElevenLabs, through Studio Mac.',
          );
          // The Kokoro row does not offer a second Hear it while ElevenLabs reads: that press would be billed there.
          expect(await tab.locator('[data-voice-reply="ready"] [data-voice-hear-it]').count()).toBe(0);
          expect(await tab.locator('[data-voice-hear-elsewhere]').count()).toBe(1);
          await fits(tab);
          await shot(tab, 'hear-it');
        } finally {
          await context.close();
        }
      });
    }
  }
});
