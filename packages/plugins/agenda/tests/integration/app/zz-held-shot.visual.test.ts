import { it } from 'bun:test';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
const packageRoot = import.meta.dir;
const outPng = process.env.FY_SHOT_OUT ?? '';
it('draws the held-replies notice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'held-replies-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', dir, '--entry', 'fixtures/held-replies-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(err + out);
  const m = JSON.parse(out.trim().split('\n').at(-1)!) as { css: string; js: string };
  const css = await readFile(m.css, 'utf8'),
    js = await readFile(m.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{height:100%;margin:0}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: r => {
      const p = new URL(r.url).pathname;
      if (p === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (p === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('no', { status: 404 });
    },
  });
  const browser = await sharedChromium();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 300 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const origin = server.url.origin;
  await ctx.route('**/*', r => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
  const tab = await ctx.newPage();
  const problems: string[] = [];
  tab.on('pageerror', e => problems.push(e.message));
  await tab.goto(`${origin}/?theme=studio-light`);
  try {
    await tab.waitForSelector('[data-agenda-replies]', { timeout: 6000 });
    await tab.waitForSelector('[data-agenda-line] [data-agenda-line-toggle], [data-agenda-line-toggle]', {
      timeout: 6000,
    });
  } catch (e) {
    throw new Error(String(e) + problems.join('\n'));
  }
  await mkdir(join(outPng, '..'), { recursive: true });
  await tab.screenshot({ path: outPng });
  console.log('text:', await tab.locator('body').innerText());
  await ctx.close();
  server.stop(true);
}, 180_000);
