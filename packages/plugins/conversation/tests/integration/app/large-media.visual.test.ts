/**
 * A THREE-MEGABYTE CLIP PLAYS, AND SEEKS, IN A REAL BROWSER (docs/fy-render.md rule 11).
 *
 * Before the streamed media route a `media:` file over one mebibyte was a "larger than the 1 MB" row. Here the REAL
 * `FyRenderBlock` and `readWorkspaceMedia` read a 3 MiB file of the ferret's media folder through a client whose every
 * call crosses a server (`POST /wire`) that answers with the contract's `mediaAnswer` put on the session wire by the
 * kernel's `answerRecords` — the bytes the page plays were base64url records, cut and joined, as a remote device's are.
 * (The route's gates and secrets rule are the Ferrets unit tests'; this proves what the owner sees.) Measured, in
 * Chromium:
 *   - the audio and the video block show a player, not the row, and the file is read in Range requests;
 *   - the player loads the whole 3 MiB, reports its real duration, plays (its clock moves) and SEEKS: setting
 *     `currentTime` lands there (`seeked`), then playback goes on from it;
 *   - a working-tree file of the same size is still the "1 MB" row (only the media folder was lifted);
 *   - nothing scrolls sideways at 390 px.
 *
 * Set `FY_LARGE_MEDIA_SHOTS_DIR` to keep `<case>-<viewport>-<scheme>.png`. The video case needs the ffmpeg Playwright
 * ships (support/large-media-assets.ts); without it that case is skipped and says so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, errorResponse, type ApiResponse } from '@ferretry/kernel/contract';
import { answerRecords } from '@ferretry/kernel/session';
import { bareMediaName, mediaAnswer, MEDIA_CHUNK_BYTES, mediaTypeOf } from '@ferretry/core-ferrets/contract';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { findFfmpeg, noiseWebm, THREE_MIB, toneWav } from './support/large-media-assets.ts';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LARGE_MEDIA_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { margin: 0; }
  .scene-pad { box-sizing: border-box; padding: 16px; max-width: 760px; margin: 0 auto; }
`;

const FILE = 'GET /v1/ferrets/:ferretId/fs/file';
const MEDIA = 'GET /v1/ferrets/:ferretId/fs/media';

/** The files the fake daemon holds in its media folder, by bare name. */
const files = new Map<string, Uint8Array>();
/** What the page asked of the daemon, in order. */
let requests: { readonly route: string; readonly range?: string; readonly name?: string }[] = [];

interface WireRequest {
  readonly route: string;
  readonly query?: Record<string, string>;
  readonly headers?: Record<string, string>;
}

/** The daemon's answer for one call, as the JSON the scene's client reads: what `answerRecords` would put on the wire. */
const answer = (call: WireRequest): { status: number; headers: Record<string, string>; body: string } => {
  const name = call.query?.name ?? call.query?.path ?? '';
  requests.push({
    route: call.route,
    name,
    ...(call.headers?.range === undefined ? {} : { range: call.headers.range }),
  });
  let response: ApiResponse;
  try {
    const bytes = files.get(name);
    if (call.route === FILE) {
      if (bytes === undefined) throw new ApiError(404, `no file ${name}`, 'not_found');
      // The JSON read of the working tree and of the media folder: a file over a mebibyte is only its size and `tooLarge`.
      response =
        bytes.byteLength > 1024 * 1024
          ? {
              body: JSON.stringify({ path: name, size: bytes.byteLength, tooLarge: true }),
              headers: new Map([['content-type', 'application/json']]),
              status: 200,
            }
          : {
              body: JSON.stringify({
                base64: Buffer.from(bytes).toString('base64'),
                path: name,
                size: bytes.byteLength,
              }),
              headers: new Map([['content-type', 'application/json']]),
              status: 200,
            };
    } else {
      const bare = bareMediaName(name);
      const type = bare === undefined ? undefined : mediaTypeOf(bare);
      if (bare === undefined || type === undefined || bytes === undefined)
        throw new ApiError(404, `no file ${name}`, 'not_found');
      response = mediaAnswer(bytes, type, call.headers?.range, bare);
    }
  } catch (error) {
    response =
      error instanceof ApiError ? errorResponse(error.status, error.message, error.code) : errorResponse(500, 'failed');
  }
  const records = answerRecords(1, response).map(
    record =>
      JSON.parse(new TextDecoder().decode(record.plaintext)) as {
        status?: number;
        headers?: Record<string, string>;
        body: string;
      },
  );
  const first = records[0];
  return {
    body: records.map(record => record.body).join(''),
    headers: first?.headers ?? {},
    status: first?.status ?? 500,
  };
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let webm: Uint8Array | undefined;
/** What each case measured, written beside the shots. */
const measured: Record<string, unknown>[] = [];

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-large-media-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/large-media-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the large-media scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  // 3 MiB of PCM plus its header: a song-length recording.
  files.set('song.wav', toneWav((THREE_MIB + 64) / 32_000));
  // A working-tree file reads through the same JSON route and has no streamed one.
  files.set('tree-clip.wav', files.get('song.wav') as Uint8Array);
  const ffmpeg = await findFfmpeg();
  if (ffmpeg !== undefined) {
    webm = await noiseWebm(browser, ffmpeg);
    files.set('clip.webm', webm);
  }
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      if (path === '/wire' && request.method === 'POST')
        return Response.json(answer((await request.json()) as WireRequest));
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 300_000);

afterAll(async () => {
  if (shotsDir !== '') await writeFile(join(shotsDir, 'measurements.json'), `${JSON.stringify(measured, null, 2)}\n`);
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '390', viewport: { width: 390, height: 640 }, deviceScaleFactor: 2, phone: true },
  { name: '1440', viewport: { width: 1_440, height: 700 }, deviceScaleFactor: 1, phone: false },
] as const;

const open = async (
  scene: string,
  viewport: (typeof VIEWPORTS)[number],
  scheme: 'light' | 'dark',
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    viewport: viewport.viewport,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  requests = [];
  await tab.goto(`${origin}/?theme=studio-${scheme}&${scene}`);
  return { tab, close: async () => await context.close() };
};

/** Waits for the player (or the row) the block settles on. */
const settled = async (tab: Page): Promise<'player' | 'row'> => {
  await tab.waitForSelector(
    '[data-fy-render-media="audio"], [data-fy-render-media="video"], [data-fy-render-fallback]',
    {
      timeout: 30_000,
    },
  );
  return (await tab.$('[data-fy-render-fallback]')) === null ? 'player' : 'row';
};

/** Loads the player's whole file, seeks, plays, and reports what the browser did. */
const playAndSeek = async (tab: Page, selector: string) =>
  await tab.evaluate(async (query: string) => {
    const media = document.querySelector(query) as HTMLMediaElement;
    const once = (name: string, ms = 20_000) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${name} within ${ms} ms`)), ms);
        media.addEventListener(name, () => (clearTimeout(timer), resolve()), { once: true });
      });
    if (media.readyState < 1) await once('loadedmetadata');
    const duration = media.duration;
    const target = Math.floor(duration / 2);
    media.muted = true;
    await media.play();
    const startedAt = media.currentTime;
    await new Promise(resolve => setTimeout(resolve, 600));
    const advanced = media.currentTime - startedAt;
    const seeked = once('seeked');
    media.currentTime = target;
    await seeked;
    const landed = media.currentTime;
    await new Promise(resolve => setTimeout(resolve, 600));
    const after = media.currentTime;
    const seekable = media.seekable.length > 0 ? media.seekable.end(media.seekable.length - 1) : 0;
    media.pause();
    return { advanced, after, duration, error: media.error?.code ?? null, landed, seekable, target };
  }, selector);

describe('a media file over the JSON read, in a real browser', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`plays a 3 MiB recording and seeks in it (${viewport.name}, ${scheme})`, async () => {
        const { tab, close } = await open('type=audio&src=media:song.wav', viewport, scheme);
        try {
          expect(files.get('song.wav')?.byteLength).toBeGreaterThanOrEqual(THREE_MIB);
          expect(await settled(tab)).toBe('player');
          const read = await playAndSeek(tab, '[data-fy-render-media="audio"]');
          measured.push({
            case: `audio-${viewport.name}-${scheme}`,
            fileBytes: files.get('song.wav')?.byteLength,
            ranges: requests.filter(call => call.route === MEDIA).map(call => call.range),
            ...read,
          });
          expect(read.error).toBeNull();
          expect(read.duration).toBeGreaterThan(90);
          expect(read.advanced).toBeGreaterThan(0.3);
          expect(Math.abs(read.landed - read.target)).toBeLessThan(1);
          expect(read.after).toBeGreaterThan(read.landed + 0.3);
          expect(read.seekable).toBeGreaterThan(read.duration - 1);
          const media = requests.filter(call => call.route === MEDIA);
          expect(media.length).toBeGreaterThanOrEqual(1);
          const size = files.get('song.wav')?.byteLength ?? 0;
          expect(media[0]?.range).toBe(`bytes=0-${Math.min(MEDIA_CHUNK_BYTES, size) - 1}`);
          expect(requests[0]?.route).toBe(FILE);
          expect(
            await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          ).toBeLessThanOrEqual(0);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `audio-${viewport.name}-${scheme}.png`) });
        } finally {
          await close();
        }
      });

  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`plays a 3 MiB video and seeks in it (${viewport.name}, ${scheme})`, async () => {
        if (webm === undefined) {
          console.warn('large-media: no Playwright ffmpeg on this machine; the video case did not run');
          return;
        }
        const { tab, close } = await open('type=video&src=media:clip.webm', viewport, scheme);
        try {
          expect(webm.byteLength).toBeGreaterThanOrEqual(THREE_MIB);
          expect(await settled(tab)).toBe('player');
          const read = await playAndSeek(tab, '[data-fy-render-media="video"]');
          measured.push({
            case: `video-${viewport.name}-${scheme}`,
            fileBytes: webm.byteLength,
            ranges: requests.filter(call => call.route === MEDIA).map(call => call.range),
            ...read,
          });
          expect(read.error).toBeNull();
          expect(read.duration).toBeGreaterThan(2);
          expect(read.advanced).toBeGreaterThan(0.2);
          expect(Math.abs(read.landed - read.target)).toBeLessThan(1);
          expect(read.after).toBeGreaterThan(read.landed - 0.01);
          const size = await tab.evaluate(() => {
            const video = document.querySelector('video') as HTMLVideoElement;
            return {
              height: video.videoHeight,
              shownWidth: video.getBoundingClientRect().width,
              width: video.videoWidth,
            };
          });
          expect(size.width).toBe(320);
          expect(size.height).toBe(240);
          expect(size.shownWidth).toBeGreaterThan(200);
          expect(requests.filter(call => call.route === MEDIA).length).toBeGreaterThanOrEqual(1);
          expect(
            await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          ).toBeLessThanOrEqual(0);
          if (shotsDir !== '') {
            // Chromium hides a paused video's controls a moment after the pointer leaves; the shot shows them.
            await tab.hover('video');
            await tab.waitForTimeout(400);
            await tab.screenshot({ path: join(shotsDir, `video-${viewport.name}-${scheme}.png`) });
          }
        } finally {
          await close();
        }
      });

  it('still shows the 1 MB row for a working-tree file of the same size', async () => {
    const { tab, close } = await open('type=audio&src=@tree-clip.wav', VIEWPORTS[0], 'light');
    try {
      expect(await settled(tab)).toBe('row');
      const text = await tab.locator('[data-fy-render-fallback]').innerText();
      expect(text).toContain('larger than the 1 MB a workspace file can be shown at');
      expect(requests.filter(call => call.route === MEDIA)).toHaveLength(0);
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, 'row-390-light.png') });
    } finally {
      await close();
    }
  });
});
