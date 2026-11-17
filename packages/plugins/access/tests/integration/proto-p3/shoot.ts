/**
 * THROWAWAY PROTOTYPE (P3 phase 1): builds the scene and screenshots both options.
 *   bun shoot.ts <outDir>
 * Not a test: one script, one Chromium, fake data.
 */
import type { Browser, Page } from 'playwright-core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const here = import.meta.dir;
const out = resolve(process.argv[2] ?? join(here, 'shots'));
const builder = resolve(here, '../../../../../app/tests/support/browser/build-scene.ts');
// Resolved at run time from the app package's own dependency (this folder has none of its own).
const { chromium } = (await import(resolve(here, '../../../../../app/node_modules/playwright-core/index.js'))) as {
  chromium: { launch: (options: { executablePath?: string; headless: boolean }) => Promise<Browser> };
};

const dir = await mkdtemp(join(tmpdir(), 'p3-scene-'));
const child = Bun.spawn([process.execPath, builder, '--out', dir, '--entry', join(here, 'scene.tsx')], {
  cwd: here,
  stderr: 'pipe',
  stdout: 'pipe',
});
const [stdout, stderr, code] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
if (code !== 0) throw new Error(`scene build failed:\n${stderr}\n${stdout}`);
const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
const css = await readFile(manifest.css, 'utf8');
const js = await readFile(manifest.js, 'utf8');
const sceneCss = await Bun.file(manifest.css.replace('app.css', 'app.css')).text();
void sceneCss;

const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: request => {
    const path = new URL(request.url).pathname;
    if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
    if (path.startsWith('/shots/')) return new Response(Bun.file(join(out, path.slice('/shots/'.length))));
    if (path === '/sheet.html') return new Response(sheetHtml, { headers: { 'content-type': 'text/html' } });
    return new Response(page, { headers: { 'content-type': 'text/html' } });
  },
});
let sheetHtml = '';

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1280', width: 1280, height: 800, phone: false },
] as const;
const THEMES = ['light', 'dark'] as const;
const OPTIONS = ['a', 'b'] as const;
const FRAMES = [
  { name: 'f1', at: 250 },
  { name: 'f2', at: 700 },
  { name: 'f3', at: 1500 },
] as const;

const browser = await chromium.launch({
  executablePath: Bun.which('google-chrome') ?? Bun.which('chromium') ?? undefined,
  headless: true,
});
await mkdir(out, { recursive: true });
const origin = server.url.origin;

const open = async (vp: (typeof VIEWPORTS)[number], theme: string, query: string, reduced = false) => {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.phone ? 2 : 1,
    hasTouch: vp.phone,
    isMobile: vp.phone,
    colorScheme: theme as 'light' | 'dark',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${theme}&${query}`);
  await tab.waitForSelector('[data-pairing-stage]', { timeout: 8000 });
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, context, problems };
};

const seek = async (tab: Page, at: number) =>
  await tab.evaluate(time => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = time;
    }
  }, at);

const report: string[] = [];
for (const option of OPTIONS) {
  await mkdir(join(out, option), { recursive: true });
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const base = join(out, option, `${vp.name}-${theme}`);
      // The pair screen, at rest.
      let s = await open(vp, theme, `option=${option}&stage=confirm`);
      await s.tab.waitForTimeout(300);
      await s.tab.screenshot({ path: `${base}-1-pair.png` });
      if (s.problems.length > 0) report.push(`${option} ${vp.name} ${theme} pair: ${s.problems.join(' | ')}`);
      await s.context.close();
      // Details open.
      if (theme === 'light') {
        s = await open(vp, theme, `option=${option}&stage=confirm&details=1`);
        await s.tab.waitForTimeout(300);
        await s.tab.screenshot({ path: `${base}-1b-details.png` });
        await s.context.close();
      }
      // The success moment: three frames, then settled.
      for (const frame of FRAMES) {
        s = await open(vp, theme, `option=${option}&stage=paired`);
        await seek(s.tab, frame.at);
        await s.tab.screenshot({ path: `${base}-2-success-${frame.name}.png` });
        await s.context.close();
      }
      s = await open(vp, theme, `option=${option}&stage=paired`);
      await seek(s.tab, 3000);
      await s.tab.screenshot({ path: `${base}-3-success.png` });
      await s.context.close();
      // Reduced motion: nothing may animate, and the final picture is already there.
      s = await open(vp, theme, `option=${option}&stage=paired`, true);
      const live = await s.tab.evaluate(
        () =>
          document
            .getAnimations()
            .filter(a => a.playState === 'running')
            .map(a => (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty)
            .join(',') || 'none',
      );
      await s.tab.screenshot({ path: `${base}-4-success-reduced.png` });
      report.push(`reduced-motion ${option} ${vp.name} ${theme}: running = ${live}`);
      await s.context.close();
    }
  }
  // The live flow works end to end.
  const s = await open(VIEWPORTS[0], 'light', `option=${option}`);
  await s.tab.click('.p3-primary');
  await s.tab.waitForSelector('[data-pairing-stage="pairing"]');
  await s.tab.waitForSelector('[data-pairing-stage="paired"]', { timeout: 4000 });
  report.push(`live flow ${option}: pair -> pairing -> paired ok`);
  await s.context.close();
}

// Contact sheets: one per option, light and dark, phone and desktop side by side.
const cell = (path: string, width: number) =>
  `<figure><img src="/shots/${path}" width="${width}"><figcaption>${path}</figcaption></figure>`;
for (const option of OPTIONS) {
  for (const theme of THEMES) {
    sheetHtml = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#888;font:12px system-ui;color:#fff}h2{margin:0 0 12px}.row{display:flex;gap:16px;align-items:flex-start;margin-bottom:24px}figure{margin:0}figcaption{margin-top:4px}</style>
<h2>Option ${option.toUpperCase()} · ${theme} · phone 390 (pair, details, success 0.25s / 0.7s / 1.5s / settled, reduced motion)</h2>
<div class="row">${[
      '1-pair',
      '1b-details',
      '2-success-f1',
      '2-success-f2',
      '2-success-f3',
      '3-success',
      '4-success-reduced',
    ]
      .filter(n => theme === 'light' || n !== '1b-details')
      .map(n => cell(`${option}/390-${theme}-${n}.png`, 260))
      .join('')}</div>
<h2>desktop 1280</h2>
<div class="row">${['1-pair', '3-success'].map(n => cell(`${option}/1280-${theme}-${n}.png`, 620)).join('')}</div>
<div class="row">${['2-success-f1', '2-success-f2', '2-success-f3'].map(n => cell(`${option}/1280-${theme}-${n}.png`, 400)).join('')}</div>`;
    const context = await browser.newContext({ viewport: { width: 1900, height: 1500 } });
    const tab = await context.newPage();
    await tab.goto(`${origin}/sheet.html`);
    await tab.waitForLoadState('load');
    await tab.waitForTimeout(500);
    await tab.screenshot({ path: join(out, `sheet-${option}-${theme}.png`), fullPage: true });
    await context.close();
  }
}

await browser.close();
server.stop(true);
await rm(dir, { force: true, recursive: true });
await writeFile(join(out, 'REPORT.txt'), `${report.join('\n')}\n`);
console.log(report.join('\n'));
