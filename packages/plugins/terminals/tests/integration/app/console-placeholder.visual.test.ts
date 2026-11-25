/**
 * THE CONSOLE'S EMPTY FIELD CAN BE READ (L288b), in a real browser over the real `ConsoleSurface`
 * (`fixtures/console-pane-scene.tsx`).
 *
 * The field under the pane says "Keys go to the agent's pane" until you type. It took the framework's default placeholder grey
 * (#9ca3af), which is 2.33:1 on Studio light's #f5f5f7 field and under 4.5:1 in nearly every light look. The field is a CODE field
 * (`--code-bg` / `--code-fg`), and in Briefing light that field is dark navy, so the ink must come from the field's own `--code-fg`:
 * a page token such as `--muted` would pass on the pale fields and fail on the navy one.
 *
 * Every palette is read in light and dark in its own style, then every style over every palette in light: the placeholder, as drawn
 * (ink x opacity over the field's fill), must hold WCAG's 4.5:1 for text, and the field must still read as quieter than typed text.
 *
 * Set `FY_CONSOLE_PLACEHOLDER_SHOTS_DIR` to keep `<name>.png` (the Console box at 390 and 1440, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { ALL_PALETTE_IDS, COLOUR_TOOLS, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
/** The shipped styles (`packages/app/src/styles/style/*.css`): a plugin's tests do not import the Layouts contract. */
const STYLE_IDS = [
  'antiposh',
  'briefing',
  'exaggerated',
  'geist',
  'genz',
  'glass',
  'hud',
  'lucid',
  'mission',
  'neo',
  'neumorphism',
  'pixel',
  'raw',
  'retro',
  'studio',
  'swiss',
] as const;

setDefaultTimeout(240_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CONSOLE_PLACEHOLDER_SHOTS_DIR ?? '';
const FLOOR = 4.5;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-console-placeholder-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/console-pane-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the console scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg" style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Reading {
  readonly look: string;
  readonly placeholder: number;
  readonly typed: number;
  readonly drawn: string;
  readonly field: string;
}

/** What the placeholder looks like to the eye in the page's current look: its ink x opacity over the field's own fill. */
const READ = (): Reading => {
  const tools = (window as unknown as { __colour: import('@ferretry/app/testing/browser').ColourTools }).__colour;
  const input = document.querySelector('[data-console-input]') as HTMLElement;
  const field = tools.backdrop(input);
  const style = getComputedStyle(input, '::placeholder');
  const ink = tools.rgba(style.color);
  const drawn = tools.over([ink[0], ink[1], ink[2], ink[3] * Number.parseFloat(style.opacity)], [...field, 1]);
  const typedInk = tools.rgba(getComputedStyle(input).color);
  const typed = tools.over(typedInk, [...field, 1]);
  const hex = (c: readonly number[]): string => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const root = document.documentElement.dataset;
  return {
    look: `${root.palette}/${root.style}/${root.mode}`,
    placeholder: tools.ratio(drawn, field),
    typed: tools.ratio(typed, field),
    drawn: hex(drawn),
    field: hex(field),
  };
};

const open = async (width: number, height: number, scheme: 'light' | 'dark', theme: string, phone: boolean) => {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    deviceScaleFactor: phone ? 2 : 1,
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  await tab.goto(`${server?.url.origin}/?theme=${theme}&w=${phone ? 358 : 366}&h=${phone ? 560 : 640}`);
  await tab.waitForFunction(() => '__console' in window);
  await tab.evaluate(COLOUR_TOOLS);
  return { tab, close: () => context.close() };
};

describe('the Console field placeholder', () => {
  it('holds 4.5:1 in every palette, light and dark, in its own style', async () => {
    const { tab, close } = await open(390, 844, 'light', 'studio-light', true);
    const failures: string[] = [];
    try {
      for (const mode of ['light', 'dark'] as const)
        for (const palette of ALL_PALETTE_IDS) {
          await tab.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), `${palette}-${mode}`);
          await tab.waitForTimeout(60);
          const reading = await tab.evaluate(READ);
          if (reading.placeholder < FLOOR)
            failures.push(
              `${reading.look}: ${reading.placeholder.toFixed(2)}:1 (${reading.drawn} on ${reading.field})`,
            );
          // Still a placeholder: quieter than the text you type, never the same ink.
          expect(reading.placeholder, `${reading.look} reads quieter than typed text`).toBeLessThan(reading.typed);
        }
    } finally {
      await close();
    }
    expect(failures, `placeholders under ${FLOOR}:1:\n${failures.join('\n')}`).toEqual([]);
  });

  it('holds 4.5:1 in every style over every palette, light', async () => {
    const { tab, close } = await open(390, 844, 'light', 'studio-light', true);
    const failures: string[] = [];
    try {
      for (const palette of ALL_PALETTE_IDS) {
        await tab.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), `${palette}-light`);
        for (const style of STYLE_IDS) {
          await tab.evaluate(value => document.documentElement.setAttribute('data-style', value), style);
          const reading = await tab.evaluate(READ);
          if (reading.placeholder < FLOOR)
            failures.push(
              `${reading.look}: ${reading.placeholder.toFixed(2)}:1 (${reading.drawn} on ${reading.field})`,
            );
        }
      }
    } finally {
      await close();
    }
    expect(
      failures,
      `placeholders under ${FLOOR}:1 (${failures.length}):\n${failures.slice(0, 12).join('\n')}`,
    ).toEqual([]);
  });

  if (shotsDir !== '')
    for (const [name, width, height, scheme, phone] of [
      ['390-light', 390, 844, 'light', true],
      ['390-dark', 390, 844, 'dark', true],
      ['1440-light', 1440, 900, 'light', false],
      ['1440-dark', 1440, 900, 'dark', false],
    ] as const)
      it(`keeps the shot ${name}`, async () => {
        const { tab, close } = await open(width, height, scheme, `studio-${scheme}`, phone);
        try {
          await tab.waitForTimeout(500);
          await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
        } finally {
          await close();
        }
      });
});
