/**
 * G2 U7 · A THEME ID COMES FROM A PACK FOLDER, AND NOTHING ELSE. Adding a pack is adding a folder, so a stored id with a
 * folder must survive a reload in BOTH places that read it before the person can touch anything:
 *
 *   pre-paint   `public/pre-paint.js`, the first frame, before any module (it keeps no list of ids);
 *   hydration   `ThemePreferenceStore` reading the same stored value inside the real `App`.
 *
 * and a stored id with NO folder must show the default look in both, in light and dark, and is left in storage.
 *
 * The scratch STYLE and PALETTE are written here as two folders and nothing else: no list, table or contract file is
 * edited. The generator discovers them (`scripts/gen/registries.ts`, the one thing `bun install` and every build already
 * run), the scene is built from what it wrote, and both folders are removed (and the generator re-run) afterwards. Bun
 * runs one test file at a time per process, so nothing else reads the tree while the scratch folders exist.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(180_000);

const packageRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(packageRoot, '../..');
const packs = join(packageRoot, 'src/theme/packs');
const SCRATCH_STYLE = 'zz-scratch-style';
const SCRATCH_PALETTE = 'zz-scratch-palette';
const scratchFolders = [join(packs, 'style', SCRATCH_STYLE), join(packs, 'palette', SCRATCH_PALETTE)];
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
const generate = async (): Promise<void> => void (await run([process.execPath, 'scripts/gen/registries.ts'], repoRoot));
const removeScratch = async (): Promise<void> => {
  for (const folder of scratchFolders) await rm(folder, { force: true, recursive: true });
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  await removeScratch();
  // Two folders, and that is all: a palette (data) and a style (meta + scoped CSS).
  for (const folder of scratchFolders) await mkdir(folder, { recursive: true });
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
  await generate();

  directory = await mkdtemp(join(tmpdir(), 'ferretry-theme-open-ids-'));
  const stdout = await run(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'tests/integration/fixtures/device-controls-scene.tsx'),
    ],
    packageRoot,
  );
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const prePaint = await readFile(resolve(packageRoot, 'public/pre-paint.js'), 'utf8');
  // HYDRATION: the real App, no pre-paint script, the stored value seeded into its store (`?seed=`).
  const app = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  // FIRST PAINT: the app's stylesheet, then the REAL pre-paint script (parser-blocking), then ONE inline reader, and no app code.
  const first = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><script src="/pre-paint.js"></script><script>${READ}window.__first = read();</script></head><body></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/pre-paint.js') return new Response(prePaint, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/first') return new Response(first, { headers: { 'content-type': 'text/html' } });
      return new Response(app, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
  await removeScratch();
  await generate();
}, 60_000);

/** What a page paints: the three root attributes and the two tokens the scratch pack sets. Runs inside the page. */
const READ = `function read() {
  var root = document.documentElement;
  var style = getComputedStyle(root);
  return {
    style: root.getAttribute('data-style'),
    palette: root.getAttribute('data-palette'),
    mode: root.getAttribute('data-mode'),
    bg: style.getPropertyValue('--bg').trim(),
    radius: style.getPropertyValue('--radius-md').trim(),
  };
}
`;

interface Painted {
  readonly style: string | null;
  readonly palette: string | null;
  readonly mode: string | null;
  readonly bg: string;
  readonly radius: string;
}

const origin = (): string => server?.url.origin ?? '';
type Mode = 'light' | 'dark';

/** The first frame: stylesheet + pre-paint.js reading a real `localStorage` that already holds `value`. */
const firstPaint = async (value: Record<string, unknown> | null, mode: Mode): Promise<Painted> => {
  const context = await browser.newContext({ colorScheme: mode });
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
const hydrated = async (value: Record<string, unknown> | null, mode: Mode): Promise<Painted> => {
  const context = await browser.newContext({ colorScheme: mode, viewport: { width: 1_280, height: 3_200 } });
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

for (const mode of ['light', 'dark'] as const) {
  describe(`a pack that is only a folder, ${mode}`, () => {
    const scratch = stored(SCRATCH_STYLE, SCRATCH_PALETTE, mode);
    const painted = { style: SCRATCH_STYLE, palette: SCRATCH_PALETTE, mode, bg: PAINT[mode], radius: PAINT.radius };

    it('pre-paint: the first frame wears the scratch style and palette, and their tokens', async () => {
      expect(await firstPaint(scratch, mode)).toEqual(painted);
    });

    it('hydration: the real App keeps them (no pre-paint, the stored value read by the store)', async () => {
      expect(await hydrated(scratch, mode)).toEqual(painted);
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

  describe(`an id with no folder is the default look, ${mode}`, () => {
    const gone = stored('zz-no-such-style', 'zz-no-such-palette', mode);

    it('pre-paint: paints the default look (an id no pack answers to matches no pack rule)', async () => {
      const unset = await firstPaint(null, mode);
      const read = await firstPaint(gone, mode);
      // The attributes carry the stored id (pre-paint has no list to know better); every token is the default look's.
      expect({ bg: read.bg, radius: read.radius, mode: read.mode }).toEqual({
        bg: unset.bg,
        radius: unset.radius,
        mode: unset.mode,
      });
      expect(read.bg).not.toBe(PAINT[mode]);
    });

    it('hydration: React publishes the default style and palette, and the default tokens', async () => {
      const unset = await hydrated(null, mode);
      expect(await hydrated(gone, mode)).toEqual({ ...unset, mode });
      expect({ style: unset.style, palette: unset.palette }).toEqual({ style: 'studio', palette: 'studio' });
    });
  });
}
