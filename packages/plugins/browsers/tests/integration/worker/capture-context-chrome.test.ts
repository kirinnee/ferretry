import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { BrowserCapture } from '../../../daemon/worker/capture/index.ts';
import { BrowserWorkerClient } from '../../../daemon/worker/client.ts';
import { REAL_WORKER } from '../../support/process-workers.ts';
import { wallClock } from '../../support/wall-clock.ts';

const VALUE = 'synthetic-related-native-482913';
const ORIGIN = 'http://context.localhost:7490';
let root: string;
let context: BrowserContext;
let client: BrowserWorkerClient;
let site: ReturnType<typeof Bun.serve>;
let target: Page;
let source: Page;
let targetId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'g27-context-'));
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 7490,
    fetch: () =>
      new Response('<!doctype html><title>Context</title><input id="secret" type="password"><p id="echo"></p>', {
        headers: { 'content-type': 'text/html' },
      }),
  });
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    executablePath: Bun.which('google-chrome') ?? Bun.which('chromium') ?? undefined,
    headless: true,
    viewport: null,
    args: [
      '--no-sandbox',
      '--no-proxy-server',
      '--disable-background-networking',
      '--remote-debugging-port=7491',
      '--host-resolver-rules=MAP *.localhost 127.0.0.1, MAP * ~NOTFOUND',
    ],
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname.endsWith('.localhost') && url.port === '7490') await route.continue();
    else await route.abort();
  });
  // The captured tab precedes the source in context order, so discovery must finish before geometry is masked.
  target = await context.newPage();
  await target.goto(`${ORIGIN}/target`);
  source = await context.newPage();
  await source.goto(`${ORIGIN}/source`);
  client = await BrowserWorkerClient.connect({
    start: REAL_WORKER().start,
    clock: wallClock(),
    endpoint: 'http://127.0.0.1:7491',
    stageDirectory: join(root, 'stage'),
    environment: { HOME: process.env.HOME, PATH: process.env.PATH },
    frameIntervalMs: 0,
  });
  targetId = (await client.location()).pages.find(page => page.url.endsWith('/target'))?.id ?? '';
  if (!targetId) throw new Error('target page missing');
}, 60_000);

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await context?.close();
  site?.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function fillRelated() {
  await source.locator('#secret').fill(VALUE);
  await target.evaluate(value => {
    document.title = value;
    const echo = document.querySelector('#echo');
    if (!echo) throw new Error('fixture echo missing');
    echo.textContent = value;
  }, VALUE);
}

for (const mode of ['text', 'snapshot', 'a11y'] as const) {
  it(`first ${mode} capture discovers a newly filled native field in another tab`, async () => {
    await fillRelated();
    const result = await client.read(targetId, { mode });
    expect(JSON.stringify(result)).not.toContain(VALUE);
    expect(result.text).toContain('[redacted]');
  });
}

it('first PDF export discovers a newly filled native field in another tab', async () => {
  await fillRelated();
  await expect(client.pdf(targetId)).rejects.toThrow(/sensitive/u);
});

it('first screenshot discovers another tab before painting an echoed value', async () => {
  await fillRelated();
  await target.evaluate(() => {
    document.querySelector('#echo')?.setAttribute('style', 'color:magenta;font:28px monospace');
  });
  const result = await client.screenshot(targetId);
  // Decode in the test-owned blank tab, not an agent eval through the masking boundary.
  const decoder = await context.newPage();
  const magenta = await decoder.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const drawing = canvas.getContext('2d');
    if (!drawing) throw new Error('fixture image decoder unavailable');
    drawing.drawImage(image, 0, 0);
    const pixels = drawing.getImageData(0, 0, image.width, image.height).data;
    let count = 0;
    for (let at = 0; at < pixels.length; at += 4)
      if ((pixels[at] ?? 0) > 220 && (pixels[at + 1] ?? 255) < 30 && (pixels[at + 2] ?? 0) > 220) count++;
    return count;
  }, result.screenshotBase64);
  expect(magenta).toBe(0);
}, 15_000);

it('clean native frames take one selector scan per page, no snapshots and no renderer freeze', async () => {
  await source.close();
  for (const page of context.pages()) await page.setContent('<!doctype html><p>Clean page</p>');
  const commands: string[] = [];
  const sessions = new Map<Page, Awaited<ReturnType<BrowserContext['newCDPSession']>>>();
  const capture = new BrowserCapture(
    async page => {
      let session = sessions.get(page);
      if (!session) {
        session = await context.newCDPSession(page);
        sessions.set(page, session);
        const send = session.send.bind(session);
        session.send = ((method: string, params: never) => {
          commands.push(method);
          return send(method as never, params);
        }) as typeof session.send;
      }
      return session;
    },
    async () => {
      throw new Error('clean frames need no compositor');
    },
    work => work,
  );
  expect(await capture.frame(target, 'synthetic-native-pixels')).toBe('synthetic-native-pixels');
  expect(commands.filter(method => method === 'DOM.performSearch')).toHaveLength(context.pages().length);
  expect(commands).not.toContain('Page.setWebLifecycleState');
  expect(commands).not.toContain('DOMSnapshot.captureSnapshot');
  await target.evaluate(() => {
    const host = document.createElement('div');
    document.body.append(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<input autocomplete="one-time-code">';
  });
  await expect(capture.frame(target, 'unsafe-old-pixels')).rejects.toThrow(/sensitive/u);
}, 15_000);
