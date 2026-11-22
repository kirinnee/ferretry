/**
 * "GO TO FILE" ON A REVISIT, in a real browser: in one app session choose src/entry.ts, go back to Projects, choose
 * src/entry-ts, go back, choose src/entry.ts AGAIN — the Files panel must show src/entry.ts each time (the address was
 * handled once before, but this is a fresh navigation). The REAL router and the REAL Files panel over a fake daemon.
 * Set `FY_FILE_REVISIT_SHOTS_DIR` to keep `<viewport>-<scheme>-revisit.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_FILE_REVISIT_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-file-revisit-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/file-address-revisit-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the revisit scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      // An app: every address serves the page, as the hosted shell does.
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const CASES = [
  { name: '390', width: 390, height: 844, scheme: 'light', scale: 2 },
  { name: '390', width: 390, height: 844, scheme: 'dark', scale: 2 },
  { name: '1280', width: 1_280, height: 800, scheme: 'light', scale: 1 },
  { name: '1280', width: 1_280, height: 800, scheme: 'dark', scale: 1 },
] as const;

describe('Go to file on a revisit', () => {
  for (const { name, width, height, scheme, scale } of CASES)
    it(`entry.ts, back, entry-ts, back, entry.ts again opens entry.ts (${name}, ${scheme})`, async () => {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: scheme,
        deviceScaleFactor: scale,
      });
      try {
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        await tab.goto(`${origin}/d/fake/projects/p1?theme=studio-${scheme}`);
        const panelText = () => tab.evaluate(() => document.querySelector('main')?.innerText ?? '');
        const shows = async (needle: string): Promise<void> => {
          await tab.waitForFunction(
            text => (document.querySelector('main') as HTMLElement | null)?.innerText.includes(text) === true,
            needle,
            { timeout: 8_000 },
          );
        };
        const choose = async (path: string, marker: string): Promise<void> => {
          await tab.getByRole('button', { name: `Go to ${path}` }).click();
          await shows(marker);
          const url = new URL(tab.url());
          expect(`${url.pathname}${url.search}`).toBe(`/d/fake/ferrets/zed?file=${encodeURIComponent(path)}`);
        };
        const backToProjects = async (): Promise<void> => {
          await tab.getByRole('button', { name: '← Projects' }).click();
          await shows('Projects · ferretry');
        };

        await choose('src/entry.ts', 'the file src/entry.ts');
        await backToProjects();
        await choose('src/entry-ts', 'the file src/entry-ts');
        await backToProjects();
        await choose('src/entry.ts', 'the file src/entry.ts');
        const text = await panelText();
        console.info(`[u7-fix2] ${name} ${scheme}: step 3 shows entry.ts=${String(text.includes('src/entry.ts'))}`);
        expect(text, 'step 3 shows entry.ts, not the earlier entry-ts').toContain('the file src/entry.ts');
        expect(text).not.toContain('the file src/entry-ts');
        // The last file the panel read is the one the address names.
        const reads = await tab.evaluate(() => (window as unknown as { __fileReads: string[] }).__fileReads);
        expect(reads.at(-1), 'the panel read src/entry.ts last').toBe('src/entry.ts');
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-revisit.png`) });
      } finally {
        await context.close();
      }
    });
});
