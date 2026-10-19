/**
 * Screenshots of the ⚡ fast-mode switch: on the composer's chip row (off, on, switching, unconfirmed
 * and disabled-with-a-reason, for a Claude and a Codex session) and on the New session form (off, on,
 * disabled for a model with no fast mode, with its reason line). Phone 390 and desktop 1440, light and
 * dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/fast-mode-screenshot.tsx [out-dir]   # writes fast-mode-{composer,form}-*.png (default harness/out)
 *
 * The composer rows are the REAL `ComposerRuntimeWithKeyboard` with the REAL `FastToggle`, driven by
 * pressing it. The form rows draw the real `FastSwitch` in the form's own markup (the page itself needs
 * a whole daemon behind it). Like `screenshot.ts` it drives the system Chrome through playwright-core,
 * aborts every request off the loopback origin, and asserts every width fits without sideways scroll.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { SessionView } from '@ferretry/protocol';
import { FastToggle } from '../../src/components/composer-fast.tsx';
import { ComposerRuntimeWithKeyboard } from '../../src/components/composer-runtime.tsx';
import { FastSwitch } from '../../src/components/fast-switch.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { FAST_COST_NOTE } from '../../src/lib/fast-mode.ts';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.example.test', deviceId: 'token' });
const AT = '2026-10-18T00:00:00.000Z';

type Harness = 'claude' | 'codex';
type Row = 'off' | 'on' | 'switching' | 'unconfirmed' | 'disabled';

const MODELS: Record<Harness, { ok: string; none: string }> = {
  claude: { ok: 'claude-opus-5-5', none: 'claude-sonnet-5-5' },
  codex: { ok: 'gpt-6-astra', none: 'gpt-daybreak-blue' },
};

const catalog = (harness: Harness) => ({
  harness,
  source: harness === 'claude' ? ('wrapper-inventory' as const) : ('codex-app-server' as const),
  choices: [
    { value: MODELS[harness].ok, label: harness === 'claude' ? 'Opus 5.5' : 'GPT-6-Astra', reasoningEfforts: [], fast: true },
    { value: MODELS[harness].none, label: harness === 'claude' ? 'Sonnet 5.5' : 'Daybreak Blue', reasoningEfforts: [], fast: false },
  ],
});

const view = (harness: Harness, row: Row): SessionView =>
  ({
    config: {
      id: 'harness-session-' + harness + '-' + row,
      name: 'Hadi',
      agent: harness + '-auto',
      harness,
      cwd: '/work/ferretry',
      model: row === 'disabled' ? MODELS[harness].none : MODELS[harness].ok,
      modelHint: MODELS[harness].ok,
      harnessFlags: [],
      launchReasoningEffort: 'high',
      createdAt: AT,
      updatedAt: AT,
    },
    state: {
      status: 'running',
      promptReady: true,
      turnState: 'your-turn',
      observedModel: row === 'disabled' ? MODELS[harness].none : MODELS[harness].ok,
      observedModelAt: AT,
      ...(row === 'on' || row === 'unconfirmed' ? { observedFast: true } : { observedFast: false }),
    },
  }) as unknown as SessionView;

function Bar({ harness, row }: { readonly harness: Harness; readonly row: Row }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (row !== 'switching' && row !== 'unconfirmed') return;
    const timer = setTimeout(() => box.current?.querySelector<HTMLButtonElement>('[data-fast-switch]')?.click(), 60);
    return () => clearTimeout(timer);
  }, [row]);
  const current = view(harness, row);
  return (
    <div className="flex min-w-0 items-center" ref={box}>
      <ComposerRuntimeWithKeyboard
        busy={false}
        canControl
        keyboardOpen={false}
        presentation="popover"
        renderFast={() => (
          <FastToggle
            api={{ runtime: async () => undefined }}
            busy={false}
            canControl
            catalogs={{ load: async () => catalog(harness) }}
            daemon={daemon}
            switchConfirmMs={row === 'unconfirmed' ? 400 : 3_600_000}
            view={current}
          />
        )}
        view={current}
      />
    </div>
  );
}

const CAPTION: Record<Row, string> = {
  off: 'Off',
  on: 'On',
  switching: 'Switching — waiting for the harness to confirm',
  unconfirmed: 'Unconfirmed — no report within the bound',
  disabled: 'Disabled — this model has no fast mode',
};
const ROWS: readonly Row[] = ['off', 'on', 'switching', 'unconfirmed', 'disabled'];

function Form({ pressed, reason }: { readonly pressed: boolean; readonly reason?: string }) {
  return (
    <div data-new-session-fast="">
      <FastSwitch
        ariaLabel="Fast mode"
        disabled={reason !== undefined}
        {...(reason === undefined ? {} : { disabledReason: reason })}
        onPress={() => undefined}
        pressed={pressed}
        variant="field"
      />
      <p className="m-0 mt-1.5 text-meta leading-base text-muted">Faster output on models that offer it. {FAST_COST_NOTE}</p>
      {reason === undefined ? null : <p className="m-0 mt-1 text-meta leading-base text-warn">{reason}</p>}
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col gap-panel bg-bg p-panel">
    <div className="flex w-full max-w-xl flex-col gap-panel" data-shot="composer">
      {(['claude', 'codex'] as const).map(harness =>
        ROWS.map(row => (
          <section
            aria-label={harness + ' ' + CAPTION[row]}
            className="kt-panel flex flex-col gap-1 p-panel"
            data-row={harness + '-' + row}
            key={harness + row}
          >
            <p className="kt-label m-0">{harness} · {CAPTION[row]}</p>
            <div className="flex min-w-0 items-center border-t border-border-soft pt-1">
              <Bar harness={harness} row={row} />
            </div>
          </section>
        )),
      )}
    </div>
    <div className="flex w-full max-w-xl flex-col gap-panel" data-shot="form">
      <section className="kt-panel flex flex-col gap-1 p-panel" data-row="form-off">
        <p className="kt-label m-0">New session · off</p>
        <Form pressed={false} />
      </section>
      <section className="kt-panel flex flex-col gap-1 p-panel" data-row="form-on">
        <p className="kt-label m-0">New session · on</p>
        <Form pressed />
      </section>
      <section className="kt-panel flex flex-col gap-1 p-panel" data-row="form-disabled">
        <p className="kt-label m-0">New session · model with no fast mode</p>
        <Form pressed={false} reason="Sonnet 5.5 has no fast mode." />
      </section>
    </div>
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/fast-mode-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'fast-mode-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'fast-mode-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1_440, height: 900, touch: false },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        for (const harness of ['claude', 'codex']) {
          await page
            .locator(`[data-row="${harness}-switching"] [data-switch-state="switching"]`)
            .waitFor({ state: 'visible' });
          await page
            .locator(`[data-row="${harness}-unconfirmed"] [data-switch-state="unconfirmed"]`)
            .waitFor({ state: 'visible', timeout: 8_000 });
          await page
            .locator(`[data-row="${harness}-disabled"] [data-fast-switch][disabled]`)
            .waitFor({ state: 'visible' });
        }
        await page.locator('[data-row="form-disabled"] [data-fast-switch][disabled]').waitFor({ state: 'visible' });
        // The fast chip stays fully inside its row at every width, whatever the model chip does.
        const clipped = await page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLElement>('[data-fast-switch]')].filter(node => {
              const box = node.getBoundingClientRect();
              const row = node.closest('section')?.getBoundingClientRect();
              return (
                row === undefined ||
                box.right > row.right ||
                box.left < row.left ||
                node.scrollWidth > node.clientWidth + 1
              );
            }).length,
        );
        const where = `${viewport.name}/${scheme}`;
        await page.setViewportSize({
          width: viewport.width,
          height: (await page.evaluate(() => document.documentElement.scrollHeight)) + 800,
        });
        await page.evaluate(() => window.scrollTo(0, 0));
        if (clipped > 0) fail(`${where}: ${clipped} fast switch(es) clip or overflow their row`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
        for (const shot of ['composer', 'form'] as const) {
          const target = join(outDir, `fast-mode-${shot}-${viewport.name}-${scheme}.png`);
          // The viewport is grown to the whole page first, so a clip is in viewport coordinates: a tall
          // block cannot be element-shot or full-page-clipped reliably under phone emulation.
          const box = await page.evaluate(selector => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();
            return rect === undefined
              ? undefined
              : { x: 0, y: rect.top + window.scrollY - 8, width: window.innerWidth, height: rect.height + 16 };
          }, `[data-shot="${shot}"]`);
          const block = box ?? fail(`${where}: no ${shot} block`);
          await page.screenshot({ path: target, clip: { ...block, y: Math.max(block.y, 0) } });
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
