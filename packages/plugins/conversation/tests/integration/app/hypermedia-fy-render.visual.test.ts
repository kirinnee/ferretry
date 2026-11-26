/**
 * AN `fy-render` BLOCK DRAWS INSIDE A DURIAN MESSAGE, in a real browser, on a phone and a desktop, in light and dark.
 *
 * The scene (`fixtures/hypermedia-fy-render-scene.tsx`) is the REAL `Transcript` over one fake assistant message holding a
 * drawn `svg`, a scripted `html` block, a fence opened as `fy-render notes` and a block with no boundary line. Measured:
 *   - the svg is ONE `<img>` that loaded (it has a size), with no object/embed/script/canvas/iframe inside its block (the toolbar's own icons are the only svg there);
 *   - the scripted html is ONE sandboxed frame (`sandbox="allow-scripts"`, never `allow-same-origin`), and nothing the
 *     author wrote is an element of the page: no `<script>` and none of the svg's own shapes inside the document, no `on*` attribute;
 *   - the two not-a-block fences are code, with no error line, nothing drawn for them;
 *   - nothing scrolls sideways at 390 px, and nothing asked a host outside the scene's own for anything.
 *
 * Set `FY_HYPERMEDIA_SHOTS_DIR` to keep `fy-render-<viewport>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { fyRenderIntegrationFixture } from './support/fy-render-integration-fixture.ts';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_HYPERMEDIA_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;

/** Durian's stylesheet, built the way the app's Vite plugin builds it: by the package's own script. */
const durianCss = async (): Promise<string> => {
  const root = dirname(
    createRequire(join(packageRoot, '../../../package.json')).resolve('durian-markdown/package.json'),
  );
  const { buildCss } = (await import(join(root, 'scripts/build-css.ts'))) as { buildCss: () => string };
  return buildCss();
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-hypermedia-fy-render-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/hypermedia-fy-render-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the fy-render hypermedia scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const [{ css, js }, durian, fixture] = await Promise.all([build(), durianCss(), fyRenderIntegrationFixture()]);
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${durian}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/fy-render-html.html')
        return new Response(fixture.html, {
          headers: {
            'content-security-policy': "frame-ancestors 'self'; sandbox allow-scripts",
            'content-type': 'text/html; charset=utf-8',
          },
        });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 1_500 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_280, height: 900 }, deviceScaleFactor: 1 },
] as const;

const open = async (
  name: (typeof VIEWPORTS)[number]['name'],
  scheme: 'light' | 'dark',
): Promise<{ tab: Page; close: () => Promise<void>; foreign: string[] }> => {
  const viewport = VIEWPORTS.find(entry => entry.name === name) ?? VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: name === 'phone',
    isMobile: name === 'phone',
  });
  const origin = server?.url.origin ?? '';
  const foreign: string[] = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (new URL(url).origin === origin || url.startsWith('data:') || url.startsWith('blob:'))
      return await route.continue();
    foreign.push(url);
    return await route.abort();
  });
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${scheme}`);
  await tab.waitForSelector('.dh-doc [data-fy-render-type="svg"] img');
  await tab.waitForSelector('iframe[data-fy-render-frame="html"]');
  return { tab, close: async () => await context.close(), foreign };
};

describe('an fy-render block inside a Durian message', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws the svg as an image, the html in its frame, and the rest as code (${name}, ${scheme})`, async () => {
        const { tab, close, foreign } = await open(name, scheme);
        try {
          await tab.waitForFunction(() => {
            const img = document.querySelector('.dh-doc [data-fy-render-type="svg"] img') as HTMLImageElement | null;
            return img !== null && img.complete && img.naturalWidth > 0;
          });
          const m = await tab.evaluate(() => {
            const doc = document.querySelector('.dh-doc') as HTMLElement;
            const svgBlock = doc.querySelector('[data-fy-render-type="svg"]') as HTMLElement;
            const frame = doc.querySelector('iframe[data-fy-render-frame="html"]') as HTMLIFrameElement;
            const sandbox = frame.getAttribute('sandbox') ?? '';
            return {
              svgImages: svgBlock.querySelectorAll('img').length,
              svgRunnable: svgBlock.querySelectorAll('object, embed, script, canvas, iframe').length,
              frames: doc.querySelectorAll('iframe').length,
              sandbox,
              frameWidth: frame.getBoundingClientRect().width,
              docWidth: doc.getBoundingClientRect().width,
              authorScripts: doc.querySelectorAll('script').length,
              authorSvgs: doc.querySelectorAll('rect[fill="#2b5cff"], circle[fill="#ffd23f"]').length,
              handlers: [...doc.querySelectorAll('*')].filter(el =>
                el.getAttributeNames().some(attribute => attribute.startsWith('on')),
              ).length,
              errors: doc.querySelectorAll('.dh-error, [data-dh-missing]').length,
              drawnBlocks: doc.querySelectorAll('[data-fy-render-type]').length,
              codeFences: [...doc.querySelectorAll('.code-block code')].map(code => code.textContent ?? ''),
              overflow: document.documentElement.scrollWidth - window.innerWidth,
            };
          });
          expect(m.svgImages).toBe(1);
          expect(m.svgRunnable).toBe(0);
          expect(m.frames).toBe(1);
          expect(m.sandbox).toContain('allow-scripts');
          expect(m.sandbox).not.toContain('allow-same-origin');
          expect(m.frameWidth).toBeGreaterThan(100);
          expect(m.frameWidth).toBeLessThanOrEqual(m.docWidth + 1);
          expect(m.authorScripts).toBe(0);
          expect(m.authorSvgs).toBe(0);
          expect(m.handlers).toBe(0);
          expect(m.errors).toBe(0);
          // The svg block and the html block are the only drawn blocks; the two other fences are code.
          expect(m.drawnBlocks).toBe(2);
          expect(m.codeFences.some(text => text.includes('alt: not drawn'))).toBe(true);
          expect(m.codeFences.some(text => text.includes('no boundary line'))).toBe(true);
          expect(m.overflow).toBeLessThanOrEqual(0);
          expect(foreign).toEqual([]);
          if (shotsDir !== '') {
            await tab.waitForTimeout(300);
            await tab.screenshot({ path: join(shotsDir, `fy-render-${name}-${scheme}.png`) });
          }
        } finally {
          await close();
        }
      });
});

describe('a fence still streaming into the SAME message', () => {
  const TICKS = '`'.repeat(3);
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`keeps the mounted html frame, shows the partial fence as inert code, and draws it at its closer (${name}, ${scheme})`, async () => {
        const { tab, close, foreign } = await open(name, scheme);
        try {
          await tab.evaluate(() => {
            (window as unknown as { keptFrame: Element | null }).keptFrame = document.querySelector(
              'iframe[data-fy-render-frame="html"]',
            );
          });
          const state = async () =>
            await tab.evaluate(() => {
              const doc = document.querySelector('.dh-doc') as HTMLElement;
              const kept = (window as unknown as { keptFrame: Element | null }).keptFrame;
              const frames = doc.querySelectorAll('iframe[data-fy-render-frame="html"]');
              return {
                sameFrame: frames.length === 1 && frames[0] === kept,
                keptConnected: kept?.isConnected === true,
                frames: doc.querySelectorAll('iframe').length,
                svgs: doc.querySelectorAll('[data-fy-render-type="svg"] img').length,
                errors: doc.querySelectorAll('.dh-error, [data-dh-missing]').length,
                neverClosed: document.body.textContent?.includes('never closed') === true,
                unreadable: document.body.textContent?.includes('could not be read') === true,
                partialCode: [...doc.querySelectorAll('.code-block code')].some(code =>
                  (code.textContent ?? '').includes('alt: arriving'),
                ),
              };
            });
          const grow = async (extra: string) =>
            await tab.evaluate(extra => {
              const w = window as unknown as { fyStream: (text: string) => void; fyMessage: string };
              w.fyStream(`${w.fyMessage}\n\n${extra}`);
            }, extra);
          const settle = async () => await tab.waitForTimeout(150);

          const steps = [
            `${TICKS}fy-render`,
            `${TICKS}fy-render\ntype: svg\nalt: arriving`,
            `${TICKS}fy-render\ntype: svg\nalt: arriving\n---\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`,
          ];
          const seen: Awaited<ReturnType<typeof state>>[] = [];
          for (const step of steps) {
            await grow(step);
            await settle();
            seen.push(await state());
          }
          for (const s of seen)
            expect(s).toMatchObject({
              sameFrame: true,
              keptConnected: true,
              frames: 1,
              svgs: 1,
              errors: 0,
              neverClosed: false,
              unreadable: false,
            });
          expect(seen.slice(1).every(s => s.partialCode)).toBe(true);

          // Its closer arrives: now it is a block, and the frame beside it is still the one the reader was using.
          await grow(`${steps[2]}\n${TICKS}`);
          await tab.waitForFunction(
            () => document.querySelectorAll('.dh-doc [data-fy-render-type="svg"] img').length === 2,
          );
          const after = await state();
          expect(after).toMatchObject({
            sameFrame: true,
            keptConnected: true,
            frames: 1,
            svgs: 2,
            errors: 0,
            partialCode: false,
          });
          expect(foreign).toEqual([]);
        } finally {
          await close();
        }
      });
});

describe('nothing at or after an unclosed opener draws while the message streams (r12 H3 R2)', () => {
  const TICKS = '`'.repeat(3);
  const HTML = [`${TICKS}fy-render`, 'type: html', 'alt: An agenda', '---', '<p>partial</p><script>1</script>'];
  const SVG = [
    `${TICKS}fy-render`,
    'type: svg',
    'alt: A square',
    '---',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  ];
  const quoted = (lines: readonly string[]): string[] => lines.map(line => `> ${line}`);
  const listed = (lines: readonly string[]): string[] =>
    lines.map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`));
  /** A fence behind a list marker and a TAB (content at column 4): the rest of its lines sit four spaces in. */
  const tabbed = (lead: string, lines: readonly string[]): string[] =>
    lines.map((line, index) => (index === 0 ? `${lead}${line}` : `    ${line}`));
  const COMPLETE_HTML = [...HTML, TICKS];
  const VARIANTS: readonly {
    readonly name: string;
    readonly lines: string[];
    readonly closer: string | null;
    readonly eol?: string;
  }[] = [
    { name: 'four-space opener before it', lines: [`    ${TICKS}`, ...HTML], closer: null },
    { name: 'tab opener before it', lines: [`\t${TICKS}`, ...HTML], closer: null },
    { name: 'blockquote, partial html', lines: quoted(HTML), closer: `> ${TICKS}` },
    { name: 'blockquote, complete svg body, no quoted closer', lines: quoted(SVG), closer: `> ${TICKS}` },
    { name: 'list item, partial html', lines: listed(HTML), closer: `  ${TICKS}` },
    { name: 'list item, complete svg body', lines: listed(SVG), closer: `  ${TICKS}` },
    // r12 H3 R3: a list marker followed by a TAB, every marker, partial html and a complete svg body.
    ...['-\t', '*\t', '+\t', '1.\t', '1)\t', ' -\t'].flatMap(lead => [
      { name: `${JSON.stringify(lead)} then partial html`, lines: tabbed(lead, HTML), closer: `    ${TICKS}` },
      { name: `${JSON.stringify(lead)} then a complete svg body`, lines: tabbed(lead, SVG), closer: `    ${TICKS}` },
    ]),
    // gpt R2: an open top-level block, a four-space line that is no closer, then a COMPLETE quoted block.
    {
      name: 'open block, a four-space line, a complete quoted block',
      lines: [...HTML, `    ${TICKS}`, '', ...quoted(COMPLETE_HTML)],
      closer: null,
    },
    // Opus R2 low: a js fence "closed" by a four-space line (Durian) and a complete block after it.
    {
      name: 'js fence with a four-space closer, then a complete block',
      lines: [`${TICKS}js`, 'x', `    ${TICKS}`, '', ...COMPLETE_HTML],
      closer: null,
    },
    {
      name: 'js fence with a no-break-space closer, then a complete block',
      lines: [`${TICKS}js`, 'x', ` ${TICKS}`, '', ...COMPLETE_HTML],
      closer: null,
    },
    // Every line ending reads the same.
    { name: 'open block, CRLF', lines: HTML, closer: TICKS, eol: '\r\n' },
    { name: 'open block in a quote, lone CR', lines: quoted(HTML), closer: `> ${TICKS}`, eol: '\r' },
  ];

  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`keeps the iframe count at 0 until the closer (${name}, ${scheme})`, async () => {
        const { tab, close, foreign } = await open(name, scheme);
        try {
          const show = async (text: string) => {
            await tab.evaluate(
              text => (window as unknown as { fyStream: (text: string) => void }).fyStream(text),
              text,
            );
            await tab.waitForTimeout(400);
            return await tab.evaluate(() => {
              const doc = document.querySelector('.dh-doc') as HTMLElement;
              return {
                frames: doc.querySelectorAll('iframe').length,
                blocks: doc.querySelectorAll('[data-fy-render-type]').length,
                images: doc.querySelectorAll('[data-fy-render-type] img').length,
                errors: doc.querySelectorAll('.dh-error, [data-dh-missing]').length,
                code: doc.querySelectorAll('.code-block').length,
              };
            });
          };
          const measured: Record<string, unknown> = {};
          for (const variant of VARIANTS) {
            const eol = variant.eol ?? '\n';
            const before = await show(['Here is the plan:', '', ...variant.lines].join(eol));
            measured[variant.name] = before;
            expect({ variant: variant.name, ...before }).toMatchObject({
              variant: variant.name,
              frames: 0,
              blocks: 0,
              images: 0,
              errors: 0,
            });
            expect(before.code).toBeGreaterThan(0);
            if (variant.closer === null) continue;
            // The closer arrives: it is a block now.
            const after = await show(['Here is the plan:', '', ...variant.lines, variant.closer].join(eol));
            expect({ variant: variant.name, blocks: after.blocks, errors: after.errors }).toEqual({
              variant: variant.name,
              blocks: 1,
              errors: 0,
            });
            expect(after.frames + after.images).toBe(1);
          }
          if (process.env.FY_MEASURE !== undefined) console.log(JSON.stringify(measured));
          expect(foreign).toEqual([]);
        } finally {
          await close();
        }
      }, 60_000);
});

describe('a closing delimiter that is the last line of a message still arriving does not run the partial body (r12 H3 R4)', () => {
  const TICKS = '`'.repeat(3);
  const TILDES = '~'.repeat(3);
  const HTML = (open: string): string[] => [
    open,
    'type: html',
    'alt: An agenda',
    '---',
    '<p>partial</p><script>1</script>',
  ];
  const CUTS: readonly { readonly name: string; readonly lines: string[]; readonly closer: string }[] = [
    { name: 'backticks', lines: HTML(`${TICKS}fy-render`), closer: TICKS },
    { name: 'tildes', lines: HTML(`${TILDES}fy-render`), closer: TILDES },
    { name: 'quoted', lines: HTML(`${TICKS}fy-render`).map(line => `> ${line}`), closer: `> ${TICKS}` },
  ];

  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`keeps the iframe count at 0 while the closer is the last line, then draws it (${name}, ${scheme})`, async () => {
        const { tab, close, foreign } = await open(name, scheme);
        try {
          const show = async (text: string, busy: boolean) => {
            await tab.evaluate(
              ([text, busy]) =>
                (window as unknown as { fyStream: (text: string, busy: boolean) => void }).fyStream(
                  text as string,
                  busy as boolean,
                ),
              [text, busy] as const,
            );
            await tab.waitForTimeout(400);
            return await tab.evaluate(() => {
              const doc = document.querySelector('.dh-doc') as HTMLElement;
              return {
                frames: doc.querySelectorAll('iframe').length,
                blocks: doc.querySelectorAll('[data-fy-render-type]').length,
                errors: doc.querySelectorAll('.dh-error, [data-dh-missing]').length,
                code: [...doc.querySelectorAll('.code-block code')].some(code =>
                  (code.textContent ?? '').includes('<script>1</script>'),
                ),
              };
            });
          };
          for (const cut of CUTS) {
            const head = ['Here is the plan:', '', ...cut.lines];
            const at = await show([...head, cut.closer].join('\n'), true);
            // The next token turns the line into content: still nothing runs.
            const next = await show([...head, `${cut.closer}js`].join('\n'), true);
            // The line ends: it was a closer, and the block draws.
            const ended = await show([...head, `${cut.closer}\n`].join('\n'), true);
            // The same text as a FINAL message (not arriving) is drawn as it always was.
            const final = await show([...head, cut.closer].join('\n'), false);
            if (process.env.FY_MEASURE !== undefined)
              console.log(JSON.stringify({ cut: cut.name, at, next, ended, final }));
            expect({ cut: cut.name, ...at }).toMatchObject({
              cut: cut.name,
              frames: 0,
              blocks: 0,
              errors: 0,
              code: true,
            });
            expect({ cut: cut.name, ...next }).toMatchObject({ cut: cut.name, frames: 0, blocks: 0, errors: 0 });
            expect({ cut: cut.name, frames: ended.frames, errors: ended.errors }).toEqual({
              cut: cut.name,
              frames: 1,
              errors: 0,
            });
            expect({ cut: cut.name, frames: final.frames, errors: final.errors }).toEqual({
              cut: cut.name,
              frames: 1,
              errors: 0,
            });
          }
          expect(foreign).toEqual([]);
        } finally {
          await close();
        }
      }, 90_000);
});
