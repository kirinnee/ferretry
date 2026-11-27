/**
 * G2 U7 · A THEME ID COMES FROM A PACK FOLDER, AND NOTHING ELSE. Adding a pack is adding a folder, so a stored id with a
 * folder must survive a reload in BOTH places that read it before the person can touch anything:
 *
 *   pre-paint   `public/pre-paint.js`, the first frame, before any module (it keeps no list of ids);
 *   hydration   `ThemePreferenceStore` reading the same stored value inside the real `App`.
 *
 * and a stored id with NO folder (a retired or mistyped one) must show the default look in both: the SAME first frame as
 * React publishes, down to the properties only Studio's own rules set (bubble radius, the mobile type ramp, the dark
 * shadows), at 390 and 1280, light and dark. The stored record is left in storage.
 *
 * The scratch STYLE and PALETTE are written here as two folders and nothing else: no list, table or contract file is
 * edited. THIS TEST NEVER WRITES THE CHECKOUT: it builds a private pack tree in a temporary directory (every shipped pack
 * folder copied in, the two scratch folders beside them), runs the generator over it (`themePackFiles(root)`, which reads
 * and names files under the root it is given), and builds the scene from those private outputs (`build-scene.ts
 * --theme-root`), so a parallel shard reading the checkout never sees a scratch pack. The last test proves the checkout's
 * generated files and pack folders are what they were.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import {
  THEME_IDS_JS,
  THEME_PACKS_CSS,
  THEME_PACKS_DIR,
  THEME_PACKS_TS,
  themePackFiles,
} from '../../../../scripts/gen/lib/theme-packs.ts';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(180_000);

const packageRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(packageRoot, '../..');
const SCRATCH_STYLE = 'zz-scratch-style';
const SCRATCH_PALETTE = 'zz-scratch-palette';
/** The checkout's own pack tree and generated files: read only, here. */
const checkoutPacks = join(repoRoot, THEME_PACKS_DIR);
const checkoutGenerated = [THEME_PACKS_TS, THEME_PACKS_CSS, THEME_IDS_JS].map(rel => join(repoRoot, rel));
/** What the scratch pack paints, light and dark: a background of its own and a radius no shipped style has. */
const PAINT = { light: '#102030', dark: '#403020', radius: '3px' } as const;

const run = async (command: readonly string[], cwd: string): Promise<string> => {
  const child = Bun.spawn([...command], { cwd, stderr: 'pipe', stdout: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(' ')} failed (${code}):\n${stderr}\n${stdout}`);
  return stdout;
};

/** What the checkout holds that this test must not change: the three generated files and the pack folder names. */
const checkoutState = async (): Promise<string> =>
  JSON.stringify([
    await Promise.all(checkoutGenerated.map(file => readFile(file, 'utf8').catch(() => null))),
    await Promise.all(
      ['style', 'palette', 'font'].map(kind => readdir(join(checkoutPacks, kind)).then(names => names.sort())),
    ),
  ]);
const before = await checkoutState();

let browser: Browser;
let directory = '';
let privateRoot = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-theme-open-ids-'));
  // A private pack tree: a copy of every shipped folder (the generator reads real directories), then the two scratch folders.
  privateRoot = join(directory, 'themes');
  const packs = join(privateRoot, THEME_PACKS_DIR);
  await cp(checkoutPacks, packs, { recursive: true });
  for (const folder of [join(packs, 'style', SCRATCH_STYLE), join(packs, 'palette', SCRATCH_PALETTE)])
    await mkdir(folder, { recursive: true });
  await writeFile(
    join(packs, 'palette', SCRATCH_PALETTE, 'palette.ts'),
    `export default {
  id: '${SCRATCH_PALETTE}',
  label: 'Scratch Palette',
  blurb: 'A palette added only as a folder.',
  order: 9999,
  light: { bg: '${PAINT.light}' },
  dark: { bg: '${PAINT.dark}' },
} as const;
`,
  );
  await writeFile(
    join(packs, 'style', SCRATCH_STYLE, 'style.ts'),
    `export default {
  id: '${SCRATCH_STYLE}',
  label: 'Scratch Style',
  blurb: 'A style added only as a folder.',
  order: 9999,
  defaultPalette: 'studio',
  fonts: { text: ['inter'], code: ['jetbrains-mono'] },
} as const;
`,
  );
  await writeFile(
    join(packs, 'style', SCRATCH_STYLE, 'style.css'),
    `:root[data-style='${SCRATCH_STYLE}'],
[data-swatch][data-style='${SCRATCH_STYLE}'] {
  --radius-md: ${PAINT.radius};
}
`,
  );
  // The generator's own function over the private root; its outputs land there, not in the checkout.
  for (const [rel, text] of themePackFiles(privateRoot)) {
    await mkdir(dirname(join(privateRoot, rel)), { recursive: true });
    await writeFile(join(privateRoot, rel), text);
  }

  const stdout = await run(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'tests/integration/fixtures/device-controls-scene.tsx'),
      '--theme-root',
      privateRoot,
    ],
    packageRoot,
  );
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const prePaint = await readFile(resolve(packageRoot, 'public/pre-paint.js'), 'utf8');
  const themeIds = await readFile(join(privateRoot, THEME_IDS_JS), 'utf8');
  // HYDRATION: the real App, no pre-paint script, the stored value seeded into its store (`?seed=`).
  const app = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  // FIRST PAINT: the app's stylesheet, then the REAL pre-paint script (parser-blocking), then ONE inline reader, and no app code.
  const first = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><script src="/generated/theme-ids.js"></script><script src="/pre-paint.js"></script><script>${READ}window.__first = read();</script></head><body></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/pre-paint.js') return new Response(prePaint, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/generated/theme-ids.js')
        return new Response(themeIds, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/first') return new Response(first, { headers: { 'content-type': 'text/html' } });
      return new Response(app, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
}, 60_000);

/**
 * What a page paints: the root attributes, the two tokens the scratch pack sets, and three properties only STUDIO's own
 * rules set (the chat bubble's radius, the mobile type ramp's `--text-xs`, the dark shadow), which the base tokens differ on.
 * Runs inside the page.
 */
const READ = `function read() {
  var root = document.documentElement;
  var style = getComputedStyle(root);
  return {
    style: root.getAttribute('data-style'),
    palette: root.getAttribute('data-palette'),
    mode: root.getAttribute('data-mode'),
    bg: style.getPropertyValue('--bg').trim(),
    radius: style.getPropertyValue('--radius-md').trim(),
    bubbleRadius: style.getPropertyValue('--bubble-radius').trim(),
    textXs: style.getPropertyValue('--text-xs').trim(),
    shadowMd: style.getPropertyValue('--shadow-md').trim(),
  };
}
`;

interface Painted {
  readonly style: string | null;
  readonly palette: string | null;
  readonly mode: string | null;
  readonly bg: string;
  readonly radius: string;
  readonly bubbleRadius: string;
  readonly textXs: string;
  readonly shadowMd: string;
}

const origin = (): string => server?.url.origin ?? '';
type Mode = 'light' | 'dark';
type Width = 390 | 1_280;

/** The first frame: stylesheet + pre-paint.js reading a real `localStorage` that already holds `value`. */
const firstPaint = async (
  value: Record<string, unknown> | null,
  mode: Mode,
  width: Width = 1_280,
): Promise<Painted> => {
  const context = await browser.newContext({ colorScheme: mode, viewport: { width, height: 900 } });
  try {
    if (value !== null)
      await context.addInitScript(
        raw => localStorage.setItem('fy:app:theme', raw),
        JSON.stringify({ format: 1, value }),
      );
    const tab = await context.newPage();
    await tab.goto(`${origin()}/first`);
    return await tab.evaluate(() => (window as unknown as { __first: Painted }).__first);
  } finally {
    await context.close();
  }
};

/** React hydration: the real App reads the same stored value through `ThemePreferenceStore`. */
const hydrated = async (value: Record<string, unknown> | null, mode: Mode, width: Width = 1_280): Promise<Painted> => {
  const context = await browser.newContext({ colorScheme: mode, viewport: { width, height: 3_200 } });
  try {
    const tab = await context.newPage();
    const seed = value === null ? '' : `?seed=${encodeURIComponent(JSON.stringify(value))}`;
    await tab.goto(`${origin()}/settings${seed}`);
    await tab.waitForSelector('[data-specimen]');
    return (await tab.evaluate(`(() => { ${READ} return read(); })()`)) as Painted;
  } finally {
    await context.close();
  }
};

const stored = (style: string, palette: string, mode: Mode) => ({ style, palette, mode, textScale: 'default' });

/** The properties Studio's own rules set, and the one the scratch pack sets: a first frame must match React on all of them. */
const look = ({ style, palette, mode, bg, radius, bubbleRadius, textXs, shadowMd }: Painted) => ({
  style,
  palette,
  mode,
  bg,
  radius,
  bubbleRadius,
  textXs,
  shadowMd,
});

for (const mode of ['light', 'dark'] as const) {
  describe(`a pack that is only a folder, ${mode}`, () => {
    const scratch = stored(SCRATCH_STYLE, SCRATCH_PALETTE, mode);
    const painted = { style: SCRATCH_STYLE, palette: SCRATCH_PALETTE, mode, bg: PAINT[mode], radius: PAINT.radius };

    it('pre-paint: the first frame wears the scratch style and palette, and their tokens', async () => {
      expect(await firstPaint(scratch, mode)).toMatchObject(painted);
    });

    it('hydration: the real App keeps them (no pre-paint, the stored value read by the store)', async () => {
      expect(await hydrated(scratch, mode)).toMatchObject(painted);
    });

    it('is offered by the pickers as soon as the folder exists', async () => {
      const context = await browser.newContext({ viewport: { width: 1_280, height: 3_200 } });
      try {
        const tab = await context.newPage();
        await tab.goto(`${origin()}/settings`);
        await tab.waitForSelector('[data-specimen]');
        expect(await tab.locator(`[data-choice="${SCRATCH_STYLE}"]`).count()).toBe(1);
        expect(await tab.locator(`[data-palette-chip="${SCRATCH_PALETTE}"]`).count()).toBe(1);
      } finally {
        await context.close();
      }
    });
  });

  describe(`an id with no folder is the whole default look, ${mode}`, () => {
    // A retired style and palette: well-formed ids no folder answers to.
    const gone = stored('contrast', 'blueprint', mode);

    for (const width of [390, 1_280] as const) {
      it(`the first frame at ${width}px is what React publishes (Studio's own rules included)`, async () => {
        const unset = await hydrated(null, mode, width);
        const react = await hydrated(gone, mode, width);
        const first = await firstPaint(gone, mode, width);
        expect({ style: react.style, palette: react.palette }).toEqual({ style: 'studio', palette: 'studio' });
        expect(look(react)).toEqual(look(unset));
        // Not vacuous: these are properties only Studio's rules set, so a first frame that skipped them would differ here.
        expect(react.bubbleRadius).toBe('14px 14px 8px 14px');
        expect(look(first)).toEqual(look(react));
        expect(first.bg).not.toBe(PAINT[mode]);
      });
    }
  });
}

describe('this test leaves the checkout alone', () => {
  it('writes no scratch pack and no generated file into the checkout (a parallel shard reads them)', async () => {
    expect(await checkoutState()).toBe(before);
    expect(JSON.parse(before)[1].flat()).not.toContain(SCRATCH_STYLE);
  });
});
