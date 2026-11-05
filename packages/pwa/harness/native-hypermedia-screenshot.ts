/**
 * Screenshots and checks for "hypermedia that looks native" (&B163): one message holding an interactive `html` page
 * (the theme kit), a Mermaid flowchart and a Chart.js bar chart, drawn in a chat transcript and in an agenda item's
 * tab, at a 390x844 phone and a 1280x800 desktop, in studio-light and studio-dark.
 *
 *   bun harness/native-hypermedia-screenshot.ts [outDir]   # default /tmp/claude-1000/shots/B163-native
 *
 * Writes <outDir>/<chat|agenda>-<phone|desktop>-<light|dark>.png, a `-moved` picture after the slider is driven,
 * and a `-below` picture of the diagram and chart. It needs the generated sandbox shells in `public/`
 * (`bun scripts/build-fy-render-libs.ts`) and FAILS (after writing every picture) when: the page scrolls sideways;
 * the interactive frame has no inline height, is under 100px, or scrolls inside; its root is not transparent; the
 * kit's `--accent` is unset or the same in light and dark; the bars do not redraw when the slider moves.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Frame, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'native-hypermedia-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/B163-native');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

for (const shell of ['fy-render-html.html', 'fy-render-sandbox.html', 'fy-render-mermaid.js', 'fy-render-lottie.js'])
  if (!existsSync(join(packageDir, 'public', shell)))
    fail(`public/${shell} is missing: run \`bun scripts/build-fy-render-libs.ts\` first`);

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/native-hypermedia-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'native-hypermedia-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    // The stylesheet names its fonts relative to src/styles (`../assets/fonts/…`).
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    // The generated sandbox shells and library bundles live in public/, at the paths the app uses.
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome or Chromium');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
} as const;
const DESKTOP = { viewport: { width: 1_280, height: 800 } } as const;
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
const THEMES = { light: 'studio-light', dark: 'studio-dark' } as const;
type Form = 'phone' | 'desktop';
type Scene = 'chat' | 'agenda';
type Mode = keyof typeof THEMES;

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};
const info = (message: string): void => {
  process.stdout.write(`ℹ️  ${message}\n`);
};

/** `--accent` as the frame's root holds it, per mode, so light and dark can be compared at the end. */
const accents = new Map<Mode, Set<string>>([
  ['light', new Set()],
  ['dark', new Set()],
]);

const FRAME = 'iframe[data-fy-render-frame="html"]';
const FIGURE = 'figure[data-fy-render-type="html"]';

const frameOf = async (page: Page): Promise<Frame> => {
  const handle = await page.locator(FRAME).elementHandle();
  if (handle === null) return fail('no interactive frame in the page');
  const frame = await handle.contentFrame();
  return frame ?? fail('the interactive frame has no content frame');
};

/**
 * Brings `selector` to the top or the middle of whichever column scrolls (the transcript or the item body) with a
 * REAL wheel turn. The transcript follows its tail until the reader scrolls, and only a wheel, a touch or a key
 * counts as the reader: a scripted `scrollIntoView` leaves it following, and the next change of height (a page
 * answering a click) would throw it back to the bottom.
 */
const reveal = async (page: Page, selector: string, block: 'start' | 'center' = 'center'): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) {
    const move = await page
      .locator(selector)
      .first()
      .evaluate((node, at) => {
        let column: HTMLElement | null = node.parentElement;
        while (
          column !== null &&
          !(/auto|scroll/u.test(getComputedStyle(column).overflowY) && column.scrollHeight > column.clientHeight)
        )
          column = column.parentElement;
        if (column === null) return null;
        const area = column.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        const wanted =
          at === 'start' || box.height >= area.height - 16 ? area.top + 56 : area.top + (area.height - box.height) / 2;
        return { delta: box.top - wanted, x: area.left + 1, y: area.top + area.height / 2 };
      }, block);
    if (move === null || Math.abs(move.delta) < 4) break;
    await page.mouse.move(move.x, move.y);
    await page.mouse.wheel(0, move.delta);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(150);
};

/** Scrolls to `figure` again and again until `ready` holds: a picture that draws moves the ones around it. */
const settle = async (
  page: Page,
  figure: string,
  ready: string,
  what: string,
  block: 'start' | 'center' = 'center',
): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await reveal(page, figure, block);
    if ((await page.locator(ready).count()) > 0) return;
    await page.waitForTimeout(400);
  }
  fail(`${what} never drew`);
};

const waitForPictures = async (page: Page, label: string): Promise<void> => {
  // Each picture draws only while on or near the screen (the interactive one is parked until then): visit each.
  await settle(
    page,
    'figure[data-fy-render-type="mermaid"]',
    '.fy-render-viewport img[data-fy-render-diagram]',
    `${label}: the diagram`,
  );
  await settle(page, 'figure[data-fy-render-type="chart"]', '.fy-render-chart canvas', `${label}: the chart`);
  await settle(page, FIGURE, `${FRAME}[data-fy-render-ready="true"]`, `${label}: the interactive page`);
  await page.waitForTimeout(700);
  await settle(page, FIGURE, `${FRAME}[data-fy-render-ready="true"]`, `${label}: the interactive page`);
  check((await page.locator(FRAME).count()) === 1, `${label}: ${await page.locator(FRAME).count()} interactive frames`);
};

const checkPage = async (page: Page, label: string): Promise<void> => {
  const wide = await page.evaluate(() => {
    const scrollers = [...document.querySelectorAll<HTMLElement>('*')].filter(node => {
      const style = getComputedStyle(node);
      return /auto|scroll/u.test(style.overflowY) && node.clientHeight > 0;
    });
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      scrollers: scrollers.map(node => node.scrollWidth - node.clientWidth),
    };
  });
  check(wide.page <= 0, `${label}: the page scrolls sideways by ${wide.page}px`);
  check(
    wide.scrollers.every(extra => extra <= 1),
    `${label}: a scrolling column scrolls sideways (${wide.scrollers.join(',')})`,
  );
};

const checkFrame = async (page: Page, label: string, mode: Mode): Promise<void> => {
  const element = await page.locator(FRAME).evaluate(node => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const column = node.closest('.fy-render');
    return {
      inline: (node as HTMLElement).style.height,
      height: rect.height,
      width: rect.width,
      colourScheme: (node as HTMLElement).style.colorScheme,
      background: style.backgroundColor,
      border: style.borderTopWidth,
      columnWidth: column === null ? null : column.getBoundingClientRect().width,
    };
  });
  check(
    /^\d+(\.\d+)?px$/u.test(element.inline),
    `${label}: the frame has no inline height (${element.inline || 'none'})`,
  );
  check(element.height >= 100, `${label}: the frame is ${element.height}px tall, under 100`);
  check(
    element.background === 'rgba(0, 0, 0, 0)' || element.background === 'transparent',
    `${label}: the frame element paints ${element.background}`,
  );
  info(
    `${label}: frame ${Math.round(element.width)}x${Math.round(element.height)} (inline ${element.inline}), scheme ${element.colourScheme}, border ${element.border}, column ${element.columnWidth === null ? '?' : Math.round(element.columnWidth)}`,
  );

  const frame = await frameOf(page);
  const inside = await frame.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const body = getComputedStyle(document.body);
    return {
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      bodyScrollHeight: document.body.scrollHeight,
      overflow: style.overflow,
      background: style.backgroundColor,
      bodyBackground: body.backgroundColor,
      accent: root.style.getPropertyValue('--accent').trim(),
      fg: root.style.getPropertyValue('--fg').trim(),
      scheme: style.colorScheme,
      font: style.fontFamily,
      ink: style.color,
    };
  });
  check(
    inside.scrollHeight <= inside.clientHeight + 1,
    `${label}: the frame scrolls inside (${inside.scrollHeight} > ${inside.clientHeight})`,
  );
  check(
    inside.scrollWidth <= inside.clientWidth + 1,
    `${label}: the frame scrolls sideways inside (${inside.scrollWidth} > ${inside.clientWidth})`,
  );
  check(
    inside.background === 'rgba(0, 0, 0, 0)',
    `${label}: the frame's html is ${inside.background}, not transparent`,
  );
  check(
    inside.bodyBackground === 'rgba(0, 0, 0, 0)',
    `${label}: the frame's body is ${inside.bodyBackground}, not transparent`,
  );
  check(inside.accent !== '', `${label}: --accent is not set on the frame's root`);
  check(inside.fg !== '', `${label}: --fg is not set on the frame's root`);
  check(inside.scheme.includes(mode), `${label}: the frame's color-scheme is "${inside.scheme}", not ${mode}`);
  accents.get(mode)?.add(inside.accent);
  info(
    `${label}: frame --accent ${inside.accent}, --fg ${inside.fg}, ink ${inside.ink}, font ${inside.font.slice(0, 60)}`,
  );
};

const bars = (frame: Frame): Promise<{ heights: number[]; values: string[]; tones: string[] }> =>
  frame.evaluate(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>('.fy-bar')];
    return {
      heights: nodes.map(node => Math.round(node.getBoundingClientRect().height)),
      values: nodes.map(node => node.dataset.value ?? ''),
      tones: nodes.map(node => node.dataset.tone ?? ''),
    };
  });

const shot = async (page: Page, name: string): Promise<void> => {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const scene = async (kind: Scene, form: Form, mode: Mode): Promise<void> => {
  const theme = THEMES[mode];
  const name = `${kind}-${form}-${mode}`;
  const context = await browser.newContext({
    ...(form === 'phone' ? PHONE : DESKTOP),
    ...LOCALE,
    colorScheme: mode,
  });
  const page = await context.newPage();
  page.on('pageerror', error => check(false, `${name}: page error: ${error.message}`));
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&scene=${kind}`);
  if (kind === 'agenda') {
    await page.locator('[data-agenda-view]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('[data-agenda-tab-button="pictures"]').click();
    await page.locator('[data-agenda-tab-panel="pictures"], [data-agenda-tab="pictures"]').first().waitFor();
  }
  await page.evaluate(() => document.fonts.ready);
  const shown = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  check(shown === theme, `${name}: drawn in ${shown}, named ${theme}`);

  await waitForPictures(page, name);
  await checkPage(page, name);
  await reveal(page, FRAME);
  await checkFrame(page, name, mode);

  // The interactive picture, first draw. Brought to the top of the column so the controls and bars fill the view.
  await reveal(page, FIGURE, 'start');
  await shot(page, name);

  // Diagram and chart below it.
  await reveal(page, '.fy-render-chart');
  // Chart.js grows its bars in; the shot waits it out, then proves bars were painted (coloured pixels, not just axes).
  await page.waitForTimeout(1_500);
  const coloured = await page
    .locator('.fy-render-chart canvas')
    .first()
    .evaluate(node => {
      const canvas = node as HTMLCanvasElement;
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (data === undefined) return 0;
      let count = 0;
      for (let at = 0; at < data.length; at += 4) {
        const [red = 0, green = 0, blue = 0, alpha = 0] = [data[at], data[at + 1], data[at + 2], data[at + 3]];
        if (alpha > 200 && Math.max(red, green, blue) - Math.min(red, green, blue) > 60) count += 1;
      }
      return count;
    });
  check(coloured > 500, `${name}: the chart drew no bars (${coloured} coloured pixels)`);
  // The chart fills its column: every chart canvas is as wide as its fy-render stage (within 2px).
  const widths = await page.locator('figure[data-fy-render-type="chart"]').evaluateAll(figures =>
    figures.map(figure => ({
      canvas: figure.querySelector('canvas')?.getBoundingClientRect().width ?? 0,
      stage: figure.querySelector('.fy-render-stage')?.getBoundingClientRect().width ?? 0,
    })),
  );
  check(widths.length > 0, `${name}: no chart figure to measure`);
  for (const { canvas, stage } of widths)
    check(
      stage > 0 && Math.abs(canvas - stage) <= 2,
      `${name}: the chart canvas is ${Math.round(canvas)}px wide in a ${Math.round(stage)}px stage`,
    );
  info(
    `${name}: chart canvas ${widths.map(w => Math.round(w.canvas)).join(',')} / stage ${widths.map(w => Math.round(w.stage)).join(',')}`,
  );
  await shot(page, `${name}-below`);

  // Drive the real controls: the slider, the segmented buttons and the toggle, and prove the bars redraw.
  // Scrolled away to the chart, the page was parked: it comes back as a fresh frame, at its start.
  await settle(page, FIGURE, `${FRAME}[data-fy-render-ready="true"]`, `${name}: the interactive page`, 'start');
  const frame = await frameOf(page);
  const before = await bars(frame);
  const heightBefore = await page.locator(FRAME).evaluate(node => node.getBoundingClientRect().height);
  await frame.locator('#g').fill('50');
  await frame.locator('#b-cost').click();
  await frame.locator('#t-round').check();
  await page.waitForTimeout(500);
  const after = await bars(frame);
  const heightAfter = await page.locator(FRAME).evaluate(node => node.getBoundingClientRect().height);
  check(
    JSON.stringify(before.heights) !== JSON.stringify(after.heights),
    `${name}: the bars did not redraw (${before.heights.join(',')} → ${after.heights.join(',')})`,
  );
  check(
    JSON.stringify(before.tones) !== JSON.stringify(after.tones),
    `${name}: the segmented control did not change the series tone (${before.tones.join(',')} → ${after.tones.join(',')})`,
  );
  check(
    after.values.every(value => /^\d+\.\d$/u.test(value)),
    `${name}: the toggle did not round the values to one decimal (${after.values.join(',')})`,
  );
  check(
    (await frame.locator('#lg').textContent())?.endsWith(`year 1 = ${after.values[0]}`) === true,
    `${name}: the legend reads "${await frame.locator('#lg').textContent()}", not the rounded first value ${after.values[0]}`,
  );
  // Heights follow the rounded values, not the raw ones: the tallest bar carries the largest rounded value.
  const rounded = after.values.map(Number);
  check(
    after.heights.every(
      (height, at) => Math.abs(height / Math.max(...after.heights) - (rounded[at] ?? 0) / Math.max(...rounded)) < 0.03,
    ),
    `${name}: the bar heights (${after.heights.join(',')}) do not follow the rounded values (${after.values.join(',')})`,
  );
  check(
    (await frame.locator('#o').textContent()) === '50%',
    `${name}: the slider's output reads ${await frame.locator('#o').textContent()}, not 50%`,
  );
  check(
    Math.abs(heightAfter - heightBefore) < 40,
    `${name}: the frame jumped from ${heightBefore}px to ${heightAfter}px`,
  );
  info(`${name}: bars ${before.heights.join(',')} → ${after.heights.join(',')}`);
  await checkPage(page, `${name} after`);
  await checkFrame(page, `${name} after`, mode);
  await reveal(page, FIGURE, 'start');
  await shot(page, `${name}-moved`);

  await context.close();
};

try {
  for (const mode of ['light', 'dark'] as const)
    for (const form of ['phone', 'desktop'] as const)
      for (const kind of ['chat', 'agenda'] as const) await scene(kind, form, mode);

  const light = [...(accents.get('light') ?? [])];
  const dark = [...(accents.get('dark') ?? [])];
  check(light.length === 1, `light: --accent differs between shots (${light.join(' | ')})`);
  check(dark.length === 1, `dark: --accent differs between shots (${dark.join(' | ')})`);
  check(light[0] !== dark[0], `--accent is the same in light and dark (${light[0]})`);
  info(`--accent light ${light.join(',')} / dark ${dark.join(',')}`);
} finally {
  await browser.close();
  server.stop(true);
}
process.stdout.write(`${checks} checks, ${violations.length} violations\n`);
if (violations.length > 0) process.exit(1);
