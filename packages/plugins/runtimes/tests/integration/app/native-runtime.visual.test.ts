import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { nativeRuntimeWorld } from './fixtures/native-runtime-world.ts';

setDefaultTimeout(60_000);
const shots = process.env.FY_NATIVE_RUNTIME_SHOTS_DIR;
let directory = '';
let server: ReturnType<typeof Bun.serve>;
let browser: Awaited<ReturnType<typeof sharedChromium>>;
const worlds = new Map<string, ReturnType<typeof nativeRuntimeWorld>>();
const worldFor = (query: URLSearchParams) => {
  const key = query.get('case') ?? 'manual';
  let pending = worlds.get(key);
  if (pending === undefined) {
    const mode = query.get('mode');
    pending = nativeRuntimeWorld(mode !== 'add' && mode !== 'pin', mode === 'pin');
    worlds.set(key, pending);
  }
  return pending;
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'native-runtime-browser-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/native-runtime-scene.tsx'],
    { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`native runtime scene build failed: ${stderr}\n${stdout}`);
  const built = JSON.parse(stdout.trim().split('\n').at(-1)!) as { css: string; js: string };
  const [css, js] = await Promise.all([readFile(built.css, 'utf8'), readFile(built.js, 'utf8')]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      const world = await worldFor(url.searchParams);
      if (url.pathname === '/state') return Response.json(world.state());
      if (url.pathname !== '/rpc') return new Response('not here', { status: 404 });
      const input = (await request.json()) as {
        route: string;
        init?: { params?: Record<string, string>; body?: unknown };
      };
      try {
        return Response.json({ ok: true, answer: await world.call(input.route, input.init) });
      } catch (error) {
        const detail = error as Error & { code?: string; status?: number; body?: unknown };
        return Response.json({
          ok: false,
          message: detail.message,
          code: detail.code,
          status: detail.status,
          body: detail.body,
        });
      }
    },
  });
  browser = await sharedChromium();
  if (shots !== undefined) await mkdir(shots, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  for (const pending of worlds.values()) await (await pending).close();
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const looks = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
] as const;
for (const look of looks)
  for (const width of [390, 1440])
    for (const scheme of ['light', 'dark'] as const) {
      describe(`native runtime: ${look.style} ${width} ${scheme}`, () => {
        for (const mode of ['new', 'add', 'pin'])
          it(
            mode === 'new'
              ? 'real discovery requires explicit model choice and stays inside the picker'
              : mode === 'add'
                ? 'Add OpenCode reviews and atomically saves a plain profile from only legacy profiles'
                : 'a first runtime on a fresh login is offered the profile whose pin the login offers, and no plain profile',
            async () => {
              const context = await browser.newContext({
                viewport: { width, height: width === 390 ? 844 : 900 },
                colorScheme: scheme,
                reducedMotion: 'reduce',
                ...(width === 390 ? { isMobile: true, hasTouch: true } : {}),
              });
              const origin = server.url.origin;
              const query = new URLSearchParams({
                theme: `${look.palette}-${scheme}`,
                mode,
                case: crypto.randomUUID(),
              });
              try {
                await context.route('**/*', route =>
                  new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
                );
                const page = await context.newPage();
                page.on('pageerror', error => console.error('native runtime scene:', error.message));
                page.setDefaultTimeout(10_000);
                await page.goto(`${origin}/?${query}`);
                await page.evaluate(style => (document.documentElement.dataset.style = style), look.style);
                if (mode === 'pin') {
                  await page.waitForSelector('[data-add-runtime-more] summary');
                  await page.click('[data-add-runtime-more] summary');
                  await page.waitForSelector('[data-add-runtime-profile-select]');
                  expect(await page.locator('[data-native-plain-profile]').count()).toBe(0);
                  expect(await page.locator('[data-add-runtime-no-profiles]').count()).toBe(0);
                  expect(await page.locator('[data-add-runtime-profile-select]').textContent()).toMatch(/deepseek/iu);
                  expect((await (await context.request.get(`${origin}/state?${query}`)).json()).runtimes).toEqual([]);
                } else if (mode === 'add') {
                  await page.waitForSelector('[data-create-plain-profile]');
                  const before = await (await context.request.get(`${origin}/state?${query}`)).json();
                  expect(before.runtimes).toEqual([]);
                  expect(before.profiles).toEqual(['claude-only']);
                  const pinned = await (
                    await context.request.post(`${origin}/rpc?${query}`, {
                      data: {
                        route: 'POST /v1/runtimes/proposals',
                        init: {
                          body: {
                            change: {
                              kind: 'runtime.put',
                              name: 'opencode-pinned',
                              credential: 'deepseek-key',
                              harness: 'opencode',
                              profile: 'claude-only',
                              create: true,
                            },
                          },
                        },
                      },
                    })
                  ).json();
                  expect(pinned.status).toBe(409);
                  if (shots !== undefined)
                    await page.screenshot({
                      path: join(shots, `${look.style}-${width}-${scheme}-add-plain-option.png`),
                      fullPage: true,
                    });
                  await page.check('[data-create-plain-profile]');
                  await page.click('[data-change-submit]');
                  await page.waitForSelector('[data-native-runtime-review]');
                  expect(await page.locator('[data-native-runtime-writes] li').allTextContents()).toEqual([
                    'runtimes/opencode-plain.yaml',
                    'profiles/plain.yaml',
                  ]);
                  expect((await (await context.request.get(`${origin}/state?${query}`)).json()).runtimes).toEqual([]);
                } else {
                  await page.waitForSelector('#fy-new-ferret-model');
                  await page.fill('#fy-new-ferret-prompt', 'Inspect this synthetic project');
                  expect(await page.getByRole('button', { name: 'Create ferret', exact: true }).isDisabled()).toBe(
                    true,
                  );
                  await page.click('#fy-new-ferret-model');
                  await page.waitForSelector('[role="option"]');
                  expect(await page.locator('[role="option"]').allTextContents()).toContain('Choose a model');
                  expect((await page.locator('[role="option"]').allTextContents()).join(' ')).toContain(
                    'DeepSeek V4 Pro',
                  );
                  expect((await page.locator('[role="option"]').allTextContents()).join(' ')).not.toContain(
                    'Vision Exp',
                  );
                }
                await page.evaluate(async () => await document.fonts.ready);
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
                const misses = await roundSafeMisses(page);
                expect(misses, describeRoundMisses(misses)).toEqual([]);
                if (shots !== undefined)
                  await page.screenshot({
                    path: join(shots, `${look.style}-${width}-${scheme}-${mode}.png`),
                    fullPage: mode !== 'new',
                  });
                if (mode === 'pin') {
                  await page.click('[data-change-submit]');
                  await page.waitForSelector('[data-add-runtime-done]');
                  const after = await (await context.request.get(`${origin}/state?${query}`)).json();
                  expect(after.runtimes).toEqual(['opencode-deepseek-pin']);
                  expect(after.profiles).toEqual(['claude-only', 'deepseek-pin']);
                } else if (mode === 'add') {
                  await page.click('[data-change-submit]');
                  await page.waitForSelector('[data-add-runtime-done]');
                  const after = await (await context.request.get(`${origin}/state?${query}`)).json();
                  expect(after.runtimes).toEqual(['opencode-plain']);
                  expect(after.profiles).toContain('plain');
                } else {
                  await page.getByRole('option', { name: /DeepSeek V4 Pro/ }).click();
                  expect(await page.getByRole('button', { name: 'Create ferret', exact: true }).isDisabled()).toBe(
                    false,
                  );
                  expect(await page.locator('[data-fast-switch]').isDisabled()).toBe(true);
                  const create = page.getByRole('button', { name: 'Create ferret', exact: true });
                  await create.scrollIntoViewIfNeeded();
                  const bounds = await create.boundingBox();
                  expect(
                    bounds !== null && bounds.y >= 0 && bounds.y + bounds.height <= (width === 390 ? 844 : 900),
                  ).toBe(true);
                  if (shots !== undefined)
                    await page.screenshot({ path: join(shots, `${look.style}-${width}-${scheme}-new-actions.png`) });
                  await page.click('#fy-new-ferret-runtime');
                  const runtimeOptions = page.getByRole('option');
                  expect(await runtimeOptions.count()).toBe(2);
                  await runtimeOptions.nth(1).click();
                  await page.waitForFunction(
                    () =>
                      document.querySelector<HTMLInputElement>('#fy-new-ferret-model')?.value === '' ||
                      document.querySelector('#fy-new-ferret-model')?.textContent?.includes('Choose a model'),
                  );
                  expect(await create.isDisabled()).toBe(true);
                  await page.click('#fy-new-ferret-model');
                  expect((await page.getByRole('option').allTextContents()).join(' ')).not.toContain('DeepSeek');
                  await page.getByRole('option', { name: /Codestral/ }).click();
                  expect(await create.isDisabled()).toBe(false);
                  await create.scrollIntoViewIfNeeded();
                  if (shots !== undefined)
                    await page.screenshot({
                      path: join(shots, `${look.style}-${width}-${scheme}-new-switched.png`),
                      fullPage: true,
                    });
                }
              } finally {
                await context.close();
              }
            },
          );
      });
    }
