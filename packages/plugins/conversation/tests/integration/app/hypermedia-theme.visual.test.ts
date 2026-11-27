/**
 * HYPERMEDIA ACROSS EVERY THEME (r12 H5, G2 U9), in a real browser: every style x every palette x light and dark (all the pack folders),
 * each at 390 and 1280, on the REAL `Transcript` of `fixtures/hypermedia-prose-scene.tsx`. The owner's theme audit
 * (c59 `theme-audit/report.md`, 1,699 rows on the base) is the acceptance input, so this test asks exactly what it asked:
 *
 *  1. FONTS: prose, headings and code use the style's own `--font-prose` / `--font-display` / `--font-mono` (the first family
 *     of the computed stack), not the package's Poppins / IBM Plex Mono;
 *  2. CONTRAST: every text of the message (prose, links, table, terminal, code, every highlighted token, the LLM disclosure)
 *     is >= 4.5:1 (headings >= 3:1) against the composited solid colour behind it, and >= 7:1 on the High contrast palette
 *     (muted chrome 4.5:1); the token pairs Durian's parts draw (status inks on their soft grounds, family inks, `--on-acc`
 *     on `--acc`, line numbers on the code ground) pass the same floor;
 *  3. THE PALETTE IS THE APP'S: a link is the app's `--accent`, the code and terminal ground is `--code-bg`, a table header
 *     is `--md-th-bg`, and each of those and the terminal chrome changes when only the palette changes (the base drew one
 *     fixed set under all eight);
 *  4. NO SELF-REFERENCE: the colours both sides name (`--surface`, `--surface-2`, `--surface-3`, `--muted`, `--faint`, `--bg`,
 *     `--warn`) are, inside `.dh-doc`, the app's own values (a `--surface: var(--surface)` cycle would be invalid);
 *  5. NO LITERAL COLOUR: the terminal's window dots are the app's status colours.
 * Plus: the 15 other styles draw a terminal and a callout differently from Studio, the shape variants are distinct, and a
 * switch of style, palette or mode re-themes what is on screen within one frame.
 *
 *  6. NO UNDEFINED var() (G2 U9): every `var(--x)` without a fallback that a rule under `.dh-doc` / `.fy-hm` reads and no such rule
 *     sets is a non-empty computed value on the document, so a pack that leaves a name the renderer reads without a value fails;
 *  7. SERIES MARKS (G2 U9): the tier list and an alignment grid (`?marks=1` of the scene; a ```chart fence is held as code in
 *     chat) draw each of the eight series colours, and each mark is >= 3:1 on the ground it sits on.
 * THE GRID IS THE PACK FOLDERS: the styles and palettes come from the registry, and the count is asserted equal to the folders on
 * disk, so a new pack folder joins this matrix with no edit here. A second build over a PRIVATE pack tree (every shipped folder
 * copied to a temporary directory, scratch palettes beside them, the scene built with `build-scene.ts --theme-root`; the checkout
 * is never written) proves the matrix has teeth: a scratch palette that is a valid folder passes, and one that breaks the render
 * contract (text on its own ground, a name no pack defines, a series colour that vanishes) fails, in every style.
 *
 * Set `FY_HYPERMEDIA_THEME_REPORT=<file>` to write the issue counts (the same four categories as the audit) as JSON.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { Browser, Page } from 'playwright-core';
import { PALETTES, RENDER_OPTIONAL_STYLE_TOKENS, STYLES } from '@ferretry/app';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import {
  THEME_IDS_JS,
  THEME_PACKS_CSS,
  THEME_PACKS_DIR,
  THEME_PACKS_TS,
  themePackFiles,
} from '../../../../../../scripts/gen/lib/theme-packs.ts';

setDefaultTimeout(600_000);

const packageRoot = import.meta.dir;
const repoRoot = resolve(packageRoot, '../../../../../..');
const reportFile = process.env.FY_HYPERMEDIA_THEME_REPORT ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
  /* The audit reads the SETTLED look: a colour mid-transition from the previous combination is not what a theme draws. */
  *, *::before, *::after { transition: none !important; }
`;

const durianCss = async (): Promise<string> => {
  const root = dirname(
    createRequire(join(packageRoot, '../../../package.json')).resolve('durian-hypermedia/package.json'),
  );
  const { buildCss } = (await import(join(root, 'scripts/build-css.ts'))) as { buildCss: () => string };
  // Then the app's theme for it (`dh-styles.ts` imports the two in this order).
  return `${buildCss()}\n${await readFile(join(packageRoot, '../../../app/hypermedia/dh-theme.css'), 'utf8')}`;
};

let browser: Browser;

/** One built scene being served: the shipped tree's, or a private pack tree's (`--theme-root`). */
interface Site {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

/** Builds the scene (in a child process, as the other scenes are) and serves it. `themeRoot` is a private pack tree: the checkout is read, never written. */
const buildSite = async (themeRoot?: string): Promise<Site> => {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-hypermedia-theme-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      'fixtures/hypermedia-prose-scene.tsx',
      ...(themeRoot === undefined ? [] : ['--theme-root', themeRoot]),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the hypermedia scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const [css, js, durian] = await Promise.all([
    readFile(manifest.css, 'utf8'),
    readFile(manifest.js, 'utf8'),
    durianCss(),
  ]);
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${durian}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  return {
    origin: server.url.origin,
    stop: async () => {
      server.stop(true);
      await rm(directory, { force: true, recursive: true });
    },
  };
};

let shipped: Site | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  shipped = await buildSite();
}, 300_000);

afterAll(async () => {
  await shipped?.stop();
});

const VIEWPORTS = [
  { name: '390', width: 390, height: 1_500, phone: true },
  { name: '1280', width: 1_280, height: 900, phone: false },
] as const;

const open = async (
  viewport: (typeof VIEWPORTS)[number],
  site: Site | undefined = shipped,
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = site?.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-light&marks=1`);
  await tab.waitForSelector('.dh-doc .term');
  await tab.waitForFunction(
    () => document.querySelector('.dh-doc .term-body')?.textContent?.includes('ok 12 tests') === true,
  );
  return { tab, close: async () => await context.close() };
};

/** Two frames: a mutation observer fires, React commits, the browser paints. */
const settle = async (tab: Page): Promise<void> => {
  await tab.evaluate(
    () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
};

const setLook = async (tab: Page, style: string, palette: string, mode: 'light' | 'dark'): Promise<void> => {
  await tab.evaluate(
    ([s, p, m]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', s as string);
      root.setAttribute('data-palette', p as string);
      root.setAttribute('data-mode', m as string);
      root.setAttribute('data-theme', `${p}-${m}`);
    },
    [style, palette, mode],
  );
  await settle(tab);
};

type Category = 'contrast' | 'font' | 'bypass' | 'literal' | 'undefined' | 'marks';
interface Row {
  readonly category: Category;
  readonly what: string;
  readonly detail: string;
  readonly value?: number;
}
interface Colours {
  readonly link: string;
  readonly codeGround: string;
  readonly terminalGround: string;
  readonly terminalChrome: string;
  readonly tableHeader: string;
}
interface Measured {
  readonly rows: readonly Row[];
  readonly colours: Colours;
  readonly overflow: number;
}

/** In the page: everything the audit read for one combination. Written as one function so it can be handed to the page. */
const measureInPage = ({
  highContrast,
  optional,
}: {
  highContrast: boolean;
  optional: readonly string[];
}): Measured => {
  const doc = document.querySelector('.dh-doc') as HTMLElement;
  const wrapper = doc.closest('.fy-hm') as HTMLElement;
  const rootStyle = getComputedStyle(document.documentElement);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const rgba = (colour: string): [number, number, number, number] => {
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000';
    g.fillStyle = colour;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0] as number, d[1] as number, d[2] as number, (d[3] as number) / 255];
  };
  const lum = (c: readonly number[]): number => {
    const f = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0] as number) + 0.7152 * f(c[1] as number) + 0.0722 * f(c[2] as number);
  };
  const ratio = (a: readonly number[], b: readonly number[]): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  /** The solid colour behind an element: every ancestor's background composited over white, outermost first. */
  const behind = (el: Element): [number, number, number] => {
    const chain: Element[] = [];
    for (let n: Element | null = el; n !== null; n = n.parentElement) chain.unshift(n);
    let out: [number, number, number] = [255, 255, 255];
    for (const n of chain) {
      const [r, gr, b, a] = rgba(getComputedStyle(n).backgroundColor);
      if (a > 0) out = [r * a + out[0] * (1 - a), gr * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    }
    return out;
  };
  const opacityOf = (el: Element): number => {
    let o = 1;
    for (let n: Element | null = el; n !== null; n = n.parentElement)
      o *= Number.parseFloat(getComputedStyle(n).opacity);
    return o;
  };
  const inkOver = (el: Element, back: readonly number[]): [number, number, number] => {
    const [r, gr, b, a] = rgba(getComputedStyle(el).color);
    const alpha = a * opacityOf(el);
    const [br = 0, bg = 0, bb = 0] = back;
    return [r * alpha + br * (1 - alpha), gr * alpha + bg * (1 - alpha), b * alpha + bb * (1 - alpha)];
  };
  const own = (el: Element): string =>
    [...el.childNodes]
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent ?? '')
      .join('');
  const find = (selector: string, text?: string): Element | null =>
    [...document.querySelectorAll(`.dh-doc ${selector}`)].find(el => text === undefined || own(el).includes(text)) ??
    null;
  const primary = (stack: string): string =>
    (stack.split(',')[0] ?? '')
      .trim()
      .replace(/^["']|["']$/gu, '')
      .toLowerCase();
  const tokenFont = (token: string): string => primary(rootStyle.getPropertyValue(token));
  const resolve = (expression: string, property: 'color' | 'backgroundColor'): string => {
    const probe = document.createElement('i');
    probe.style.setProperty(property === 'color' ? 'color' : 'background-color', expression);
    wrapper.appendChild(probe);
    const value = getComputedStyle(probe)[property];
    probe.remove();
    return rgba(value)
      .map(v => Math.round(v * 1000) / 1000)
      .join(',');
  };
  const colourOf = (el: Element | null, property: 'color' | 'backgroundColor'): string =>
    el === null
      ? 'missing'
      : rgba(getComputedStyle(el)[property])
          .map(v => Math.round(v * 1000) / 1000)
          .join(',');

  const rows: Row[] = [];
  const text = (
    what: string,
    selector: string,
    needle: string | undefined,
    floor: number,
    font: 'prose' | 'display' | 'mono' | null,
    muted = false,
  ): void => {
    const el = find(selector, needle);
    if (el === null) {
      rows.push({ category: 'contrast', what, detail: 'not found' });
      return;
    }
    const need = highContrast && !muted && floor >= 4.5 ? 7 : floor;
    // The language tag floats over the code block, so what is behind it is the block's own ground.
    const ground = behind(
      el.matches('.code-lang') ? ((el.parentElement?.querySelector('pre') as Element | null) ?? el) : el,
    );
    const got = ratio(inkOver(el, ground), ground);
    if (got < need) rows.push({ category: 'contrast', what, detail: `${got.toFixed(2)} vs ${need}`, value: got });
    if (font !== null) {
      const want = tokenFont(font === 'prose' ? '--font-prose' : font === 'display' ? '--font-display' : '--font-mono');
      const have = primary(getComputedStyle(el).fontFamily);
      if (have !== want) rows.push({ category: 'font', what: `${what} (${font})`, detail: `${have} vs ${want}` });
    }
  };

  text('Heading', 'h2', 'Release check', 3, 'display');
  text('Body prose', '*', 'nothing was deployed.', 4.5, 'prose');
  text('Reference link', 'a[data-fy-reference]', ':zelda', 4.5, 'prose');
  text('List item', 'li', 'Run the tests with', 4.5, 'prose');
  text('Docs link', 'a', 'the docs', 4.5, 'prose');
  text('Table heading', 'th', 'Step', 4.5, 'prose');
  text('Table cell', 'td', 'lint', 4.5, 'prose');
  text('Terminal title', '.term-title', undefined, 4.5, 'mono', true);
  text('Terminal prompt', '.t-pr', undefined, 4.5, 'mono');
  text('Terminal command', '.t-cmd', undefined, 4.5, 'mono');
  text('Terminal output', '.t-out', 'ok 12 tests', 4.5, 'mono', true);
  text('Terminal replay button', '.term .btn', '', 4.5, null);
  text('Code language', '.code-lang', undefined, 4.5, 'mono', true);
  text('Code block', 'pre code', undefined, 4.5, 'mono');
  text('Syntax / hljs-keyword', '.hljs-keyword', undefined, 4.5, 'mono');
  text('Syntax / hljs-attr', '.hljs-attr', undefined, 4.5, 'mono');
  text('Syntax / hljs-built_in', '.hljs-built_in', undefined, 4.5, 'mono');
  text('Syntax / hljs-literal', '.hljs-literal', undefined, 4.5, 'mono');
  text('Inline code', 'p code', '&lt;demo&gt;', 4.5, 'mono');
  text('Human text', 'section.human p', 'Only people read this line.', 4.5, 'prose');
  const details = document.querySelector('.dh-doc details[data-fy-llm-only]') as HTMLDetailsElement | null;
  const wasOpen = details?.open ?? false;
  if (details !== null) details.open = true;
  text('LLM disclosure label', 'details[data-fy-llm-only] > summary', undefined, 4.5, 'prose', true);
  text('LLM disclosure code', 'details[data-fy-llm-only] pre', undefined, 4.5, 'mono');
  if (details !== null) details.open = wasOpen;

  // The colour pairs Durian's other parts draw, read through the tokens (a part not in this message cannot be read in place).
  const pairs: readonly (readonly [string, string, string])[] = [
    ['ink', 'ink', 'surface'],
    ['ink-2', 'ink-2', 'surface'],
    ['muted', 'muted', 'surface'],
    ['muted on inset', 'muted', 'surface-2'],
    ['faint', 'faint', 'surface'],
    ['acc-ink', 'acc-ink', 'surface'],
    ['acc-ink on soft', 'acc-ink', 'acc-soft'],
    ['acc-ink on softer', 'acc-ink', 'acc-softer'],
    ['on-acc', 'on-acc', 'acc'],
    ['good-ink', 'good-ink', 'good-soft'],
    ['warn-ink', 'warn-ink', 'warn-soft'],
    ['bad-ink', 'bad-ink', 'bad-soft'],
    ['info-ink', 'info-ink', 'info-soft'],
    ['untested-ink', 'untested-ink', 'untested-soft'],
    ['mark-ink', 'mark-ink', 'mark-bg'],
    ['new-ink', 'new-ink', 'new-bg'],
    ['term-ink', 'term-ink', 'term'],
    ['term-faint', 'term-faint', 'term'],
    ['line numbers', 'ch-24', 'term'],
    ['term-faint on chrome', 'term-faint', 'ch-22'],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => [`c${n}-ink`, `c${n}-ink`, `c${n}-soft`] as const),
  ];
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden';
  doc.appendChild(holder);
  for (const [what, fg, bg] of pairs) {
    const span = document.createElement('span');
    span.textContent = 'x';
    span.style.color = `var(--${fg})`;
    span.style.background = `var(--${bg})`;
    holder.appendChild(span);
    const back = behind(span);
    const need =
      highContrast &&
      !['muted', 'muted on inset', 'faint', 'term-faint', 'term-faint on chrome', 'line numbers'].includes(what)
        ? 7
        : 4.5;
    const got = ratio(inkOver(span, back), back);
    if (got < need)
      rows.push({ category: 'contrast', what: `token ${what}`, detail: `${got.toFixed(2)} vs ${need}`, value: got });
  }
  holder.remove();

  // 3. The palette is the app's.
  const link = find('a', 'the docs');
  const code = find('pre', undefined) ?? find('.ch-pre', undefined);
  const term = find('.term', undefined);
  const chrome = find('.term-chrome', undefined);
  const head = find('th', 'Step');
  const same = (what: string, have: string, wantExpression: string, property: 'color' | 'backgroundColor'): void => {
    const want = resolve(wantExpression, property);
    if (have !== want) rows.push({ category: 'bypass', what, detail: `${have} vs ${want}` });
  };
  same('link is --accent-strong', colourOf(link, 'color'), 'var(--accent-strong, var(--accent))', 'color');
  same('code ground is --code-bg', colourOf(code, 'backgroundColor'), 'var(--code-bg)', 'backgroundColor');
  same('terminal ground is --code-bg', colourOf(term, 'backgroundColor'), 'var(--code-bg)', 'backgroundColor');
  same('table header is --md-th-bg', colourOf(head, 'backgroundColor'), 'var(--md-th-bg)', 'backgroundColor');

  // 4. No self-reference: the names both sides use hold the app's own value inside the document.
  const docStyle = getComputedStyle(doc);
  const rootValue = (token: string): string => rootStyle.getPropertyValue(`--${token}`).trim();
  const mapped: readonly (readonly [string, string])[] = [
    ['surface', 'surface'],
    ['surface-2', 'surface-2'],
    ['surface-3', 'surface-3'],
    ['muted', 'muted'],
    ['faint', 'faint'],
    ['bg', 'bg'],
    ['warn', 'warn'],
    ['line', 'border'],
    ['line-2', 'border-strong'],
    ['ink', 'fg'],
    ['ink-2', 'fg-soft'],
    ['acc', 'accent'],
  ];
  for (const [durian, app] of mapped) {
    const have = docStyle.getPropertyValue(`--${durian}`).trim();
    if (have !== rootValue(app))
      rows.push({ category: 'bypass', what: `--${durian} is --${app}`, detail: `${have} vs ${rootValue(app)}` });
  }

  // A list keeps the marker its style says (the base layer's reset must not win).
  const marker = rootValue('md-ul-marker').replace(/^["']|["']$/gu, '');
  const item = find('li', 'Run the tests with');
  const drawn = item === null ? 'missing' : getComputedStyle(item).listStyleType.replace(/^["']|["']$/gu, '');
  if (marker !== 'none' && drawn !== marker)
    rows.push({ category: 'bypass', what: 'list marker is --md-ul-marker', detail: `${drawn} vs ${marker}` });

  // 5. No literal colour: the three window dots are the app's status colours.
  const dots = [...doc.querySelectorAll('.win-dots i')].map(el => colourOf(el, 'backgroundColor'));
  const literal = [rgba('#ff5f57'), rgba('#febc2e'), rgba('#28c840')].map(c =>
    c.map(v => Math.round(v * 1000) / 1000).join(','),
  );
  dots.forEach((dot, index) => {
    if (dot === literal[index]) rows.push({ category: 'literal', what: `terminal dot ${index + 1}`, detail: dot });
  });

  // 6. No undefined var(): a name a renderer rule reads with no fallback, and no such rule sets, has a value on the document.
  const cache = window as unknown as { __fyHmReads?: string[] };
  cache.__fyHmReads ??= (() => {
    const read = new Set<string>();
    const set = new Set<string>();
    const walk = (list: CSSRuleList): void => {
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) {
          if (!/\.dh-doc|\.fy-hm/u.test(rule.selectorText)) continue;
          for (const m of rule.cssText.matchAll(/(--[\w-]+)\s*:/gu)) set.add(m[1] as string);
          for (const m of rule.cssText.matchAll(/var\(\s*(--[\w-]+)\s*\)/gu)) read.add(m[1] as string);
        } else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    return [...read].filter(name => !set.has(name)).sort();
  })();
  const reads = cache.__fyHmReads;
  // (A token a style may leave unset, and the geometry names Durian's parts set inline on their own element (`style={{ '--d': depth }}`: the file tree, the editor, the animation stage, the tier list and the alignment grid), are not reads of the app's theme.)
  const inline = new Set<string>([...optional, '--ar', '--d', '--i', '--lw', '--nx', '--ny', '--rows']);
  for (const name of reads)
    if (!inline.has(name) && docStyle.getPropertyValue(name).trim() === '')
      rows.push({ category: 'undefined', what: `var(${name}) has no value`, detail: 'empty on .dh-doc' });
  if (reads.length === 0)
    rows.push({ category: 'undefined', what: 'no var() was read', detail: 'the walk found no rule' });

  // 7. Series marks: the tier list and the alignment grid draw every `--c1…8` as a border; each is >= 3:1 on the ground it sits on.
  const toneOf = (el: Element): string => [...el.classList].find(c => /^tone-c[1-8]$/u.test(c)) ?? '';
  const toneSeen = new Set<string>();
  const marksOf: readonly (readonly [string, Element, 'borderTopColor' | 'borderRightColor'])[] = [
    ...[...document.querySelectorAll('.dh-doc .al-cell.al-tint')].map(el => ['cell', el, 'borderTopColor'] as const),
    ...[...document.querySelectorAll('.dh-doc .tl-row')].map(
      row => ['tier', row.querySelector('.tl-label') ?? row, 'borderRightColor'] as const,
    ),
  ];
  for (const [kind, el, side] of marksOf) {
    const tone = toneOf(kind === 'cell' ? el : (el.parentElement ?? el));
    toneSeen.add(tone);
    // The browser PAINTS the mark: a box, shown, not transparent, and a border of that side (the colour read below) that is drawn.
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const edge = side === 'borderTopColor' ? 'Top' : 'Right';
    const unpainted = [
      box.width <= 0 || box.height <= 0 ? 'no box' : '',
      style.visibility !== 'visible' ? `visibility ${style.visibility}` : '',
      opacityOf(el) <= 0 ? 'opacity 0' : '',
      Number.parseFloat(style[`border${edge}Width` as 'borderTopWidth']) <= 0 ||
      style[`border${edge}Style` as 'borderTopStyle'] === 'none'
        ? 'no border'
        : '',
    ].filter(why => why !== '');
    if (unpainted.length > 0)
      rows.push({ category: 'marks', what: `${tone} ${kind} mark painted`, detail: unpainted.join(', ') });
    const back = behind(kind === 'cell' ? (el.parentElement as Element) : (el.parentElement?.parentElement as Element));
    const [r, gr, b, a] = rgba(getComputedStyle(el)[side]);
    const mark: [number, number, number] = [
      r * a + back[0] * (1 - a),
      gr * a + back[1] * (1 - a),
      b * a + back[2] * (1 - a),
    ];
    const got = ratio(mark, back);
    if (got < 3)
      rows.push({ category: 'marks', what: `${tone} ${kind} mark`, detail: `${got.toFixed(2)} vs 3`, value: got });
  }
  for (let n = 1; n <= 8; n += 1)
    if (!toneSeen.has(`tone-c${n}`)) rows.push({ category: 'marks', what: `series c${n} drawn`, detail: 'no mark' });

  return {
    rows,
    colours: {
      link: colourOf(link, 'color'),
      codeGround: colourOf(code, 'backgroundColor'),
      terminalGround: colourOf(term, 'backgroundColor'),
      terminalChrome: colourOf(chrome, 'backgroundColor'),
      tableHeader: colourOf(head, 'backgroundColor'),
    },
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
};

interface Combo {
  readonly style: string;
  readonly palette: string;
  readonly mode: 'light' | 'dark';
}
type Issue = Row & { readonly key: string; readonly combo: string };

const combinationsOf = (styles: readonly string[], palettes: readonly string[]): readonly Combo[] =>
  styles.flatMap(style =>
    palettes.flatMap(palette => (['light', 'dark'] as const).map(mode => ({ style, palette, mode }))),
  );

/** The grid: what the registry says is installed. */
const COMBINATIONS = combinationsOf(
  STYLES.map(style => style.id),
  PALETTES.map(palette => palette.id),
);

/** Every combination, at every viewport, measured: the worst row per (combination, category, what), and each combination's colours. */
const sweep = async (
  site: Site | undefined,
  combos: readonly Combo[],
  viewports: readonly (typeof VIEWPORTS)[number][],
): Promise<{ readonly issues: Map<string, Issue>; readonly colours: Map<string, Colours> }> => {
  const issues = new Map<string, Issue>();
  const colours = new Map<string, Colours>();
  for (const viewport of viewports) {
    const { tab, close } = await open(viewport, site);
    try {
      for (const combo of combos) {
        await setLook(tab, combo.style, combo.palette, combo.mode);
        const measured = (await tab.evaluate(measureInPage, {
          highContrast: combo.palette === 'contrast',
          optional: RENDER_OPTIONAL_STYLE_TOKENS.map(name => `--${name}`),
        })) as Measured;
        const id = `${combo.style}/${combo.palette}/${combo.mode}`;
        colours.set(`${viewport.name}/${id}`, measured.colours);
        if (measured.overflow > 0) {
          issues.set(`${id}|overflow|${viewport.name}`, {
            category: 'contrast',
            what: 'overflow',
            detail: `${measured.overflow}px at ${viewport.name}`,
            key: '',
            combo: id,
          });
        }
        for (const row of measured.rows) {
          const key = `${id}|${row.category}|${row.what}`;
          const earlier = issues.get(key);
          if (earlier === undefined || (row.value ?? 99) < (earlier.value ?? 99))
            issues.set(key, { ...row, key, combo: id });
        }
      }
    } finally {
      await close();
    }
  }
  return { issues, colours };
};

/** The folders under a pack tree's `style/` or `palette/`: THE list of ids, as the generator discovers them. */
const packFolders = async (packs: string, kind: 'style' | 'palette'): Promise<string[]> =>
  (await readdir(join(packs, kind), { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

describe('hypermedia across every theme (r12 H5)', () => {
  it('draws every combination within the audit floors', async () => {
    // The grid IS the folders: a new pack folder is one more row or column here, with no edit to this file.
    const packs = join(repoRoot, THEME_PACKS_DIR);
    expect(COMBINATIONS.length).toBe(
      (await packFolders(packs, 'style')).length * (await packFolders(packs, 'palette')).length * 2,
    );
    expect(COMBINATIONS.length).toBe(STYLES.length * PALETTES.length * 2);

    const { issues, colours } = await sweep(shipped, COMBINATIONS, VIEWPORTS);

    // Each of the palette colours changes when only the palette does (the base drew one fixed set under all eight).
    // (A table header is the style's `--md-th-bg`, and several styles draw none under any palette; the equality check
    // above covers it.)
    const properties = ['link', 'codeGround', 'terminalChrome'] as const;
    for (const viewport of VIEWPORTS)
      for (const style of STYLES)
        for (const mode of ['light', 'dark'] as const)
          for (const property of properties) {
            const seen = new Set(
              PALETTES.map(p => colours.get(`${viewport.name}/${style.id}/${p.id}/${mode}`)?.[property] ?? 'missing'),
            );
            // (A style whose header is a label draws no band at all: transparent under every palette.)
            if (seen.size < 2 && [...seen][0] !== '0,0,0,0') {
              const id = `${style.id}/*/${mode}`;
              issues.set(`${id}|bypass|${property}`, {
                category: 'bypass',
                what: `${property} is one colour under every palette`,
                detail: [...seen][0] ?? '',
                key: '',
                combo: id,
              });
            }
          }

    const all = [...issues.values()];
    const byCategory = Object.fromEntries(
      (['font', 'contrast', 'bypass', 'literal', 'undefined', 'marks'] as const).map(category => [
        category,
        all.filter(r => r.category === category).length,
      ]),
    );
    const failingCombos = new Set(all.filter(r => r.category === 'contrast').map(r => r.combo)).size;
    const summary = {
      combinations: COMBINATIONS.length,
      rows: all.length,
      byCategory,
      combinationsWithContrastFailure: failingCombos,
    };
    const byWhat: Record<string, { count: number; worst: number | null }> = {};
    for (const row of all) {
      const key = `${row.category}: ${row.what}`;
      const entry = byWhat[key] ?? { count: 0, worst: null };
      byWhat[key] = entry;
      entry.count += 1;
      if (row.value !== undefined) entry.worst = Math.min(entry.worst ?? 99, row.value);
    }
    if (reportFile !== '') await writeFile(reportFile, JSON.stringify({ summary, byWhat, rows: all }, null, 1));
    console.log(JSON.stringify({ summary, byWhat }, null, 1));
    expect(all.slice(0, 20).map(r => `${r.combo} | ${r.category} | ${r.what} | ${r.detail}`)).toEqual([]);
    expect(all.length).toBe(0);
  });

  /**
   * THE MATRIX HAS TEETH. A private pack tree: every shipped folder copied into a temporary directory, four scratch palettes
   * beside them (the checkout is never written; the scene is built from the private tree's generated files). The grid is the
   * private tree's own folders, so the scratch palettes are found, not listed: the one that is a valid folder passes under every
   * style and both modes, and each one that breaks the render contract fails under every style and both modes, in its own way.
   */
  describe('a pack folder is tested the moment it exists', () => {
    const OK = 'zz-fixture-ok';
    const BREAKS = {
      'zz-fixture-text': { category: 'contrast', light: { fg: 'var(--bg)' }, dark: { fg: 'var(--bg)' } },
      'zz-fixture-mark': {
        category: 'marks',
        light: { 'viz-3': 'var(--surface)' },
        dark: { 'viz-3': 'var(--surface)' },
      },
    } as const;
    const palette = (id: string, light: object, dark: object): string =>
      `export default {\n  id: '${id}',\n  label: 'Fixture ${id}',\n  blurb: 'A palette added only as a folder.',\n  order: 9999,\n  light: ${JSON.stringify(light)},\n  dark: ${JSON.stringify(dark)},\n} as const;\n`;

    let privateSite: Site | undefined;
    let privateDirectory = '';
    let privateRoot = '';
    let before = '';
    const checkoutGenerated = [THEME_PACKS_TS, THEME_PACKS_CSS, THEME_IDS_JS].map(rel => join(repoRoot, rel));
    const checkoutState = async (): Promise<string> =>
      JSON.stringify([
        await Promise.all(checkoutGenerated.map(file => readFile(file, 'utf8').catch(() => null))),
        await packFolders(join(repoRoot, THEME_PACKS_DIR), 'palette'),
      ]);

    beforeAll(async () => {
      before = await checkoutState();
      privateDirectory = await mkdtemp(join(tmpdir(), 'ferretry-hypermedia-packs-'));
      const root = join(privateDirectory, 'themes');
      const packs = join(root, THEME_PACKS_DIR);
      await cp(join(repoRoot, THEME_PACKS_DIR), packs, { recursive: true });
      const scratch = { [OK]: palette(OK, { accent: '#0b57b0' }, { accent: '#9fc4ff' }) } as Record<string, string>;
      for (const [id, pack] of Object.entries(BREAKS)) scratch[id] = palette(id, pack.light, pack.dark);
      for (const [id, text] of Object.entries(scratch)) {
        await mkdir(join(packs, 'palette', id), { recursive: true });
        await writeFile(join(packs, 'palette', id, 'palette.ts'), text);
      }
      for (const [rel, text] of themePackFiles(root)) {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await writeFile(join(root, rel), text);
      }
      privateSite = await buildSite(root);
      privateRoot = packs;
    }, 300_000);

    afterAll(async () => {
      await privateSite?.stop();
      if (privateDirectory !== '') await rm(privateDirectory, { force: true, recursive: true });
    });

    it('passes a scratch palette that is a valid folder and fails each one that breaks the render contract, under every style', async () => {
      const styles = await packFolders(privateRoot, 'style');
      const found = (await packFolders(privateRoot, 'palette')).filter(id => id.startsWith('zz-fixture-'));
      expect(found.sort()).toEqual([OK, ...Object.keys(BREAKS)].sort());
      const combos = combinationsOf(styles, found);
      const { issues } = await sweep(privateSite, combos, [VIEWPORTS[1]]);
      const rowsOf = (id: string, category?: Category): Issue[] =>
        [...issues.values()].filter(
          row => row.combo.split('/')[1] === id && (category === undefined || row.category === category),
        );

      // GREEN: the valid folder is clean in every combination.
      expect(rowsOf(OK).map(r => `${r.combo} | ${r.category} | ${r.what} | ${r.detail}`)).toEqual([]);
      // RED: each break is reported, in its own category, under every style and both modes.
      for (const [id, pack] of Object.entries(BREAKS))
        for (const style of styles)
          for (const mode of ['light', 'dark'] as const) {
            const here = rowsOf(id, pack.category).filter(row => row.combo === `${style}/${id}/${mode}`);
            expect([`${style}/${id}/${mode}`, pack.category, here.length > 0]).toEqual([
              `${style}/${id}/${mode}`,
              pack.category,
              true,
            ]);
          }
    });

    it('leaves the checkout alone (no scratch palette and no generated file written there)', async () => {
      expect(await checkoutState()).toBe(before);
      expect(JSON.parse(before)[1]).not.toContain(OK);
    });

    it('reports a name the renderer reads and nothing defines (a rule added to a fresh page, not to the product)', async () => {
      const { tab, close } = await open(VIEWPORTS[1], shipped);
      try {
        await tab.addStyleTag({ content: '.dh-doc .zz-probe { color: var(--zz-defined-nowhere); }' });
        const measured = (await tab.evaluate(measureInPage, {
          highContrast: false,
          optional: RENDER_OPTIONAL_STYLE_TOKENS.map(name => `--${name}`),
        })) as Measured;
        expect(measured.rows.filter(row => row.category === 'undefined').map(row => row.what)).toEqual([
          'var(--zz-defined-nowhere) has no value',
        ]);
      } finally {
        await close();
      }
    });
  });

  /** THE MARKS ARE PAINTED: a stylesheet that hides, fades or un-borders the tier and alignment marks is reported, whatever colours they hold. */
  it('reports series marks the browser does not paint (hidden, invisible, transparent or without a border)', async () => {
    const SUPPRESS = {
      'display none': 'display: none',
      'visibility hidden': 'visibility: hidden',
      'opacity 0': 'opacity: 0',
      'no border': 'border-width: 0',
    } as const;
    for (const [name, declaration] of Object.entries(SUPPRESS)) {
      const { tab, close } = await open(VIEWPORTS[1], shipped);
      try {
        await tab.addStyleTag({
          content: `.dh-doc .tl-label, .dh-doc .al-cell.al-tint { ${declaration} !important; }`,
        });
        const measured = (await tab.evaluate(measureInPage, {
          highContrast: false,
          optional: RENDER_OPTIONAL_STYLE_TOKENS.map(token => `--${token}`),
        })) as Measured;
        const unpainted = measured.rows.filter(row => row.category === 'marks' && row.what.endsWith('mark painted'));
        // All 13 marks of the scene (tiers and alignment cells) are named: none passes unseen.
        expect([name, unpainted.length >= 13]).toEqual([name, true]);
      } finally {
        await close();
      }
    }
  });

  /** In the page: what a terminal and a callout are drawn with, and what the root says the style's shape and header are. */
  const shapeInPage = (): {
    readonly variant: string | null;
    readonly header: string | null;
    readonly shape: string;
    readonly headerToken: string;
    readonly tuple: string;
  } => {
    const doc = document.querySelector('.dh-doc') as HTMLElement;
    const wrapper = doc.closest('.fy-hm') as HTMLElement;
    const root = getComputedStyle(document.documentElement);
    const term = getComputedStyle(document.querySelector('.dh-doc .term') as Element);
    const chrome = getComputedStyle(document.querySelector('.dh-doc .term-chrome') as Element);
    const callout = getComputedStyle(document.querySelector('.dh-doc .callout') as Element);
    return {
      variant: doc.getAttribute('data-dh-variant'),
      header: wrapper.getAttribute('data-hm-header'),
      shape: root.getPropertyValue('--hm-shape').trim(),
      headerToken: root.getPropertyValue('--hm-header').trim(),
      tuple: JSON.stringify([
        term.borderTopLeftRadius,
        term.borderTopWidth,
        term.boxShadow,
        chrome.display,
        chrome.backgroundColor,
        callout.backgroundColor,
        callout.borderTopColor,
        callout.borderTopWidth,
        callout.boxShadow,
      ]),
    };
  };

  it('draws every other style differently from Studio, and carries the style shape and header', async () => {
    const { tab, close } = await open(VIEWPORTS[1]);
    try {
      const looks = new Map<string, Awaited<ReturnType<typeof shapeInPage>>>();
      for (const style of STYLES) {
        await setLook(tab, style.id, 'studio', 'light');
        looks.set(style.id, (await tab.evaluate(shapeInPage)) as Awaited<ReturnType<typeof shapeInPage>>);
      }
      const studio = looks.get('studio');
      for (const [id, look] of looks) {
        // The document says what the style says: shaped is Durian's own drawing and names no variant.
        expect(look.variant).toBe(look.shape === 'shaped' ? null : look.shape);
        expect(look.header).toBe(look.headerToken);
        if (id !== 'studio') expect([id, look.tuple]).not.toEqual([id, studio?.tuple]);
      }
      // The four shapes are four different drawings: one style of each, same palette.
      const shapes = new Set(['studio', 'geist', 'raw', 'neo'].map(id => looks.get(id)?.shape));
      expect([...shapes].sort()).toEqual(['block', 'flat', 'ink', 'shaped']);
      const drawn = new Set(['studio', 'geist', 'raw', 'neo'].map(id => looks.get(id)?.tuple));
      expect(drawn.size).toBe(4);
    } finally {
      await close();
    }
  });

  // Set FY_HYPERMEDIA_THEME_SHOTS=<dir> to keep `<style>-<palette>-<mode>-<width>.png` for one style of each shape, on its own palette.
  const shotsDir = process.env.FY_HYPERMEDIA_THEME_SHOTS ?? '';
  it.skipIf(shotsDir === '')('keeps screenshots of the shapes, light and dark, on a phone and a desktop', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(shotsDir, { recursive: true });
    for (const viewport of VIEWPORTS) {
      const { tab, close } = await open(viewport);
      try {
        // The whole exchange on screen, and both terminals finished typing (the second types when it comes into view).
        await tab.setViewportSize({ width: viewport.width, height: 1_500 });
        await tab.waitForFunction(() => document.body.textContent?.includes('ok 30 tests') === true);
        for (const id of ['studio', 'geist', 'raw', 'neo', 'mission', 'briefing', 'pixel', 'glass']) {
          const style = STYLES.find(entry => entry.id === id);
          for (const mode of ['light', 'dark'] as const) {
            await setLook(tab, id, style?.defaultPalette ?? 'studio', mode);
            await tab.screenshot({
              path: join(shotsDir, `${id}-${style?.defaultPalette}-${mode}-${viewport.name}.png`),
            });
          }
        }
      } finally {
        await close();
      }
    }
  });

  it('re-themes within one frame when the palette, the style or the mode changes', async () => {
    const { tab, close } = await open(VIEWPORTS[1]);
    try {
      const change = async (
        attribute: string,
        value: string,
      ): Promise<{ term: string; expected: string; variant: string | null; shape: string }> =>
        (await tab.evaluate(
          ([name, next]) =>
            new Promise(resolve => {
              document.documentElement.setAttribute(name as string, next as string);
              // The theme-matrix scene's legacy `data-theme` is not touched: only the one axis moves.
              requestAnimationFrame(() => {
                const doc = document.querySelector('.dh-doc') as HTMLElement;
                const probe = document.createElement('i');
                probe.style.background = 'var(--code-bg)';
                (doc.closest('.fy-hm') as HTMLElement).appendChild(probe);
                const expected = getComputedStyle(probe).backgroundColor;
                probe.remove();
                resolve({
                  term: getComputedStyle(document.querySelector('.dh-doc .term') as Element).backgroundColor,
                  expected,
                  variant: doc.getAttribute('data-dh-variant'),
                  shape: getComputedStyle(document.documentElement).getPropertyValue('--hm-shape').trim(),
                });
              });
            }),
          [attribute, value],
        )) as { term: string; expected: string; variant: string | null; shape: string };
      await setLook(tab, 'studio', 'studio', 'light');
      const palette = await change('data-palette', 'mission');
      expect(palette.term).toBe(palette.expected);
      const mode = await change('data-mode', 'dark');
      expect(mode.term).toBe(mode.expected);
      expect(mode.term).not.toBe(palette.term);
      const style = await change('data-style', 'neo');
      expect(style.shape).toBe('block');
      expect(style.variant).toBe('block');
      const back = await change('data-style', 'studio');
      expect(back.variant).toBeNull();
    } finally {
      await close();
    }
  });
});
