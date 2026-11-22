/**
 * HYPERMEDIA ACROSS EVERY THEME (r12 H5), in a real browser: all 16 styles x 8 palettes x light and dark (256 combinations),
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
 * Set `FY_HYPERMEDIA_THEME_REPORT=<file>` to write the issue counts (the same four categories as the audit) as JSON.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Browser, Page } from 'playwright-core';
import { PALETTES, STYLES } from '@ferretry/app';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(600_000);

const packageRoot = import.meta.dir;
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
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-hypermedia-theme-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/hypermedia-prose-scene.tsx'],
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
  browser = await sharedChromium();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${durian}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
}, 300_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '390', width: 390, height: 1_500, phone: true },
  { name: '1280', width: 1_280, height: 900, phone: false },
] as const;

const open = async (viewport: (typeof VIEWPORTS)[number]): Promise<{ tab: Page; close: () => Promise<void> }> => {
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
  await tab.goto(`${origin}/?theme=studio-light`);
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

type Category = 'contrast' | 'font' | 'bypass' | 'literal';
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
const measureInPage = ({ highContrast }: { highContrast: boolean }): Measured => {
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

const COMBINATIONS = STYLES.flatMap(style =>
  PALETTES.flatMap(palette =>
    (['light', 'dark'] as const).map(mode => ({ style: style.id, palette: palette.id, mode })),
  ),
);

describe('hypermedia across every theme (r12 H5)', () => {
  it('draws every combination within the audit floors', async () => {
    const issues = new Map<string, Row & { readonly key: string; readonly combo: string }>();
    const colours = new Map<string, Colours>();
    for (const viewport of VIEWPORTS) {
      const { tab, close } = await open(viewport);
      try {
        for (const combo of COMBINATIONS) {
          await setLook(tab, combo.style, combo.palette, combo.mode);
          const measured = (await tab.evaluate(measureInPage, {
            highContrast: combo.palette === 'contrast',
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
      (['font', 'contrast', 'bypass', 'literal'] as const).map(category => [
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
