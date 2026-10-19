// SPIKE: drive the bench in headless Chrome and print one JSON line per (model, profile).
//
//   bun spikes/nemotron-browser/build.ts && bun spikes/nemotron-browser/measure.ts [model ...]
//
// Models are served from MODELS_DIR (local copies of the exact pinned files) through `?hf=`, so the
// download step measures this box's disk, not the network; the byte counts are still the real ones.
// Profiles: `desktop` (plain headless Chrome) and `phone` (Pixel 7 emulation + a 4x CPU slow-down).
// DevTools CPU throttling does not reach a dedicated worker, so the phone profile ALSO passes
// `?slowdown=4`, which makes every decode take four times as long inside the worker.
// Memory: peak RSS of the renderer process that hosts the worker, sampled every 250 ms.

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '../../packages/pwa/node_modules/playwright-core/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const modelsDir = process.env.MODELS_DIR ?? '/tmp/claude-1000/nemo/models';
const all = ['fastconformer-480', 'nemotron-en-160', 'nemotron-en-560', 'nemotron35-160', 'nemotron35-560', 'parakeet'];
const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'));
const models = wanted.length ? wanted : all;
const profiles = (process.env.PROFILES ?? 'desktop,phone').split(',');
const modes = (process.env.MODES ?? 'fast,live').split(',');

const types: Record<string, string> = { js: 'text/javascript', wasm: 'application/wasm', html: 'text/html', wav: 'audio/wav' };
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const cors = { 'access-control-allow-origin': '*' };
    // /hf/<owner>/<repo>/resolve/<rev>/<file> → MODELS_DIR/<repo>/<file>
    const hf = url.pathname.match(/^\/hf\/[^/]+\/([^/]+)\/resolve\/[^/]+\/(.+)$/);
    if (hf) {
      const path = join(modelsDir, hf[1] as string, hf[2] as string);
      if (!existsSync(path)) return new Response('missing', { status: 404, headers: cors });
      return new Response(Bun.file(path), { headers: { ...cors, 'content-length': String(statSync(path).size) } });
    }
    const path = join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!existsSync(path)) return new Response('not found', { status: 404 });
    return new Response(Bun.file(path), { headers: { 'content-type': types[path.split('.').pop() ?? ''] ?? 'application/octet-stream' } });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

/** Every process below this one, with its RSS in bytes and command line. */
async function tree(): Promise<{ pid: number; rss: number; args: string }[]> {
  const out = await new Response(Bun.spawn(['ps', '-eo', 'pid=,ppid=,rss=,args='], { stdout: 'pipe' }).stdout).text();
  const rows = out
    .trim()
    .split('\n')
    .map(line => {
      const [pid, ppid, rss, ...args] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss) * 1024, args: args.join(' ') };
    });
  const mine = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (!mine.has(row.pid) && mine.has(row.ppid)) {
        mine.add(row.pid);
        grew = true;
      }
  }
  return rows.filter(r => mine.has(r.pid) && r.pid !== process.pid);
}

for (const model of models) {
  for (const profile of profiles) {
    const phone = profile === 'phone';
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'google-chrome', headless: true });
    const context = await browser.newContext(phone ? { ...devices['Pixel 7'] } : {});
    const page = await context.newPage();
    page.on('pageerror', e => console.error(`[page error] ${e.message}`));
    page.on('console', m => m.type() === 'error' && console.error(`[console] ${m.text()}`));
    let peakRenderer = 0;
    let peakTotal = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const procs = await tree();
        const renderers = procs.filter(p => p.args.includes('--type=renderer'));
        peakRenderer = Math.max(peakRenderer, ...renderers.map(p => p.rss), 0);
        peakTotal = Math.max(peakTotal, procs.reduce((t, p) => t + p.rss, 0));
        await Bun.sleep(250);
      }
    })();
    try {
      if (phone) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      }
      await page.goto(`${origin}/?hf=${encodeURIComponent(`${origin}/hf`)}${phone ? '&slowdown=4' : ''}`);
      await page.waitForFunction(() => 'results' in ((globalThis as { __bench?: object }).__bench ?? {}));
      const load = await page.evaluate(async id => await (globalThis as any).__bench.load(id), model);
      const runs: unknown[] = [];
      for (const mode of modes) runs.push(await page.evaluate(async m => await (globalThis as any).__bench.clips(m), mode));
      sampling = false;
      await sampler;
      console.log(JSON.stringify({ model, profile, load, runs, peakRendererRss: peakRenderer, peakChromeRss: peakTotal }));
    } catch (error) {
      sampling = false;
      await sampler;
      console.log(JSON.stringify({ model, profile, error: String(error), peakRendererRss: peakRenderer }));
    } finally {
      await browser.close();
    }
  }
}
server.stop();
