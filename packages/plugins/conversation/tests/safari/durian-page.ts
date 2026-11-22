/**
 * ONE DURIAN PAGE IN REAL SAFARI (r12 H8): the chat's `Transcript` over one assistant message of five Durian parts (a terminal, a
 * file tree, tabs, a tier list, an accordion), served with the app's real `Content-Security-Policy`, driven by `safaridriver`
 * on a Mac. The gate: the parts are drawn and the page reports 0 policy violations, 0 errors, 0 failed loads and 0
 * `console.error`/`console.warn` calls.
 *
 * WHY A PROGRAM AND NOT A TEST. A `bun test` file runs in the Linux tiers, where there is no Safari: it would skip, and a
 * skip that exits 0 reads as a pass. This exits 2 anywhere but macOS ("did not run" is a different fact from "passed"),
 * and the macOS job (`.github/actions/safari-durian`) is the only caller. `--self-check` runs the SAME page, server and verdict in
 * Chromium, on any OS, to prove the harness itself; it is not Safari evidence.
 *
 * WHAT SAFARI CANNOT DO, and so what the page does itself: `safaridriver` has no console, no request log and no init
 * script, so `collect.js` (a classic script, same origin) records what went wrong and the driver reads the record. Trusted
 * Types is Chromium's and recent Safari's: where Safari has none, the policy's directive is ignored and nothing is claimed
 * about it. A narrow window is not a phone: no mobile claim is made.
 *
 * Usage: `bun durian-page.ts [--self-check]`. Exit 0 = pass, 1 = the page is wrong, 2 = this gate could not run.
 */
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fyRenderIntegrationFixture } from '../integration/app/support/fy-render-integration-fixture.ts';
import { type PageReport, REQUIRED_PARTS, verdict } from './verdict.ts';
import { startSafariDriver, type WebDriver } from './webdriver.ts';

const here = import.meta.dir;
const selfCheck = Bun.argv.includes('--self-check');
const durianRoot = dirname(createRequire(join(here, '../../package.json')).resolve('durian-hypermedia/package.json'));

/** Five of Durian's own fixtures, one after the other, without front matter (a chat message has none). */
const FIXTURE_NUMBERS = ['39', '35', '06', '31', '07'] as const;
const message = async (): Promise<string> => {
  const bodies = await Promise.all(
    FIXTURE_NUMBERS.map(async number => {
      const name = (
        await Array.fromAsync(new Bun.Glob(`${number}-*.dh.md`).scan({ cwd: join(durianRoot, 'fixtures/format') }))
      )[0];
      if (name === undefined) throw new Error(`no Durian fixture numbered ${number}`);
      return (await readFile(join(durianRoot, 'fixtures/format', name), 'utf8'))
        .replace(/^---\n[\s\S]*?\n---\n/u, '')
        .trim();
    }),
  );
  return bodies.join('\n\n');
};

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Builds the scene and serves it under the app's real policy. */
const serve = async (): Promise<{ origin: string; stop: () => Promise<void> }> => {
  const headers = await readFile(resolve(here, '../../../../app/public/_headers'), 'utf8');
  const policy =
    headers
      .split('\n')
      .find(line => line.trim().startsWith('Content-Security-Policy:'))
      ?.trim()
      .slice('Content-Security-Policy:'.length)
      .trim() ?? '';
  if (!policy.includes("script-src 'self'")) throw new Error('the real policy was not found in _headers');
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-safari-durian-'));
  const build = Bun.spawn(
    [
      process.execPath,
      resolve(here, '../integration/app/fixtures/hypermedia-split-build.ts'),
      '--out',
      directory,
      '--entry',
      resolve(here, '../integration/app/fixtures/hypermedia-parts-scene.tsx'),
      '--first',
      resolve(here, '../../../../app/src/security/zod-jitless.ts'),
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  const [stderr, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}`);
  const fixture = await fyRenderIntegrationFixture();
  const { buildCss } = (await import(join(durianRoot, 'scripts/build-css.ts'))) as { buildCss: () => string };
  const css = `${fixture.appCss}\n${buildCss()}\n${SCENE_CSS}`;
  const collect = await readFile(join(here, 'collect.js'), 'utf8');
  const secured = (body: string | Blob, type: string): Response =>
    new Response(body, { headers: { 'content-security-policy': policy, 'content-type': type } });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/')
        return secured(
          '<!doctype html><html lang="en" data-theme="studio-light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><script src="/collect.js"></script></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/first.js"></script><script type="module" src="/scene.js"></script></body></html>',
          'text/html; charset=utf-8',
        );
      if (path === '/app.css') return secured(css, TYPES['.css'] ?? '');
      if (path === '/collect.js') return secured(collect, TYPES['.js'] ?? '');
      const name = path.slice(1);
      if (/^[\w.-]+$/u.test(name)) {
        const file = Bun.file(join(directory, name));
        if (await file.exists())
          return secured(file, TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream');
      }
      return new Response('not here', { status: 404 });
    },
  });
  return {
    origin: server.url.origin,
    stop: async () => {
      await server.stop(true);
      await rm(directory, { force: true, recursive: true });
    },
  };
};

/** What the page is asked, as one expression a browser evaluates (no function literal: Safari's `execute` takes a body). */
const READ = `(() => {
  const doc = document.querySelector('.dh-doc');
  const parts = {};
  for (const selector of ${JSON.stringify(REQUIRED_PARTS)}) parts[selector] = document.querySelectorAll('.dh-doc ' + selector).length;
  const seen = window.__h8 || { csp: ['collect.js did not run'], errors: [], console: [] };
  return JSON.stringify({ csp: seen.csp, errors: seen.errors, console: seen.console, docs: document.querySelectorAll('.dh-doc').length, parts, ready: window.fyPartsReady === true && doc !== null });
})()`;

interface Driver {
  readonly name: string;
  open(url: string): Promise<void>;
  read(expression: string): Promise<string>;
  close(): Promise<void>;
}

const safari = async (): Promise<Driver> => {
  const driver: WebDriver = await startSafariDriver();
  return {
    name: `Safari via ${driver.version}`,
    open: url => driver.navigate(url),
    read: expression => driver.execute<string>(`return ${expression};`),
    close: () => driver.stop(),
  };
};

const chromium = async (): Promise<Driver> => {
  // Playwright is the app shell's (Conversation declares no browser driver), and its shared launcher registers a `bun test`
  // hook, so this program loads the library from the shell's install and launches the system Chrome itself.
  const shell = fileURLToPath(import.meta.resolve('@ferretry/app/testing'));
  const { chromium: engine } = (await import(
    createRequire(shell).resolve('playwright-core')
  )) as typeof import('playwright-core');
  const executablePath = Bun.which('google-chrome') ?? Bun.which('chromium') ?? undefined;
  const browser = await engine.launch({ ...(executablePath === undefined ? {} : { executablePath }), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1_280, height: 900 } })).newPage();
  return {
    name: 'Chromium (--self-check: the harness, not Safari)',
    open: async url => {
      await page.goto(url);
    },
    read: async expression => (await page.evaluate(expression)) as string,
    close: async () => {
      await browser.close();
    },
  };
};

const main = async (): Promise<number> => {
  if (!selfCheck && process.platform !== 'darwin') {
    console.error(
      '❌ this gate needs Safari, which only exists on macOS. `--self-check` runs the harness in Chromium instead.',
    );
    return 2;
  }
  const site = await serve();
  let driver: Driver | undefined;
  try {
    driver = await (selfCheck ? chromium() : safari());
    const text = await message();
    await driver.open(`${site.origin}/?theme=studio-light&text=${encodeURIComponent(text)}`);
    let report: (PageReport & { ready: boolean }) | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      report = JSON.parse(await driver.read(READ)) as PageReport & { ready: boolean };
      if (report.ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (report === undefined || !report.ready) {
      console.error(`❌ the page was not ready in 30 s on ${driver.name}: ${JSON.stringify(report)}`);
      return 1;
    }
    // Lazy chunks and a late error get a moment, then the report is read once more: it is the one the verdict judges.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    report = JSON.parse(await driver.read(READ)) as PageReport & { ready: boolean };
    const wrong = verdict(report);
    console.log(
      JSON.stringify({
        driver: driver.name,
        parts: report.parts,
        csp: report.csp.length,
        errors: report.errors.length,
        console: report.console.length,
      }),
    );
    if (wrong.length > 0) {
      console.error(`❌ the Durian page is wrong on ${driver.name}:\n${wrong.map(line => `  - ${line}`).join('\n')}`);
      return 1;
    }
    console.log(
      `✅ the Durian page holds on ${driver.name}: ${REQUIRED_PARTS.length} parts drawn, 0 violations, 0 errors, 0 console errors`,
    );
    if (selfCheck) {
      // A gate that cannot fail is not one: make the page log an error and expect the verdict to name it.
      await driver.read("(console.error('h8 probe'), 'logged')");
      const caught = verdict(JSON.parse(await driver.read(READ)) as PageReport).join('\n');
      if (!caught.includes('console: error h8 probe')) {
        console.error('❌ self-check: a console.error on the page was not reported, so the gate could not fail');
        return 1;
      }
      console.log('✅ self-check: a console.error on the page is reported by the verdict');
    }
    return 0;
  } finally {
    await driver?.close();
    await site.stop();
  }
};

process.exit(
  await main().catch(error => {
    console.error(`❌ ${error instanceof Error ? error.stack : String(error)}`);
    return 2;
  }),
);
